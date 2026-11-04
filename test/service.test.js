import test from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ReaderService, REMOTE_METHODS } from '../index.js'
import { createJob, transitionJob } from '../lib/jobs.js'
import { memoryDb, serviceFixture, source } from './helpers.js'

function engineFixture() {
  const chapter = { id: '', bookId: '', index: 0, title: '第一章', url: 'https://example.com/c1' }
  return {
    async bookInfo(_source, bookUrl) { return { name: '远程书', author: '作者', bookUrl, intro: '简介' } },
    async toc(_source, book) { return [{ ...chapter, id: 'c1', bookId: book.id }] },
    async content() { return { text: '原始正文 广告', html: '<p>原始正文 广告</p>' } },
  }
}

test('all contracted methods are discovered by the Stage-3 Remote markers', async () => {
  const { service } = await serviceFixture()
  const discovered = remoteMethods(service).map(marker => marker.exportName ?? marker.method)
  assert.deepEqual(discovered, [...REMOTE_METHODS])
  assert.equal(new Set(discovered).size, 19)
})

test('real gateway SRC descriptor accepts every Remote signature', async () => {
  const { service } = await serviceFixture()
  const gateway = Object.create(TypertGatewayService.prototype)
  gateway.ctx = { typert: { lookups: { definitions: () => [] } } }
  for (const marker of remoteMethods(service)) {
    const method = marker.exportName ?? marker.method
    const descriptor = gateway.srcDescriptor(
      { service, serviceKey: 'reader', namespace: 'reader' },
      marker,
      method,
      `reader/${method}`,
    )
    const parameters = descriptor.parameters.map(parameter => parameter.name)
    if (['state', 'checkUpdates', 'exportBackup'].includes(method)) assert.deepEqual(parameters, [])
    else assert.deepEqual(parameters, ['args'], `${method} must take one args identifier`)
  }
})

test('host core loop: source, shelf, toc, sanitized chapter, progress, notes and backup', async () => {
  const { service, db } = await serviceFixture(engineFixture())
  await db.sources.put(source.id, source)
  const book = await service.addBook({ sourceId: source.id, bookUrl: 'https://example.com/book' })
  assert.equal(book.name, '远程书')
  assert.equal(book.unread, 0)
  const toc = await service.toc({ bookId: book.id })
  assert.equal(toc.length, 1)
  await service.setSettings({ replacements: [{ type: 'text', pattern: '广告', replacement: '' }] })
  const chapter = await service.chapter({ bookId: book.id, chapterId: 'c1' })
  assert.equal(chapter.text, '原始正文')
  assert.equal(db.chapters.get('c1').text, '原始正文 广告')
  const progress = await service.saveProgress({ bookId: book.id, chapterId: 'c1', offset: 3, percent: 40 })
  assert.equal(progress.offset, 3)
  assert.equal((await service.state()).books[0].lastRead.percent, 40)
  const note = await service.saveNote({ bookId: book.id, chapterId: 'c1', text: '笔记', quote: '正文' })
  await service.saveNote({ id: note.id, bookId: book.id, chapterId: 'c1', text: '更新笔记' })
  assert.equal((await service.state()).notes[0].text, '更新笔记')
  const backup = await service.exportBackup()
  const restored = await service.importBackup({ data: backup })
  assert.equal(restored.books[0].progress.offset, 3)
  assert.equal(restored.notes.length, 1)
  await service.deleteNote({ id: note.id })
  assert.equal((await service.state()).notes.length, 0)
  await service.removeBook({ bookId: book.id })
  assert.equal((await service.state()).books.length, 0)
})

test('download persists queued state before execution, caches content and completes', async () => {
  const { service, db } = await serviceFixture(engineFixture())
  await db.sources.put(source.id, source)
  const book = await service.addBook({ sourceId: source.id, bookUrl: 'https://example.com/book' })
  const statuses = []
  const put = db.jobs.put
  db.jobs.put = async (key, value) => { statuses.push(value.status); return put(key, value) }
  const job = await service.download({ bookId: book.id })
  assert.equal(job.status, 'queued')
  assert.equal(statuses[0], 'queued')
  await service.runningJobs.get(job.id)
  assert.equal(db.jobs.get(job.id).status, 'completed')
  assert.equal(db.chapters.get('c1').text, '原始正文 广告')
  assert.equal((await service.state()).books[0].download.status, 'completed')
  const cancelled = await service.cancelJob({ jobId: job.id }).catch(error => error)
  assert.equal(cancelled.code, 'reader/job-state')
})

test('local TXT/EPUB API and settings validation need no network', async () => {
  const { service } = await serviceFixture()
  const book = await service.importLocal({ name: '本地', format: 'txt', text: '第一章 开始\n内容' })
  const [chapter] = await service.toc({ bookId: book.id })
  assert.equal((await service.chapter({ bookId: book.id, chapterId: chapter.id })).text, '内容')
  const job = await service.download({ bookId: book.id })
  await service.runningJobs.get(job.id)
  assert.equal(job.status, 'queued')
  const typography = { fontSize: 22, lineHeight: 2, fontFamily: 'serif', readerTheme: 'dark', ttsRate: 1.25 }
  assert.deepEqual(await service.setSettings(typography), { ...service.db.settings.get(), ...typography })
  const backup = await service.exportBackup()
  assert.equal(JSON.parse(backup).settings.readerTheme, 'dark')
  await service.importBackup({ data: backup })
  assert.equal(service.db.settings.get().fontSize, 22)
  await assert.rejects(() => service.setSettings({ fontSize: 8 }), /fontSize/)
  await assert.rejects(() => service.setSettings({ ttsRate: 9 }), /ttsRate/)
  await assert.rejects(() => service.setSettings({ cookie: 'x' }), /仅支持/)
  await assert.rejects(() => service.importSource({ text: '{bad json' }), /有效 JSON/)
})

test('Service.init opens storage, recovers persisted jobs and registers hourly updates', async () => {
  const ctx = new Context()
  const db = memoryDb()
  let closed = false
  const domain = {
    table: name => db[name],
    global: db.settings,
    close: async () => { closed = true },
  }
  ctx.provide('storageDomain', { open: async () => domain })
  const service = new ReaderService(ctx, { engine: engineFixture() })
  await db.books.put('local-book', { id: 'local-book', sourceId: 'local', bookUrl: 'local:local-book', name: 'Local', local: true })
  const running = transitionJob(createJob({ bookId: 'local-book', total: 0 }), 'start')
  await db.jobs.put(running.id, running)
  let intervalMs
  let stopIntervalCalled = false
  ctx.interval = (_callback, ms) => {
    intervalMs = ms
    return () => { stopIntervalCalled = true }
  }
  let dispose
  const effect = ctx.effect.bind(ctx)
  ctx.effect = (body, label) => {
    dispose = effect(body, label)
    return dispose
  }
  await service[Service.init]()
  await Promise.allSettled([...service.runningJobs.values()])
  assert.equal(db.jobs.get(running.id).status, 'completed')
  assert.ok(db.jobs.get(running.id).recoveredAt)
  assert.equal(intervalMs, 3_600_000)
  assert.equal(service.db.sources, db.sources)
  await dispose()
  assert.equal(closed, true)
  assert.equal(service.disposed, true)
  assert.equal(stopIntervalCalled, false, 'ctx.interval owns its own disposer')
})

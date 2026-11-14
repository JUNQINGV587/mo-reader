import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { ReaderService, REMOTE_METHODS } from '../index.js'
import { createJob, transitionJob } from '../lib/jobs.js'
import { stableId } from '../lib/utils.js'
import { SourceEngine } from '../lib/source-engine.js'
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
  assert.equal(new Set(discovered).size, REMOTE_METHODS.length)
})

test('pauseJob and resumeJob move a download between paused and queued', async () => {
  const { service, db } = await serviceFixture()
  const book = { id: 'book-1', bookId: 'book-1', name: '书', sourceId: source.id, sourceType: 'remote', download: { status: 'running', jobId: 'job-1' } }
  await db.books.put(book.id, book)
  await db.jobs.put('job-1', { id: 'job-1', type: 'download', bookId: book.id, status: 'running', total: 10, done: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  service.scheduleJob = () => Promise.resolve()
  const paused = await service.pauseJob({ bookId: book.id })
  assert.equal(paused.status, 'paused')
  assert.equal(db.books.get(book.id).download.status, 'paused')
  const resumed = await service.resumeJob({ bookId: book.id })
  assert.equal(resumed.status, 'queued')
  assert.equal(db.books.get(book.id).download.status, 'queued')
})

test('download jobs can be paused and resumed', () => {
  const job = createJob({ bookId: 'b1', total: 10 })
  const running = transitionJob(job, 'start')
  const paused = transitionJob(running, 'pause')
  assert.equal(paused.status, 'paused')
  const resumed = transitionJob(paused, 'resume')
  assert.equal(resumed.status, 'queued')
  assert.throws(() => transitionJob(job, 'resume'))
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

test('service full chain runs an XPath source through search, toc, content and download', async () => {
  const engine = new SourceEngine({
    fetch: async (url) => {
      if (url.includes('/search')) return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<div class="book"><span class="name">XPath 书</span><span class="author">作者</span><a href="/book/x">详情</a></div>',
      }
      if (url.includes('/chapter/')) return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<div id="content"><p>第一段</p><p>第二段</p></div>',
      }
      return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<h1>XPath 书</h1><span class="author">作者</span><ul><li class="chapter"><a href="/chapter/x1">第一章</a></li></ul>',
      }
    },
  })
  const { service, db } = await serviceFixture(engine)
  const xpathSource = await service.importSource({
    text: JSON.stringify({
      bookSourceName: 'XPath 样本',
      bookSourceUrl: 'https://example.com',
      rules: {
        search: {
          url: '/search?q={{key}}', bookList: '//div[@class="book"]', name: '//span[@class="name"]/text()',
          author: '//span[@class="author"]/text()', bookUrl: '//a/@href',
        },
        bookInfo: { name: '//h1/text()', author: '//span[@class="author"]/text()' },
        toc: { chapterList: '//li[@class="chapter"]', chapterName: '//a/text()', chapterUrl: '//a/@href' },
        content: { content: '@xpath://div[@id="content"]/p/text()' },
      },
    }),
  })
  const found = await service.search({ sourceId: xpathSource.id, query: 'XPath' })
  assert.equal(found.items[0].name, 'XPath 书')
  const book = await service.addBook({ sourceId: xpathSource.id, bookUrl: found.items[0].bookUrl })
  assert.equal(book.name, 'XPath 书')
  const toc = await service.toc({ bookId: book.id })
  assert.equal(toc[0].title, '第一章')
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.text, '第一段\n第二段')
  const job = await service.download({ bookId: book.id })
  await service.runningJobs.get(job.id)
  assert.equal(db.chapters.get(toc[0].id).text, '第一段\n第二段')
  assert.equal((await service.state()).books[0].download.status, 'completed')
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
  const motion = { animations: false, motionQuality: 'low', ambience: 'paper', reducedMotion: 'on' }
  assert.deepEqual(await service.setSettings(motion), { ...service.db.settings.get(), ...motion })
  assert.equal(service.db.settings.get().ambience, 'paper')
  await assert.rejects(() => service.setSettings({ ambience: 'dim' }), /ambience/)
  await assert.rejects(() => service.setSettings({ motionQuality: 'ultra' }), /motionQuality/)
  await assert.rejects(() => service.setSettings({ fontSize: 8 }), /fontSize/)
  await assert.rejects(() => service.setSettings({ ttsRate: 9 }), /ttsRate/)
  await assert.rejects(() => service.setSettings({ cookie: 'x' }), /仅支持/)
  await assert.rejects(() => service.importSource({ text: '{bad json' }), /有效 JSON/)
})

test('Service.init opens storage, recovers persisted jobs and registers hourly updates', async (t) => {
  const mediaRoot = await mkdtemp(join(tmpdir(), 'reader-media-'))
  t.after(() => rm(mediaRoot, { recursive: true, force: true }))
  const ctx = new Context()
  const db = memoryDb()
  let closed = false
  const domain = {
    table: name => db[name],
    global: db.settings,
    close: async () => { closed = true },
  }
  ctx.provide('storageDomain', { open: async () => domain })
  const routes = []
  const disposedRoutes = []
  ctx.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => disposedRoutes.push(route.path)
    },
  })
  let rejection
  ctx.provide('connection', { requestRejection: () => rejection })
  let subscriptionFetches = 0
  const service = new ReaderService(ctx, {
    engine: engineFixture(),
    mediaRoot,
    fetchRemote: async () => {
      subscriptionFetches += 1
      return { text: JSON.stringify([{ bookSourceName: '订阅源', bookSourceUrl: 'https://sub.example' }]) }
    },
  })
  await db.books.put('local-book', { id: 'local-book', sourceId: 'local', bookUrl: 'local:local-book', name: 'Local', local: true })
  const subscriptionUrl = 'https://library.example/sources.json'
  const subscriptionSourceId = stableId('source', 'https://sub.example')
  await db.sources.put(subscriptionSourceId, { id: subscriptionSourceId, name: '旧订阅源', bookSourceUrl: 'https://sub.example', enabled: true, rules: {} })
  await db.subscriptions.put(stableId('subscription', subscriptionUrl), {
    id: stableId('subscription', subscriptionUrl),
    url: subscriptionUrl,
    allowHttp: false,
    sourceIds: [subscriptionSourceId],
    status: 'ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const running = transitionJob(createJob({ bookId: 'local-book', total: 0 }), 'start')
  await db.jobs.put(running.id, running)
  let intervalMs
  let intervalCallback
  let stopIntervalCalled = false
  ctx.interval = (callback, ms) => {
    intervalMs = ms
    intervalCallback = callback
    return () => { stopIntervalCalled = true }
  }
  let dispose
  const effect = ctx.effect.bind(ctx)
  ctx.effect = (body, label) => {
    const disposer = effect(body, label)
    if (label === 'reader: close storage and jobs') dispose = disposer
    return disposer
  }
  await service[Service.init]()
  await service.startupMaintenance
  assert.deepEqual(routes.map(route => route.path), ['/api/reader/media', '/api/reader/proxy', '/api/reader/hls.js'])
  rejection = 401
  const denied = { statusCode: 0, headers: {}, setHeader(key, value) { this.headers[key] = value }, end() { this.ended = true } }
  await routes[0].handler({ method: 'GET', url: '/api/reader/media?id=missing', headers: {} }, denied)
  assert.equal(denied.statusCode, 401)
  assert.equal(denied.ended, true)
  await Promise.allSettled([...service.runningJobs.values()])
  assert.equal(db.jobs.get(running.id).status, 'completed')
  assert.ok(db.jobs.get(running.id).recoveredAt)
  assert.equal(intervalMs, 3_600_000)
  assert.equal(subscriptionFetches, 1, '启动时应补查订阅')
  assert.equal(db.sources.get(subscriptionSourceId).name, '订阅源')
  assert.equal(service.db.sources, db.sources)
  await intervalCallback()
  assert.equal(subscriptionFetches, 2, '每小时应再次检查订阅')
  await dispose()
  assert.equal(closed, true)
  assert.equal(service.disposed, true)
  assert.equal(stopIntervalCalled, false, 'ctx.interval owns its own disposer')
})

test('builtin sources are seeded once and can be turned off without re-adding', async () => {
  const { service, db } = await serviceFixture()
  await service.seedBuiltinSources()
  const seeded = [...db.sources.entries()].map(([, value]) => value)
  assert.deepEqual(seeded.map(item => item.name).sort(), ['MangaDex 漫画', '品书斋', '维基文库'])
  assert.equal(seeded.every(item => item.builtin === true), true)
  // Second call is a no-op even after the user deletes one.
  await db.sources.delete(seeded[0].id)
  await service.seedBuiltinSources()
  assert.equal(db.sources.size, 2)
})

test('builtin migration adds new sources and retires 17K without reviving deleted sources', async () => {
  const { service, db } = await serviceFixture()
  await db.settings.set({ ...db.settings.get(), builtinSourcesAt: '2026-01-01T00:00:00.000Z' })
  await db.sources.put('legacy-17k', {
    id: 'legacy-17k', name: '17K 小说', bookSourceUrl: 'https://www.17k.com', builtin: true,
    enabled: true, contentType: 'novel', rules: {},
  })
  await service.seedBuiltinSources()
  assert.deepEqual([...db.sources.entries()].map(([, item]) => item.name).sort(), ['MangaDex 漫画', '品书斋'])
  assert.equal(db.settings.get().builtinSourcesVersion, 2)
})

test('builtin migration keeps a retired source when a book still uses it', async () => {
  const { service, db } = await serviceFixture()
  await db.settings.set({ ...db.settings.get(), builtinSourcesAt: '2026-01-01T00:00:00.000Z' })
  await db.sources.put('legacy-17k', {
    id: 'legacy-17k', name: '17K 小说', bookSourceUrl: 'https://www.17k.com', builtin: true,
    enabled: true, contentType: 'novel', rules: {},
  })
  await db.books.put('book-1', { id: 'book-1', name: '旧书', sourceId: 'legacy-17k' })
  await service.seedBuiltinSources()
  const legacy = db.sources.get('legacy-17k')
  assert.equal(legacy.enabled, false)
  assert.equal(legacy.retired, true)
  assert.equal([...db.sources.entries()].filter(([, item]) => item.name === '品书斋').length, 1)
})

test('addBook accepts search-result data when a source has no bookInfo rule', async () => {
  const { service } = await serviceFixture({ async bookInfo() { return {} } })
  const { source: builtin } = { source }
  await service.db.sources.put(builtin.id, builtin)
  const book = await service.addBook({ sourceId: builtin.id, bookUrl: 'https://example.com/book/1', book: { name: '公版书', author: '作者甲' } })
  assert.equal(book.name, '公版书')
  assert.equal(book.author, '作者甲')
})

test('built-in sources cannot be removed', async () => {
  const { service, db } = await serviceFixture()
  await service.seedBuiltinSources()
  const [builtin] = [...db.sources.entries()].map(([, value]) => value)
  await assert.rejects(() => service.removeSource({ id: builtin.id }), /内置书源不能删除/)
  assert.equal(db.sources.get(builtin.id)?.builtin, true)
})

test('source subscriptions persist source relationships and enabled state', async () => {
  const library = [
    { bookSourceName: '源甲', bookSourceUrl: 'https://a.example', rules: {} },
    { bookSourceName: '源乙', bookSourceUrl: 'https://b.example', rules: {} },
  ]
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library), url: 'https://lib.example/sources.json' }),
  })
  const first = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  assert.equal(first.imported, 2)
  assert.equal((await service.state()).subscriptions.length, 1)
  const firstSource = (await service.state()).sources.find(item => item.name === '源甲')
  await service.setSourceEnabled({ id: firstSource.id, enabled: false })
  assert.equal((await service.state()).sources.find(item => item.id === firstSource.id).enabled, false)

  await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  assert.equal(db.sources.get(firstSource.id).enabled, false, '重复订阅不得重新启用已停用源')
  assert.equal((await service.state()).subscriptions[0].sourceIds.length, 2)

  const backup = JSON.parse(await service.exportBackup())
  assert.equal(backup.subscriptions.length, 1)
  assert.equal(backup.sources.find(item => item.id === firstSource.id).enabled, false)
  const restored = await service.importBackup({ data: backup })
  assert.equal(restored.subscriptions[0].url, 'https://lib.example/sources.json')
  assert.equal(restored.sources.find(item => item.id === firstSource.id).enabled, false)

  const subscriptionId = restored.subscriptions[0].id
  assert.equal((await service.removeSubscription({ id: subscriptionId })).removed, true)
  assert.equal((await service.state()).subscriptions.length, 0)
  assert.equal(!!db.sources.get(firstSource.id), true, '取消订阅不应删除书源')
  await assert.rejects(() => service.removeSubscription({ id: subscriptionId }), error => error.code === 'reader/not-found')
})

test('partial source libraries keep the subscription without claiming full success', async () => {
  const library = [
    { bookSourceName: '可用源', bookSourceUrl: 'https://valid.example', rules: {} },
    { bookSourceName: '坏源', bookSourceUrl: 'not-a-url', rules: {} },
  ]
  const { service } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library), url: 'https://lib.example/partial.json' }),
  })
  const result = await service.subscribeSourceLibrary({ url: 'https://lib.example/partial.json' })
  assert.equal(result.imported, 1)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.subscription.status, 'partial')
  assert.equal(result.subscription.lastSuccessAt, undefined)
  assert.equal(result.subscription.lastCheckedAt !== undefined, true)
})

test('legacy sources without an enabled field migrate as enabled', async () => {
  const calls = []
  const engine = { async search() { calls.push('search'); return [] } }
  const { service, db } = await serviceFixture(engine)
  await db.sources.put('legacy', { id: 'legacy', name: '旧源', bookSourceUrl: 'https://legacy.example', rules: {} })
  const state = await service.state()
  assert.equal(state.sources.find(item => item.id === 'legacy').enabled, true)
  await service.search({ sourceId: 'legacy', query: '书' })
  assert.deepEqual(calls, ['search'])
})

test('disabled sources are rejected by every remote read path and skipped by updates', async () => {
  const calls = []
  const engine = {
    async search() { calls.push('search'); return [] },
    async discover() { calls.push('discover'); return [] },
    async bookInfo() { calls.push('bookInfo'); return { name: '远程书', author: '作者' } },
    async toc() { calls.push('toc'); return [] },
    async content() { calls.push('content'); return { text: '正文', html: '<p>正文</p>' } },
  }
  const { service, db } = await serviceFixture(engine)
  await db.sources.put(source.id, { ...source, enabled: false })
  const book = { id: 'disabled-book', sourceId: source.id, bookUrl: 'https://example.com/book', name: '书', local: false, download: { status: 'none' } }
  await db.books.put(book.id, book)
  await db.chapters.put('disabled-chapter', { id: 'disabled-chapter', bookId: book.id, index: 0, title: '章', url: 'https://example.com/c1' })
  const disabled = error => error?.code === 'reader/source-disabled'
  await assert.rejects(() => service.search({ sourceId: source.id, query: '书' }), disabled)
  await assert.rejects(() => service.discover({ sourceId: source.id }), disabled)
  await assert.rejects(() => service.addBook({ sourceId: source.id, bookUrl: 'https://example.com/book/2' }), disabled)
  await assert.rejects(() => service.toc({ bookId: book.id, refresh: true }), disabled)
  await assert.rejects(() => service.chapter({ bookId: book.id, chapterId: 'disabled-chapter' }), disabled)
  await assert.rejects(() => service.download({ bookId: book.id }), disabled)
  await assert.rejects(() => service.applyBookMeta({ bookId: book.id, meta: { sourceId: source.id, bookUrl: book.bookUrl } }), disabled)
  const updates = await service.checkUpdates()
  assert.deepEqual({ checked: updates.checked, skipped: updates.skipped }, { checked: 0, skipped: 1 })
  assert.equal(calls.length, 0, '停用源不得触发任何引擎请求')

  await service.setSourceEnabled({ id: source.id, enabled: true })
  await service.search({ sourceId: source.id, query: '书' })
  assert.deepEqual(calls, ['search'])
})

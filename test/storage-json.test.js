import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { ReaderService } from '../index.js'
import { openReaderStorage } from '../lib/storage.js'
import { chapterId } from '../lib/utils.js'

test('real storageDomain JSON backend accepts source/book/chapter IDs derived from HTTPS URLs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'reader-storage-'))
  const backend = new JsonStorageBackend(root)
  const ctx = new Context()
  ctx.provide('storage', { backend: { get: name => {
    assert.equal(name, 'json')
    return backend
  } } })
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  ctx.provide('storageDomain', facility)
  const engine = {
    async bookInfo(_source, bookUrl) { return { name: '持久化书', author: '作者', bookUrl } },
    async toc(_source, book) {
      const url = 'https://example.com/chapter/1'
      return [{ id: chapterId(book.id, url), bookId: book.id, index: 0, title: '第一章', url }]
    },
    async content() { return { text: '正文', html: '<p>正文</p>' } },
  }
  let library = [{ bookSourceName: '订阅源', bookSourceUrl: 'https://sub.example', rules: {} }]
  const service = new ReaderService(ctx, {
    engine,
    fetchRemote: async () => ({
      url: 'https://library.example/sources.json',
      text: JSON.stringify(library),
    }),
  })
  service.db = await openReaderStorage(ctx)
  t.after(async () => {
    await service.db.domain.close()
    await backend.close()
    await rm(root, { recursive: true, force: true })
  })

  const imported = await service.importSource({ text: JSON.stringify({
    bookSourceName: 'HTTPS 源',
    bookSourceUrl: 'https://example.com',
    bookSourceType: 4,
    ruleBookInfo: { name: 'h1' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    ruleContent: { content: '#content' },
  }) })
  assert.match(imported.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(imported.bookSourceUrl, 'https://example.com')
  assert.equal(imported.contentType, 'video')
  assert.equal(service.source(imported.id).bookSourceUrl, 'https://example.com')
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://library.example/sources.json' })
  assert.equal(subscribed.imported, 1)
  const subscriptionSourceId = subscribed.subscription.sourceIds[0]
  await service.setSourceEnabled({ id: subscriptionSourceId, enabled: false })

  const book = await service.addBook({ sourceId: imported.id, bookUrl: 'https://example.com/book/1' })
  assert.match(book.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(book.bookUrl, 'https://example.com/book/1')
  assert.equal(book.sourceId, imported.id)
  assert.equal(book.contentType, 'video')
  const toc = await service.toc({ bookId: book.id })
  assert.match(toc[0].id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(toc[0].url, 'https://example.com/chapter/1')
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.text, '正文')

  library = [
    { bookSourceName: '订阅源新版', bookSourceUrl: 'https://sub.example', rules: {} },
    { bookSourceName: '新增源', bookSourceUrl: 'https://sub.example/extra', rules: {} },
  ]
  const refreshed = await service.refreshSubscription({ id: subscribed.subscription.id })
  assert.deepEqual({ added: refreshed.added, updated: refreshed.updated }, { added: 1, updated: 1 })
  const newSourceId = refreshed.subscription.sourceIds.find(id => id !== subscriptionSourceId)
  assert.ok(newSourceId)

  for (const table of ['sources', 'subscriptions', 'books', 'chapters']) {
    for (const [key, record] of service.db[table].entries()) {
      assert.match(key, /^[a-zA-Z0-9_-]+$/)
      assert.equal(record.id, key)
    }
  }
  await service.db.domain.close()
  service.db = await openReaderStorage(ctx)
  assert.equal(service.db.sources.get(imported.id).bookSourceUrl, 'https://example.com')
  assert.equal(service.db.sources.get(imported.id).contentType, 'video')
  assert.equal(service.db.books.get(book.id).bookUrl, 'https://example.com/book/1')
  assert.equal(service.db.books.get(book.id).contentType, 'video')
  assert.equal(service.db.chapters.get(toc[0].id).text, '正文')
  assert.equal(service.db.chapters.get(toc[0].id).url, 'https://example.com/chapter/1')
  assert.equal(service.db.subscriptions.get(subscribed.subscription.id).url, 'https://library.example/sources.json')
  assert.equal(service.db.sources.get(subscriptionSourceId).name, '订阅源新版')
  assert.equal(service.db.sources.get(subscriptionSourceId).enabled, false)
  assert.deepEqual(service.db.subscriptions.get(subscribed.subscription.id).sourceIds.slice().sort(), [subscriptionSourceId, newSourceId].sort())
  assert.equal(service.db.subscriptions.get(subscribed.subscription.id).status, 'ready')

  library = [
    { bookSourceName: '订阅源新版', bookSourceUrl: 'https://sub.example', rules: {} },
    { bookSourceName: '新站候选', bookSourceUrl: 'https://pending.example', rules: {} },
  ]
  const pending = await service.refreshSubscription({ id: subscribed.subscription.id })
  assert.equal(pending.pending, true)
  assert.equal(service.db.sources.get(subscriptionSourceId).name, '订阅源新版')
  assert.equal([...service.db.sources.entries()].map(([, source]) => source).some(source => source.bookSourceUrl === 'https://pending.example'), false)

  await service.db.domain.close()
  service.db = await openReaderStorage(ctx)
  const persisted = service.db.subscriptions.get(subscribed.subscription.id)
  assert.equal(persisted.status, 'pending')
  assert.equal(persisted.pending.candidates.some(source => source.bookSourceUrl === 'https://pending.example'), true)
  assert.equal([...service.db.sources.entries()].map(([, source]) => source).some(source => source.bookSourceUrl === 'https://pending.example'), false)

  await service.confirmSubscriptionUpdate({ id: subscribed.subscription.id })
  const confirmed = service.db.subscriptions.get(subscribed.subscription.id)
  assert.equal(confirmed.status, 'ready')
  assert.equal(confirmed.pending, undefined)
  assert.equal([...service.db.sources.entries()].map(([, source]) => source).some(source => source.bookSourceUrl === 'https://pending.example'), true)
})

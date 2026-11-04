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
  const service = new ReaderService(ctx, { engine })
  service.db = await openReaderStorage(ctx)
  t.after(async () => {
    await service.db.domain.close()
    await backend.close()
    await rm(root, { recursive: true, force: true })
  })

  const imported = await service.importSource({ text: JSON.stringify({
    bookSourceName: 'HTTPS 源',
    bookSourceUrl: 'https://example.com',
    ruleBookInfo: { name: 'h1' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    ruleContent: { content: '#content' },
  }) })
  assert.match(imported.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(imported.bookSourceUrl, 'https://example.com')
  assert.equal(service.source(imported.id).bookSourceUrl, 'https://example.com')

  const book = await service.addBook({ sourceId: imported.id, bookUrl: 'https://example.com/book/1' })
  assert.match(book.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(book.bookUrl, 'https://example.com/book/1')
  assert.equal(book.sourceId, imported.id)
  const toc = await service.toc({ bookId: book.id })
  assert.match(toc[0].id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(toc[0].url, 'https://example.com/chapter/1')
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.text, '正文')

  for (const table of ['sources', 'books', 'chapters']) {
    for (const [key, record] of service.db[table].entries()) {
      assert.match(key, /^[a-zA-Z0-9_-]+$/)
      assert.equal(record.id, key)
    }
  }
  await service.db.domain.close()
  service.db = await openReaderStorage(ctx)
  assert.equal(service.db.sources.get(imported.id).bookSourceUrl, 'https://example.com')
  assert.equal(service.db.books.get(book.id).bookUrl, 'https://example.com/book/1')
  assert.equal(service.db.chapters.get(toc[0].id).text, '正文')
  assert.equal(service.db.chapters.get(toc[0].id).url, 'https://example.com/chapter/1')
})

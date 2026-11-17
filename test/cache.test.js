import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

test('本地书导出 TXT 与缓存提示', async () => {
  process.env.MO_READER_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-local-'))
  process.env.MO_READER_CACHE_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-cache-'))

  const { ReaderService } = await import('../dist/server/service.js')
  const books = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = { books, sources: fakeTable(), chapters: fakeTable(), settings: { get: () => ({}), set: async () => {} } }

  const text = '序章\n\n这是序章正文。\n\n第一章 起点\n\n起点正文内容。\n\n第二章 风起\n\n风起正文内容。'
  const imported = await service.importLocalBook({
    fileName: 'demo.txt',
    dataBase64: Buffer.from(text, 'utf8').toString('base64'),
  })
  assert.ok(imported.book.id)

  const cache = await service.cacheBook({ bookId: imported.book.id })
  assert.equal(cache.message, '本地书无需缓存')

  const exported = await service.exportBook({ bookId: imported.book.id })
  assert.equal(exported.fileName, 'demo.txt')
  assert.ok(exported.chapters >= 3)
  const body = Buffer.from(exported.dataBase64, 'base64').toString('utf8')
  assert.match(body, /demo/)
  assert.match(body, /第一章 起点/)
  assert.match(body, /起点正文内容/)
  assert.match(body, /风起正文内容/)
})

test('本地书导出 EPUB（含 mimetype/opf/章节正文）', async () => {
  process.env.MO_READER_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-local-'))
  process.env.MO_READER_CACHE_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-cache-'))

  const JSZip = (await import('jszip')).default
  const { ReaderService } = await import('../dist/server/service.js')
  const books = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = { books, sources: fakeTable(), chapters: fakeTable(), settings: { get: () => ({}), set: async () => {} } }

  const text = '第一章 起点\n\n起点正文内容。\n\n第二章 风起\n\n风起正文内容。'
  const imported = await service.importLocalBook({
    fileName: 'demo.txt',
    dataBase64: Buffer.from(text, 'utf8').toString('base64'),
  })

  const exported = await service.exportBook({ bookId: imported.book.id, format: 'epub' })
  assert.equal(exported.fileName, 'demo.epub')
  assert.equal(exported.format, 'epub')
  assert.ok(exported.chapters >= 2)
  const buffer = Buffer.from(exported.dataBase64, 'base64')
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')

  const zip = await JSZip.loadAsync(buffer)
  assert.equal(await zip.file('mimetype').async('string'), 'application/epub+zip')
  assert.ok(zip.file('META-INF/container.xml'))
  const opf = await zip.file('OEBPS/content.opf').async('string')
  assert.match(opf, /demo/)
  const chapter = await zip.file('OEBPS/chapter1.xhtml').async('string')
  assert.match(chapter, /起点正文内容/)
})

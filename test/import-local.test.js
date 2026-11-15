import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import iconv from 'iconv-lite'
import JSZip from 'jszip'
import { decodeText, parseTxt } from '../dist/core/import/txt.js'
import { parseEpub } from '../dist/core/import/epub.js'

const LOCAL_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-local-'))
process.env.MO_READER_LOCAL_ROOT = LOCAL_ROOT
const { ReaderService } = await import('../dist/server/service.js')

const TXT = `版权信息：本书仅供测试

第一章 开始
夜里很安静。
第二段。

第二章 继续
白天很吵。
`

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

async function makeService() {
  const books = fakeTable()
  const readRecords = fakeTable()
  let settingsValue = { theme: 'light' }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = { sources: fakeTable(), books, readRecords, settings }
  return { service, books, readRecords }
}

async function makeEpub() {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  )
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试 EPUB</dc:title><dc:creator>作者甲</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/><itemref idref="ch2"/></spine></package>`,
  )
  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav epub:type="toc"><ol><li><a href="ch1.xhtml">第一章 开端</a></li><li><a href="ch2.xhtml">第二章 发展</a></li></ol></nav></body></html>`,
  )
  zip.file('OEBPS/ch1.xhtml', `<html><body><h1>第一章</h1><p>正文一。</p><p>第二段。</p></body></html>`)
  zip.file('OEBPS/ch2.xhtml', `<html><body><h1>第二章</h1><p>正文二。</p></body></html>`)
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('TXT 解码与章节切分', () => {
  const chaptered = parseTxt(Buffer.from(TXT, 'utf8'), '测试书.txt')
  assert.equal(chaptered.name, '测试书')
  assert.equal(chaptered.chapters.length, 3)
  assert.equal(chaptered.chapters[0].title, '开始')
  assert.match(chaptered.chapters[1].content, /夜里很安静/)

  const gbk = parseTxt(iconv.encode(TXT, 'gb18030'), 'gbk.txt')
  assert.equal(gbk.chapters.length, 3)
  assert.match(gbk.chapters[2].content, /白天很吵/)
})

test('TXT 无章节标题时按段落兜底', () => {
  const text = Array.from(
    { length: 120 },
    (_, i) => `第${i + 1}段正文。${'这是用来凑长度的正文内容，。'.repeat(2)}`,
  ).join('\n\n')
  const parsed = parseTxt(Buffer.from(text, 'utf8'), '无标题.txt')
  assert.ok(parsed.chapters.length >= 2)
  assert.equal(parsed.chapters[0].title, '第1节')
})

test('EPUB 解析与本地导入 Remote', async () => {
  const epub = await makeEpub()
  const parsed = await parseEpub(epub, '测试.epub')
  assert.equal(parsed.name, '测试 EPUB')
  assert.equal(parsed.author, '作者甲')
  assert.equal(parsed.chapters.length, 2)
  assert.equal(parsed.chapters[0].title, '第一章 开端')

  const { service } = await makeService()
  const buffer = Buffer.from(TXT, 'utf8')
  const imported = await service.importLocalBook({
    fileName: '测试书.txt',
    dataBase64: buffer.toString('base64'),
  })
  assert.equal(imported.book.name, '测试书')
  assert.equal(imported.book.origin, 'local')
  assert.equal(imported.chapters, 3)

  const toc = await service.getToc({ tocUrl: imported.book.bookUrl })
  assert.equal(toc.chapters.length, 3)
  const content = await service.getContent({ chapterUrl: toc.chapters[1].url })
  assert.match(content.content, /夜里很安静/)

  const listed = await service.listBooks()
  assert.equal(listed.books.length, 1)
  assert.equal(listed.books[0].id, imported.book.id)

  const removed = await service.removeBooks({ ids: [imported.book.id] })
  assert.equal(removed.deleted, 1)
  await rm(join(LOCAL_ROOT, imported.book.id), { recursive: true, force: true })
})

test.after(async () => {
  await rm(LOCAL_ROOT, { recursive: true, force: true })
})

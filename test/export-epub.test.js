import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { fetchBinary } from '../dist/core/net/http.js'
import { loadCoverImage } from '../dist/server/export-cover.js'
import { buildEpub } from '../dist/server/epub-export.js'

// 1x1 透明 PNG：只校验字节原样嵌入，不依赖图片解码。
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6a0000000049454e44ae426082',
  'hex',
)
// 公网字面量 IP：SSRF 守卫不做 DNS，测试用桩 fetch 抓包，不需要真实网络。
const PUBLIC_HOST = 'http://93.184.216.34'

async function readEntry(zip, name) {
  const entry = zip.file(name)
  assert.ok(entry, '缺少 ' + name)
  return entry.async('string')
}

test('EPUB3 结构：mimetype 首个且不压缩，container/opf/nav/ncx 齐全', async () => {
  const data = await buildEpub({
    title: '测试 & 书',
    author: '某人',
    chapters: [
      { title: '第一章 & 起点', text: '第一段\n第二段' },
      { title: '第二章', text: '内容' },
    ],
  })
  // EPUB 规范要求 mimetype 是 ZIP 第一个条目且用 STORE（不压缩）。
  assert.equal(data.subarray(0, 4).toString('latin1'), 'PK\x03\x04')
  assert.equal(data.readUInt16LE(8), 0)
  assert.equal(data.subarray(30, 30 + data.readUInt16LE(26)).toString('latin1'), 'mimetype')

  const zip = await JSZip.loadAsync(data)
  assert.equal(await readEntry(zip, 'mimetype'), 'application/epub+zip')
  assert.match(await readEntry(zip, 'META-INF/container.xml'), /full-path="OEBPS\/content\.opf"/)
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.match(opf, /<dc:title>测试 &amp; 书<\/dc:title>/)
  assert.match(opf, /<dc:creator>某人<\/dc:creator>/)
  assert.match(opf, /<meta property="dcterms:modified">\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/meta>/)
  assert.match(opf, /<item id="nav" href="nav\.xhtml" media-type="application\/xhtml\+xml" properties="nav"\/>/)
  assert.match(opf, /<spine toc="ncx">/)
  const nav = await readEntry(zip, 'OEBPS/nav.xhtml')
  assert.equal((nav.match(/<li><a href="chapter\d+\.xhtml">/g) ?? []).length, 2)
  const ncx = await readEntry(zip, 'OEBPS/toc.ncx')
  assert.equal((ncx.match(/<navPoint /g) ?? []).length, 2)
  assert.match(ncx, /playOrder="2"/)
  const chapter = await readEntry(zip, 'OEBPS/chapter1.xhtml')
  assert.match(chapter, /<h1>第一章 &amp; 起点<\/h1>/)
  assert.match(chapter, /<p>第一段<\/p>/)
  assert.match(chapter, /<p>第二段<\/p>/)
})

test('EPUB 缺作者：不留空的 dc:creator', async () => {
  const data = await buildEpub({ title: '无作者书', chapters: [{ title: '第一章', text: '正文' }] })
  const opf = await readEntry(await JSZip.loadAsync(data), 'OEBPS/content.opf')
  assert.ok(!opf.includes('dc:creator'))
  assert.ok(!opf.includes('未知作者'))
  assert.match(opf, /<dc:title>无作者书<\/dc:title>/)
})

test('EPUB 封面：声明 cover-image，封面页排在 spine 首位', async () => {
  const data = await buildEpub({
    title: '带封面的书',
    author: '某人',
    chapters: [{ title: '第一章', text: '正文' }],
    cover: { data: PNG_1X1, mediaType: 'image/png', extension: 'png' },
  })
  const zip = await JSZip.loadAsync(data)
  assert.deepEqual(await zip.file('OEBPS/cover.png').async('nodebuffer'), PNG_1X1)
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/)
  assert.match(opf, /<item id="cover-image" href="cover\.png" media-type="image\/png" properties="cover-image"\/>/)
  assert.match(opf, /<item id="cover-page" href="cover\.xhtml" media-type="application\/xhtml\+xml"\/>/)
  const spine = opf.slice(opf.indexOf('<spine'))
  assert.ok(spine.indexOf('idref="cover-page"') < spine.indexOf('idref="chapter1"'))
  assert.match(await readEntry(zip, 'OEBPS/cover.xhtml'), /<img src="cover\.png"/)
})

test('封面：data URL 直接内嵌，非图片或非法地址一律跳过', async () => {
  const cover = await loadCoverImage('data:image/png;base64,' + PNG_1X1.toString('base64'))
  assert.equal(cover.extension, 'png')
  assert.equal(cover.mediaType, 'image/png')
  assert.deepEqual(cover.data, PNG_1X1)
  assert.equal(await loadCoverImage(''), null)
  assert.equal(await loadCoverImage(null), null)
  assert.equal(await loadCoverImage('data:text/plain;base64,aGk='), null)
  assert.equal(await loadCoverImage('data:image/svg+xml;base64,PHN2Zy8+'), null)
  assert.equal(await loadCoverImage('ftp://example.com/cover.png'), null)
  assert.equal(await loadCoverImage('not-a-url'), null)
})

test('封面：抓取成功按 Content-Type 决定扩展名', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/png; charset=binary' } })
  }
  try {
    const cover = await loadCoverImage(PUBLIC_HOST + '/cover')
    assert.equal(calls.length, 1)
    assert.equal(cover.extension, 'png')
    assert.equal(cover.mediaType, 'image/png')
    assert.deepEqual(cover.data, PNG_1X1)
  } finally {
    globalThis.fetch = original
  }
})

test('封面：非 2xx 或非图片类型跳过', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('nope', { status: 404, headers: { 'content-type': 'text/html' } })
    assert.equal(await loadCoverImage(PUBLIC_HOST + '/missing'), null)
    globalThis.fetch = async () => new Response('hello', { status: 200, headers: { 'content-type': 'text/html' } })
    assert.equal(await loadCoverImage(PUBLIC_HOST + '/page'), null)
  } finally {
    globalThis.fetch = original
  }
})

test('封面：逐跳复检重定向后取图', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async (url) => {
      if (String(url).endsWith('/a')) {
        return new Response(null, { status: 302, headers: { location: PUBLIC_HOST + '/b' } })
      }
      return new Response(PNG_1X1, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    }
    const cover = await loadCoverImage(PUBLIC_HOST + '/a')
    assert.equal(cover.extension, 'jpg')
    assert.equal(cover.mediaType, 'image/jpeg')
  } finally {
    globalThis.fetch = original
  }
})

test('封面：http 抓取失败或体积超限都跳过', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => {
      throw new Error('网络错误')
    }
    assert.equal(await loadCoverImage(PUBLIC_HOST + '/cover'), null)
    globalThis.fetch = async () =>
      new Response(Buffer.alloc(2 * 1024 * 1024 + 1, 1), { status: 200, headers: { 'content-type': 'image/png' } })
    assert.equal(await loadCoverImage(PUBLIC_HOST + '/big'), null)
  } finally {
    globalThis.fetch = original
  }
})

test('fetchBinary：SSRF 守卫拒绝本机地址，超限抛错', async () => {
  const original = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('不应发起请求')
  }
  try {
    await assert.rejects(fetchBinary('http://127.0.0.1/cover.png'), /禁止访问本机/)
    assert.equal(called, false)
    globalThis.fetch = async () => new Response(Buffer.alloc(2048, 1), { status: 200, headers: { 'content-type': 'image/png' } })
    await assert.rejects(fetchBinary(PUBLIC_HOST + '/big', { maxBytes: 1024 }), /响应体过大/)
  } finally {
    globalThis.fetch = original
  }
})

test('fetchBinary：重定向到内网地址被复检拦下', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private.png' } })
  try {
    await assert.rejects(fetchBinary(PUBLIC_HOST + '/a'), /禁止访问本机/)
  } finally {
    globalThis.fetch = original
  }
})

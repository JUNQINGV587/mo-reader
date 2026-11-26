import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const BASE = 'https://reader.example.com'
const owner = { principal: { kind: 'owner' } }
const visitor = { principal: { kind: 'visitor' } }

const { PDFJS_ASSET_ROUTE_PATH, PDFJS_ASSET_KINDS, pdfjsAssetUrl, pdfjsDocumentOptions } = await import(
  '../dist/core/pdfjs-assets.js'
)
const { createPdfjsAssetRoute, pdfjsAssetRoot, PDFJS_ASSET_CACHE_CONTROL } = await import(
  '../dist/server/pdfjs-assets.js'
)
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')

/** 与导入路径测试同一份最小 PDF 生成器，只是字体换成未嵌入的 Type0 中文字体。 */
function makeCjkPdf() {
  const stream = 'BT /F1 12 Tf 72 720 Td <4F60597D> Tj ET'
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Count 1 /Kids [3 0 R] >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>'
  objects[5] = '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>'
  objects[6] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 1; index <= 6; index += 1) {
    offsets[index] = Buffer.byteLength(pdf)
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 7\n0000000000 65535 f \n`
  for (let index = 1; index <= 6; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new Uint8Array(Buffer.from(pdf, 'ascii'))
}

/** 把路由地址还原成磁盘目录：pdfjs 在 Node 里从文件系统读，浏览器里走同一个相对地址。 */
function directoryFor(url) {
  const match = url.match(/^\/reader\/pdfjs\/([a-z_]+)\/$/)
  assert.ok(match, `资源地址应指向路由目录：${url}`)
  assert.ok(PDFJS_ASSET_KINDS.includes(match[1]), '资源目录必须是已知种类')
  return join(pdfjsAssetRoot(), match[1]) + '/'
}

async function pageText(options) {
  const task = getDocument({ data: makeCjkPdf(), ...options })
  const doc = await task.promise
  try {
    const page = await doc.getPage(1)
    const content = await page.getTextContent()
    return content.items.filter((item) => 'str' in item).map((item) => item.str).join('')
  } finally {
    await task.destroy()
  }
}

test('未嵌入中文字形的 PDF 能取出文字，缺资源时取不到（原版阅读缺字形的根因）', async () => {
  const options = pdfjsDocumentOptions('https://reader.example.com/reader/local-pdf/000000000000000000000000')
  assert.equal(options.url, 'https://reader.example.com/reader/local-pdf/000000000000000000000000')
  assert.equal(options.cMapUrl, pdfjsAssetUrl('cmaps'))
  assert.equal(options.standardFontDataUrl, pdfjsAssetUrl('standard_fonts'))
  assert.equal(options.wasmUrl, pdfjsAssetUrl('wasm'))
  assert.equal(options.cMapPacked, true)
  // 网页里的 worker 是内联 data: URL，worker 内解析不了相对地址，必须让主线程取资源。
  assert.equal(options.useWorkerFetch, false)

  const text = await pageText({
    cMapUrl: directoryFor(options.cMapUrl),
    cMapPacked: options.cMapPacked,
    standardFontDataUrl: directoryFor(options.standardFontDataUrl),
    wasmUrl: directoryFor(options.wasmUrl),
  })
  assert.equal(text, '你好')

  // 旧行为：只传 url、不带资源地址时 pdfjs 取不到字形，页面空白。
  assert.equal(await pageText({}), '')
})

test('资源路由按原版阅读的地址提供同一份 pdfjs 资源', async () => {
  const route = createPdfjsAssetRoute()
  assert.equal(route.path, PDFJS_ASSET_ROUTE_PATH)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.auth, 'required')
  const root = pdfjsAssetRoot()

  const cases = [
    ['cmaps/UniGB-UCS2-H.bcmap', 'application/octet-stream'],
    ['standard_fonts/LiberationSans-Regular.ttf', 'font/ttf'],
    ['wasm/openjpeg.wasm', 'application/wasm'],
  ]
  for (const [relative, contentType] of cases) {
    const url = `${BASE}${PDFJS_ASSET_ROUTE_PATH}/${relative}`
    const response = await route.resource(new Request(url), owner)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), contentType)
    assert.equal(response.headers.get('cache-control'), PDFJS_ASSET_CACHE_CONTROL)
    const served = Buffer.from(await response.arrayBuffer())
    assert.deepEqual(served, await readFile(join(root, relative)))
  }

  // pdfjs 在浏览器里按 <cMapUrl><文件名> 拼地址，拼出来的这条必须真的能取到。
  const requested = new URL(`${pdfjsDocumentOptions('unused').cMapUrl}UniGB-UCS2-H.bcmap`, `${BASE}/`)
  const cMapResponse = await route.resource(new Request(requested), owner)
  assert.equal(cMapResponse.status, 200)
  assert.equal(cMapResponse.headers.get('content-type'), 'application/octet-stream')

  const head = await route.resource(
    new Request(`${BASE}${PDFJS_ASSET_ROUTE_PATH}/cmaps/UniGB-UCS2-H.bcmap`, { method: 'HEAD' }),
    owner,
  )
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.ok(Number(head.headers.get('content-length')) > 0)
})

test('资源路由拒绝未授权、非 GET 与白名单外的路径', async () => {
  const route = createPdfjsAssetRoute()
  const get = (path, peer, method = 'GET') =>
    route.resource(new Request(`${BASE}${path}`, { method }), peer)

  assert.equal((await get(`${PDFJS_ASSET_ROUTE_PATH}/cmaps/UniGB-UCS2-H.bcmap`, undefined)).status, 401)
  assert.equal((await get(`${PDFJS_ASSET_ROUTE_PATH}/cmaps/UniGB-UCS2-H.bcmap`, visitor)).status, 403)
  const post = await get(`${PDFJS_ASSET_ROUTE_PATH}/cmaps/UniGB-UCS2-H.bcmap`, owner, 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')

  for (const path of [
    `${PDFJS_ASSET_ROUTE_PATH}/cmaps/missing.bcmap`,
    `${PDFJS_ASSET_ROUTE_PATH}/build/pdf.mjs`,
    `${PDFJS_ASSET_ROUTE_PATH}/cmaps/%2e%2e/package.json`,
    `${PDFJS_ASSET_ROUTE_PATH}/cmaps/UniGB-UCS2-H.bcmap/extra`,
  ]) {
    assert.equal((await get(path, owner)).status, 404, path)
  }
})

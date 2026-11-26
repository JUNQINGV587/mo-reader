import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// 本地书目录必须在导入 service 之前指向临时目录，避免碰用户真实的书库。
const LOCAL_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-pdf-'))
process.env.MO_READER_LOCAL_ROOT = LOCAL_ROOT
const { ReaderService } = await import('../dist/server/service.js')
const { LOCAL_PDF_ROUTE_PATH } = await import('../dist/server/routes.js')

const BASE = 'https://reader.example.com'
const owner = { principal: { kind: 'owner' } }

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
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources: fakeTable(),
    books,
    readRecords: fakeTable(),
    settings: { get: () => ({ theme: 'light' }), set: async () => {} },
  }
  return { service, books }
}

function pdfLiteral(value) {
  return value.replace(/([\\()])/g, '\\$1')
}

/** 与 import-local 测试同一份最小 PDF 生成器：两页文本 + 元信息 + 完整 xref。 */
function makePdf(pages, { title = 'PDF Fixture', author = 'Author A' } = {}) {
  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((text, index) => {
    const pageObject = 4 + index * 2
    const contentObject = pageObject + 1
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${pdfLiteral(text)}) Tj ET` : ''
    objects[pageObject] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObject} 0 R >>`
    objects[contentObject] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  })
  const infoObject = 4 + pages.length * 2
  objects[infoObject] = `<< /Title (${pdfLiteral(title)}) /Author (${pdfLiteral(author)}) /Subject (Local import test) >>`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 1; index <= infoObject; index += 1) {
    offsets[index] = Buffer.byteLength(pdf)
    pdf += `${index} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${infoObject + 1}\n0000000000 65535 f \n`
  for (let index = 1; index <= infoObject; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${infoObject + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'ascii')
}

const TXT = `第一章 开始
夜里很安静。
第二章 继续
白天很吵。
`

/** 注册路由并返回收集到的路由对象；不启真实端口。 */
function mountRoute(service) {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  Object.defineProperty(service, 'ctx', {
    configurable: true,
    writable: true,
    value: {
      webServer: { getOrigin: () => BASE },
      inject: (deps, callback) => {
        callback({
          webServer,
          effect: (factory) => {
            factory()
          },
        })
      },
    },
  })
  service.registerLocalPdfRoute()
  assert.equal(routes.length, 1)
  return routes[0]
}

function urlOf(bookId) {
  return BASE + LOCAL_PDF_ROUTE_PATH + '/' + bookId
}

async function importPdf(service, name = '测试.pdf') {
  const pdf = makePdf(['First page text.', 'Second page text.'])
  const imported = await service.importLocalBook({ fileName: name, dataBase64: pdf.toString('base64') })
  return { pdf, imported }
}

test('导入 PDF 保存原文件并保留章节文本，导入 TXT 不写原文件', async () => {
  const { service } = await makeService()
  const { pdf, imported } = await importPdf(service)
  const bookId = imported.book.id
  assert.match(bookId, /^[0-9a-f]{24}$/)
  assert.equal(imported.book.localFormat, 'pdf')
  assert.equal(imported.book.origin, 'local')

  const original = await readFile(join(LOCAL_ROOT, bookId, 'original.pdf'))
  assert.deepEqual(original, pdf)

  const toc = await service.getToc({ tocUrl: imported.book.bookUrl })
  assert.deepEqual(
    toc.chapters.map((chapter) => chapter.title),
    ['第 1 页', '第 2 页'],
  )
  const content = await service.getContent({ chapterUrl: toc.chapters[1].url })
  assert.equal(content.content, 'Second page text.')

  const status = await service.getLocalPdfStatus({ bookId })
  assert.deepEqual(status, {
    bookId,
    isPdf: true,
    hasOriginal: true,
    needsReimport: false,
    fileName: 'PDF Fixture.pdf',
  })

  const txt = await service.importLocalBook({
    fileName: '测试书.txt',
    dataBase64: Buffer.from(TXT, 'utf8').toString('base64'),
  })
  assert.equal(txt.book.localFormat, undefined)
  await assert.rejects(readFile(join(LOCAL_ROOT, txt.book.id, 'original.pdf')), /ENOENT/)
  const txtStatus = await service.getLocalPdfStatus({ bookId: txt.book.id })
  assert.equal(txtStatus.isPdf, false)
  assert.equal(txtStatus.needsReimport, false)

  await rm(join(LOCAL_ROOT, bookId), { recursive: true, force: true })
  await rm(join(LOCAL_ROOT, txt.book.id), { recursive: true, force: true })
})

test('旧版本 PDF 记录识别为缺原文件，重新导入同一文件后补齐且保留用户状态', async () => {
  const { service, books } = await makeService()
  const pdf = makePdf(['First page text.', 'Second page text.'])
  const bookId = createHash('sha1').update(pdf).digest('hex').slice(0, 24)
  const oldBook = {
    id: bookId,
    name: 'PDF Fixture',
    author: 'Author A',
    bookUrl: `local://${bookId}`,
    origin: 'local',
    originName: '本地',
    type: 0,
    group: '待补',
    coverUrl: '',
    intro: 'Local import test',
    totalChapterNum: 2,
    wordCount: '',
    rating: '',
    pinned: true,
    latestChapterTitle: '第 2 页',
    lastReadAt: 1720000000000,
    simulateEnabled: true,
    simulateStartDate: '2026-01-01',
    simulateStartChapter: 3,
    simulateDailyChapters: 5,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  }
  const dir = join(LOCAL_ROOT, bookId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'book.json'),
    JSON.stringify({
      book: oldBook,
      chapters: [
        { title: '第 1 页', content: 'First page text.' },
        { title: '第 2 页', content: 'Second page text.' },
      ],
    }),
    'utf8',
  )
  await books.put(bookId, oldBook)

  const before = await service.getLocalPdfStatus({ bookId })
  assert.equal(before.isPdf, true)
  assert.equal(before.hasOriginal, false)
  assert.equal(before.needsReimport, true)

  const reimported = await service.importLocalBook({
    fileName: '再次导入.pdf',
    dataBase64: pdf.toString('base64'),
  })
  assert.equal(reimported.book.id, bookId)
  assert.equal(reimported.book.localFormat, 'pdf')
  assert.equal(reimported.book.pinned, true)
  assert.equal(reimported.book.group, '待补')
  assert.equal(reimported.book.lastReadAt, 1720000000000)
  assert.equal(reimported.book.simulateEnabled, true)
  assert.equal(reimported.book.simulateStartDate, '2026-01-01')
  assert.equal(reimported.book.simulateStartChapter, 3)
  assert.equal(reimported.book.simulateDailyChapters, 5)
  assert.equal(reimported.book.createdAt, '2024-01-01T00:00:00.000Z')

  const after = await service.getLocalPdfStatus({ bookId })
  assert.equal(after.isPdf, true)
  assert.equal(after.hasOriginal, true)
  assert.equal(after.needsReimport, false)
  assert.deepEqual(await readFile(join(dir, 'original.pdf')), pdf)

  await rm(dir, { recursive: true, force: true })
})

test('PDF 原文件路由：200 / HEAD / 206 单段 Range', async () => {
  const { service } = await makeService()
  const route = mountRoute(service)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, LOCAL_PDF_ROUTE_PATH)
  assert.equal(route.auth, 'required')

  const { pdf, imported } = await importPdf(service)
  const bookId = imported.book.id
  const total = pdf.length

  const full = await route.resource(new Request(urlOf(bookId)), owner)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'application/pdf')
  assert.equal(full.headers.get('content-length'), String(total))
  assert.equal(full.headers.get('cache-control'), 'private, max-age=0')
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(
    full.headers.get('content-disposition'),
    `attachment; filename="PDF Fixture.pdf"; filename*=UTF-8''PDF%20Fixture.pdf`,
  )
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), pdf)

  const head = await route.resource(new Request(urlOf(bookId), { method: 'HEAD' }), owner)
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), String(total))
  assert.equal((await head.arrayBuffer()).byteLength, 0)

  const cases = [
    { header: 'bytes=0-9', start: 0, end: 9 },
    { header: 'bytes=10-', start: 10, end: total - 1 },
    { header: 'bytes=-10', start: total - 10, end: total - 1 },
  ]
  for (const item of cases) {
    const response = await route.resource(
      new Request(urlOf(bookId), { headers: { range: item.header } }),
      owner,
    )
    assert.equal(response.status, 206, item.header)
    assert.equal(response.headers.get('content-range'), `bytes ${item.start}-${item.end}/${total}`)
    assert.equal(response.headers.get('content-length'), String(item.end - item.start + 1))
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf.subarray(item.start, item.end + 1))
  }

  await rm(join(LOCAL_ROOT, bookId), { recursive: true, force: true })
})

test('PDF 原文件路由：鉴权、方法、非法路径与 416', async () => {
  const { service } = await makeService()
  const route = mountRoute(service)
  const { imported } = await importPdf(service)
  const bookId = imported.book.id

  const missingPeer = await route.resource(new Request(urlOf(bookId)))
  assert.equal(missingPeer.status, 401)
  const guest = await route.resource(new Request(urlOf(bookId)), { principal: { kind: 'guest' } })
  assert.equal(guest.status, 403)

  const post = await route.resource(new Request(urlOf(bookId), { method: 'POST' }), owner)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')

  const notFoundUrls = [
    BASE + LOCAL_PDF_ROUTE_PATH + '/' + bookId.toUpperCase(),
    BASE + LOCAL_PDF_ROUTE_PATH + '/abc',
    BASE + LOCAL_PDF_ROUTE_PATH + '/%2e%2e%2f' + bookId,
    BASE + LOCAL_PDF_ROUTE_PATH + '/' + bookId + '/extra',
    BASE + LOCAL_PDF_ROUTE_PATH + '/' + 'a'.repeat(24),
  ]
  for (const url of notFoundUrls) {
    const response = await route.resource(new Request(url), owner)
    assert.equal(response.status, 404, url)
  }

  // 书在书架上但目录里没有 original.pdf（TXT 导入即如此）：只按缺失处理，不泄漏路径。
  const txt = await service.importLocalBook({
    fileName: '无原文件.txt',
    dataBase64: Buffer.from(TXT, 'utf8').toString('base64'),
  })
  const noOriginal = await route.resource(new Request(urlOf(txt.book.id)), owner)
  assert.equal(noOriginal.status, 404)

  const invalidRanges = ['bytes=999999-', 'bytes=abc', 'bytes=5-4', 'bytes=0-1,3-4']
  for (const header of invalidRanges) {
    const response = await route.resource(new Request(urlOf(bookId), { headers: { range: header } }), owner)
    assert.equal(response.status, 416, header)
    assert.equal(response.headers.get('content-range'), `bytes */${(await readFile(join(LOCAL_ROOT, bookId, 'original.pdf'))).length}`)
  }

  await rm(join(LOCAL_ROOT, bookId), { recursive: true, force: true })
  await rm(join(LOCAL_ROOT, txt.book.id), { recursive: true, force: true })
})

test.after(async () => {
  await rm(LOCAL_ROOT, { recursive: true, force: true })
})

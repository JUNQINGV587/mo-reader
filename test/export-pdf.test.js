import assert from 'node:assert/strict'
import test from 'node:test'
import { copyFile, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 字体目录必须在导入 service 之前指向临时目录，避免碰用户真实字体库。
const FONT_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-pdf-fonts-'))
process.env.MO_READER_FONT_ROOT = FONT_ROOT

const FIXTURE = new URL('./fixtures/cjk-subset.otf', import.meta.url)
const OTF_ID = 'font-' + 'a'.repeat(24)
const WOFF_ID = 'font-' + 'b'.repeat(24)
const MISSING_ID = 'font-' + 'f'.repeat(24)
await copyFile(FIXTURE, path.join(FONT_ROOT, OTF_ID + '.otf'))
await writeFile(path.join(FONT_ROOT, WOFF_ID + '.woff'), Buffer.from('wOFF fake'))
await writeFile(
  path.join(FONT_ROOT, 'fonts.json'),
  JSON.stringify([
    {
      id: OTF_ID,
      name: '测试中文字体',
      fileName: 'cjk-subset.otf',
      format: 'opentype',
      size: (await readFile(FIXTURE)).length,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: WOFF_ID,
      name: '网页字体',
      fileName: 'fake.woff',
      format: 'woff',
      size: 9,
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ]),
)

const { ReaderService } = await import('../dist/server/service.js')
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

// 合法的 1x1 透明 PNG：pdfkit 内置 png-js 对损坏 PNG 会直接抛错。
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000000049454e44ae426082',
  'hex',
)
const WEBP_1X1 = Buffer.from('524946460400000057454250', 'hex')

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

const ORIGIN = 'https://pdf.example.com'
const BASE = 'https://reader.example.com'
const ROUTE = '/reader/exports'
const CONTENT = (n) => '<div id="content"><p>第' + n + '章正文内容测试。</p><p>中文，标点！？“”正常显示。</p></div>'

function buildToc(count) {
  const items = []
  for (let index = 1; index <= count; index += 1) {
    items.push('<li><a href="/ch/' + index + '">第' + index + '章</a></li>')
  }
  return '<ul class="toc">' + items.join('') + '</ul>'
}

async function makeHarness(options = {}) {
  process.env.MO_READER_CACHE_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-pdf-cache-'))
  const exportRoot = await mkdtemp(path.join(tmpdir(), 'mo-pdf-out-'))
  process.env.MO_READER_EXPORT_ROOT = exportRoot
  const sources = fakeTable()
  const books = fakeTable()
  const jobs = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books,
    jobs,
    readRecords: fakeTable(),
    downloadEntries: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    settings: { get: () => ({ theme: 'system', fontSize: 24, lineSpacing: 1.9 }), set: async () => {} },
  }
  service.downloadRetryBaseMs = 1
  const source = {
    bookSourceUrl: ORIGIN,
    bookSourceName: '测试源',
    ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text||text', chapterUrl: 'a@href' },
    ruleContent: { content: 'id.content@text' },
  }
  sources.put('s1', source)
  const book = {
    id: 'book-1',
    name: '测试书',
    author: '某人',
    origin: ORIGIN,
    originName: '测试源',
    bookUrl: ORIGIN + '/book/1',
    tocUrl: ORIGIN + '/toc',
  }
  if (options.coverUrl) book.coverUrl = options.coverUrl
  books.put('book-1', book)
  const chapterCount = options.chapters ?? 0
  const pages = { [ORIGIN + '/toc']: buildToc(chapterCount) }
  for (let index = 1; index <= chapterCount; index += 1) {
    pages[ORIGIN + '/ch/' + index] = CONTENT(index)
  }
  const failUrls = new Set(options.failUrls ?? [])
  service.fetch = async (request) => {
    if (failUrls.has(request.url)) throw new Error('抓取失败：' + request.url)
    const text = pages[request.url]
    if (!text) throw new Error('页面不存在：' + request.url)
    return { text, url: request.url, status: 200 }
  }
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
  service.registerExportRoute()
  return { service, books, jobs, routes, exportRoot }
}

const owner = { principal: { kind: 'owner' } }

/** 用 pdfjs 读回页数与每页文本，校验真正生成的是可阅读的 PDF。 */
async function readPdf(bytes) {
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false })
  const doc = await task.promise
  try {
    const pages = []
    for (let index = 1; index <= doc.numPages; index += 1) {
      const page = await doc.getPage(index)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => item.str).join(''))
    }
    return { numPages: doc.numPages, pages }
  } finally {
    await task.destroy()
  }
}

async function finishedJob(harness, started) {
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  return job
}

test('PDF 导出必须带可嵌入的中文字体，否则不建作业也不留产物', async () => {
  const harness = await makeHarness({ chapters: 2 })
  const attempts = [
    { bookId: 'book-1', format: 'pdf' },
    { bookId: 'book-1', format: 'pdf', fontId: MISSING_ID },
    { bookId: 'book-1', format: 'pdf', fontId: WOFF_ID },
  ]
  for (const args of attempts) {
    await assert.rejects(harness.service.startExport(args), /请先上传中文字体/)
  }
  assert.equal(harness.jobs.map.size, 0)
  assert.deepEqual(await readdir(harness.exportRoot), [])
})

test('PDF 全本：65 章全部导出，A5 分页、中文与页码可读回', async () => {
  const harness = await makeHarness({ chapters: 65 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  assert.equal(started.existing, false)
  assert.equal(started.job.format, 'pdf')
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'done')
  assert.equal(job.total, 65)
  assert.equal(job.completed, 65)
  assert.equal(job.failed, 0)
  assert.equal(job.skipped, 0)
  assert.equal(job.fileName, '测试书.pdf')
  assert.equal(job.filePath, started.job.id + '.pdf')
  assert.ok(job.bytes > 0)

  const bytes = await readFile(path.join(harness.exportRoot, job.filePath))
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-')
  // 字体按用到的字形子集嵌入，重复导出不会把整份字体堆进 PDF。
  assert.equal((bytes.toString('latin1').match(/\/FontFile3/g) ?? []).length, 1)

  const { numPages, pages } = await readPdf(bytes)
  assert.equal(numPages, 65)
  assert.match(pages[0], /第1章/)
  assert.match(pages[0], /第1章正文内容测试。中文，标点！？“”正常显示。/)
  assert.match(pages[0], /第 1 页/)
  assert.match(pages[numPages - 1], /第 65 页/)

  const download = await harness.service.getExportDownload({ jobId: job.id })
  assert.equal(download.url, BASE + ROUTE + '/' + job.id)
  assert.equal(download.fileName, '测试书.pdf')
  const response = await harness.routes[0].resource(new Request(download.url), owner)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/pdf')
  const body = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(body, bytes)
})

test('PDF 单章失败：计失败但整本仍完成，失败章不占页', async () => {
  const harness = await makeHarness({ chapters: 3, failUrls: [ORIGIN + '/ch/2'] })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 2)
  assert.equal(job.failed, 1)
  const bytes = await readFile(path.join(harness.exportRoot, job.filePath))
  const { numPages, pages } = await readPdf(bytes)
  assert.equal(numPages, 2)
  assert.match(pages[0], /第1章正文内容测试/)
  assert.match(pages[1], /第3章正文内容测试/)
  assert.ok(pages.every((text) => !text.includes('第2章正文内容测试')))
  assert.match(pages[1], /第 2 页/)
})

test('PDF 全部章节失败：作业失败且不留产物', async () => {
  const harness = await makeHarness({ chapters: 2, failUrls: [ORIGIN + '/ch/1', ORIGIN + '/ch/2'] })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'failed')
  assert.equal(job.error, '全部章节导出失败')
  assert.deepEqual(await readdir(harness.exportRoot), [])
})

test('PDF 封面可选：PNG 封面单独成页且不编号', async () => {
  const harness = await makeHarness({ chapters: 2, coverUrl: 'data:image/png;base64,' + PNG_1X1.toString('base64') })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'done')
  const bytes = await readFile(path.join(harness.exportRoot, job.filePath))
  assert.ok((bytes.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length >= 1)
  const { numPages, pages } = await readPdf(bytes)
  assert.equal(numPages, 3)
  assert.equal(pages[0], '')
  assert.match(pages[1], /第1章正文内容测试/)
  assert.match(pages[1], /第 1 页/)
  assert.match(pages[2], /第 2 页/)
})

test('PDF 封面抓取失败：照常成书，不生成封面页', async () => {
  const harness = await makeHarness({ chapters: 2, coverUrl: 'https://img.example.com/c.jpg' })
  harness.service.fetchExportCover = async () => {
    throw new Error('封面抓取失败')
  }
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'done')
  const bytes = await readFile(path.join(harness.exportRoot, job.filePath))
  const { numPages, pages } = await readPdf(bytes)
  assert.equal(numPages, 2)
  assert.match(pages[0], /第1章正文内容测试/)
  assert.match(pages[0], /第 1 页/)
})

test('PDF 封面为 webp：跳过封面页，正文与页码正常', async () => {
  const harness = await makeHarness({ chapters: 2, coverUrl: 'data:image/webp;base64,' + WEBP_1X1.toString('base64') })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'pdf', fontId: OTF_ID })
  const job = await finishedJob(harness, started)
  assert.equal(job.status, 'done')
  const bytes = await readFile(path.join(harness.exportRoot, job.filePath))
  assert.equal((bytes.toString('latin1').match(/\/Subtype\s*\/Image/g) ?? []).length, 0)
  const { numPages, pages } = await readPdf(bytes)
  assert.equal(numPages, 2)
  assert.match(pages[0], /第1章正文内容测试/)
  assert.match(pages[1], /第 2 页/)
})

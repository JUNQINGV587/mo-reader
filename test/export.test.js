import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'

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

const ORIGIN = 'https://ex.example.com'
const BASE = 'https://reader.example.com'
const ROUTE = '/reader/exports'
const FAILED_ROUTE = '/reader/exports-failed'
const CONTENT = (n) => '<div id="content"><p>第' + n + '章正文内容。</p></div>'

function buildToc(count) {
  const items = []
  for (let index = 1; index <= count; index += 1) {
    items.push('<li><a href="/ch/' + index + '">第' + index + '章</a></li>')
  }
  return '<ul class="toc">' + items.join('') + '</ul>'
}

async function makeHarness(options = {}) {
  process.env.MO_READER_CACHE_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-ex-cache-'))
  const exportRoot = await mkdtemp(path.join(tmpdir(), 'mo-ex-out-'))
  process.env.MO_READER_EXPORT_ROOT = exportRoot
  const { ReaderService } = await import('../dist/server/service.js')
  const { writeCachedChapter } = await import('../dist/server/cache.js')
  const sources = fakeTable()
  const books = fakeTable()
  const readRecords = fakeTable()
  const jobs = fakeTable()
  const downloadEntries = fakeTable()
  const bookmarks = fakeTable()
  const notes = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books,
    readRecords,
    jobs,
    downloadEntries,
    bookmarks,
    notes,
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
  books.put('book-1', {
    id: 'book-1',
    name: '测试书',
    author: '某人',
    origin: ORIGIN,
    originName: '测试源',
    bookUrl: ORIGIN + '/book/1',
    tocUrl: ORIGIN + '/toc',
  })
  const chapterCount = options.chapters ?? 0
  const pages = { [ORIGIN + '/toc']: buildToc(chapterCount) }
  for (let index = 1; index <= chapterCount; index += 1) {
    pages[ORIGIN + '/ch/' + index] = CONTENT(index)
  }
  const failUrls = new Set(options.failUrls ?? [])
  const calls = []
  service.fetch = async (request) => {
    calls.push(request.url)
    if (options.delayAll) await new Promise((resolve) => setTimeout(resolve, options.delayAll))
    if (failUrls.has(request.url)) throw new Error('抓取失败：' + request.url)
    const text = pages[request.url]
    if (!text) throw new Error('页面不存在：' + request.url)
    return { text, url: request.url, status: 200 }
  }
  // 宿主注入：webServer 只记录路由，测试直接调用 route.resource。
  const routes = []
  const effectDisposers = []
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
            effectDisposers.push(factory())
          },
        })
      },
    },
  })
  service.registerExportRoute()
  const countOf = (url) => calls.filter((item) => item === url).length
  return {
    service,
    books,
    jobs,
    calls,
    countOf,
    routes,
    effectDisposers,
    exportRoot,
    failUrls,
    writeCachedChapter,
  }
}

async function waitFor(check, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

const owner = { principal: { kind: 'owner' } }

test('导出整本：目录 60 章全部导出，TXT 与旧格式一致', async () => {
  const harness = await makeHarness({ chapters: 60 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  assert.equal(started.existing, false)
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.kind, 'export')
  assert.equal(job.total, 60)
  assert.equal(job.completed, 60)
  assert.equal(job.failed, 0)
  assert.equal(job.skipped, 0)
  assert.ok(job.bytes > 0)
  assert.equal(job.fileName, '测试书.txt')
  assert.equal(job.filePath, started.job.id + '.txt')
  const body = await readFile(path.join(harness.exportRoot, job.filePath), 'utf8')
  assert.ok(body.startsWith('测试书\n作者：某人\n\n第1章\n\n第1章正文内容。'))
  assert.equal((body.match(/章正文内容/g) ?? []).length, 60)
  assert.ok(body.includes('第60章正文内容。'))
  const download = await harness.service.getExportDownload({ jobId: job.id })
  assert.equal(download.url, BASE + ROUTE + '/' + job.id)
  assert.equal(download.fileName, '测试书.txt')
})

test('导出缓存优先：已缓存章节不再联网', async () => {
  const harness = await makeHarness({ chapters: 3 })
  await harness.writeCachedChapter(ORIGIN, ORIGIN + '/ch/1', '缓存章节一')
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  assert.equal(harness.countOf(ORIGIN + '/ch/1'), 0)
  assert.equal(harness.countOf(ORIGIN + '/ch/2'), 1)
  const body = await readFile(path.join(harness.exportRoot, started.job.id + '.txt'), 'utf8')
  assert.ok(body.includes('缓存章节一'))
})

test('单章失败只计失败，整本继续导出', async () => {
  const harness = await makeHarness({ chapters: 3, failUrls: [ORIGIN + '/ch/2'] })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 2)
  assert.equal(job.failed, 1)
  assert.deepEqual(job.failedChapters, ['第2章'], '记下没导出的章节名')
  assert.equal(job.failedTruncated, false, '失败数没超过上限就不生成清单')
  assert.equal(job.failedListFile, '')
  await assert.rejects(harness.service.getExportFailedDownload({ jobId: job.id }), /没有可下载的失败清单/)
  const body = await readFile(path.join(harness.exportRoot, job.filePath), 'utf8')
  assert.ok(body.includes('第1章正文内容。'))
  assert.ok(!body.includes('第2章正文内容。'))
  assert.ok(body.includes('第3章正文内容。'))
})

test('暂停后继续：已完成章节不重新抓取，只补缺的分片', async () => {
  const harness = await makeHarness({ chapters: 8, delayAll: 25 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await waitFor(async () => ((await harness.service.getJob({ id: started.job.id })).job.completed ?? 0) >= 2)
  await harness.service.pauseJob({ id: started.job.id })
  await harness.service.waitForExports()
  const paused = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(paused.status, 'paused')
  const reuse = Number(paused.completed)
  assert.ok(reuse >= 2)
  // 暂停时保留章节级临时状态，「继续」才有依据。
  const partsDir = started.job.id + '.parts'
  assert.ok((await readdir(harness.exportRoot)).includes(partsDir), '暂停时保留章节级临时状态')
  const parts = (await readdir(path.join(harness.exportRoot, partsDir)))
    .map((name) => Number(name.replace(/\.json$/, '')))
    .sort((left, right) => left - right)
  assert.ok(parts.length >= 1, '至少有一章的分片落盘')
  assert.ok(parts.length <= reuse, '分片数不超过已完成数')

  // 清掉章节缓存：首轮抓到的正文已经回写缓存，不清掉的话「继续」即使不复用分片也能零联网，
  // 断言就变成了假绿。清掉之后，只有真正复用了分片的章节才不需要重新抓。
  const { clearChapterCache } = await import('../dist/server/cache.js')
  await clearChapterCache('')

  const before = harness.calls.length
  await harness.service.resumeJob({ id: started.job.id })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 8)
  assert.equal(job.failed, 0)
  // 恢复时只为没有分片的章节联网：有分片的不联网、没分片的一定联网，一次不多一次不少。
  const refetched = harness.calls
    .slice(before)
    .filter((item) => item.startsWith(ORIGIN + '/ch/'))
    .map((item) => Number(item.split('/').pop()))
    .sort((left, right) => left - right)
  const missing = Array.from({ length: 8 }, (_, index) => index)
    .filter((index) => !parts.includes(index))
    .map((index) => index + 1)
  assert.deepEqual(refetched, missing, '续跑只补没有分片的章节')
  // 产物包含全部章节，且分段拼装没有空洞。
  const body = await readFile(path.join(harness.exportRoot, job.filePath), 'utf8')
  for (let i = 1; i <= 8; i += 1) assert.ok(body.includes('第' + i + '章正文内容。'), '产物含第' + i + '章')
  // 终态不留临时状态。
  assert.ok(!(await readdir(harness.exportRoot)).includes(partsDir))
})

test('暂停后取消：章节级临时状态被清掉', async () => {
  const harness = await makeHarness({ chapters: 8, delayAll: 25 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await waitFor(async () => ((await harness.service.getJob({ id: started.job.id })).job.completed ?? 0) >= 2)
  await harness.service.pauseJob({ id: started.job.id })
  await harness.service.waitForExports()
  const partsDir = started.job.id + '.parts'
  assert.ok((await readdir(harness.exportRoot)).includes(partsDir), '暂停时保留临时状态')
  // 暂停态的协程已经收尾，取消之后不会再有协程来清理，清理必须在取消这一侧完成。
  await harness.service.cancelJob({ id: started.job.id })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'cancelled')
  const names = await readdir(harness.exportRoot)
  assert.ok(!names.includes(partsDir), '取消后不留章节级临时状态')
})

test('重新导出后失败数没超上限：上一轮的失败清单被清掉', async () => {
  const chapters = 120
  const harness = await makeHarness({
    chapters,
    failUrls: Array.from({ length: chapters }, (_, index) => ORIGIN + '/ch/' + (index + 1)),
  })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const first = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(first.status, 'failed')
  assert.equal(first.failedTruncated, true)
  const listName = started.job.id + '.failed.txt'
  assert.ok((await readdir(harness.exportRoot)).includes(listName))

  harness.failUrls.clear()
  await harness.service.resumeJob({ id: started.job.id })
  await harness.service.waitForExports()
  const second = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(second.status, 'done')
  assert.equal(second.failed, 0)
  assert.equal(second.failedTruncated, false)
  assert.equal(second.failedListFile, '')
  assert.ok(!(await readdir(harness.exportRoot)).includes(listName), '旧清单不能留到 24 小时清理')
})

test('导出抓到的正文回写缓存，导出后阅读直接命中', async () => {
  const harness = await makeHarness({ chapters: 2 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const { readCachedChapter } = await import('../dist/server/cache.js')
  assert.equal(await readCachedChapter(ORIGIN, ORIGIN + '/ch/1'), '第1章正文内容。')
  assert.equal(await readCachedChapter(ORIGIN, ORIGIN + '/ch/2'), '第2章正文内容。')
  // 索引也补登了：下载统计里能看到这两章。
  const entries = [...harness.service.db.downloadEntries.map.values()]
  assert.deepEqual(
    entries.map((entry) => entry.chapterIndex).sort(),
    [0, 1],
  )
  // 再导一次走缓存：目录可能还要各取一次，但章节一个都不再抓。
  const chapterCalls = () => harness.calls.filter((url) => url.startsWith(ORIGIN + '/ch/')).length
  const before = chapterCalls()
  const again = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  assert.equal(chapterCalls(), before, '第二次导出全部命中缓存')
  assert.equal((await harness.service.getJob({ id: again.job.id })).job.completed, 2)
})

test('全部章节失败时作业失败且不留产物', async () => {
  const harness = await makeHarness({ chapters: 2, failUrls: [ORIGIN + '/ch/1', ORIGIN + '/ch/2'] })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.error, '全部章节导出失败')
  assert.equal(job.completed, 0)
  assert.equal(job.failed, 2)
  await assert.rejects(harness.service.getExportDownload({ jobId: job.id }), /导出尚未完成/)
  assert.deepEqual((await readdir(harness.exportRoot)).filter((name) => name.endsWith('.txt')), [])
})

test('失败章节超过展示上限：完整清单可下载、路由受保护', async () => {
  const total = 120
  const failUrls = Array.from({ length: total }, (_, index) => ORIGIN + '/ch/' + (index + 1))
  const harness = await makeHarness({ chapters: total, failUrls })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.failed, total, '失败数量始终是真实值')
  assert.equal(job.failedChapters.length, 100, '作业记录里只留 100 条')
  assert.equal(job.failedTruncated, true)
  assert.equal(job.failedListFile, job.id + '.failed.txt')
  const body = await readFile(path.join(harness.exportRoot, job.failedListFile), 'utf8')
  const lines = body.trim().split('\n')
  assert.equal(lines.length, total)
  assert.equal(lines[0], '1\t第1章')
  assert.equal(lines[total - 1], total + '\t第' + total + '章')

  const download = await harness.service.getExportFailedDownload({ jobId: job.id })
  assert.equal(download.url, BASE + FAILED_ROUTE + '/' + job.id)
  assert.equal(download.fileName, '测试书-失败章节.txt', '下载名用书名，不甩作业 id')

  const route = harness.routes.find((item) => item.path === FAILED_ROUTE)
  assert.ok(route, '失败清单路由已注册')
  const response = await route.resource(new Request(BASE + FAILED_ROUTE + '/' + job.id), owner)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/plain/)
  assert.equal((await response.text()).trim().split('\n').length, total)
  assert.equal((await route.resource(new Request(BASE + FAILED_ROUTE + '/' + job.id))).status, 401)
  assert.equal(
    (await route.resource(new Request(BASE + FAILED_ROUTE + '/00000000-0000-4000-8000-000000000000'), owner)).status,
    404,
  )
})

test('同一本书同一格式同时只有一个活动作业', async () => {
  const harness = await makeHarness({ chapters: 5, delayAll: 10 })
  const first = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  const second = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  assert.equal(second.existing, true)
  assert.equal(second.job.id, first.job.id)
  await harness.service.waitForExports()
  const after = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  assert.equal(after.existing, false)
  assert.notEqual(after.job.id, first.job.id)
  await harness.service.waitForExports()
})

test('导出可取消：作业置取消、不留产物', async () => {
  const harness = await makeHarness({ chapters: 30, delayAll: 20 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await waitFor(async () => (await harness.service.getJob({ id: started.job.id })).job.status === 'running')
  const cancelled = await harness.service.cancelJob({ id: started.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'cancelled')
  assert.deepEqual((await readdir(harness.exportRoot)).filter((name) => name.endsWith('.txt')), [])
  assert.ok(!(await readdir(harness.exportRoot)).some((name) => name.endsWith('.parts')), '取消后清理章节级临时状态')
})

test('作业进度可查，listJobs 同时返回下载与导出', async () => {
  const harness = await makeHarness({ chapters: 3 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.completed, 3)
  assert.ok(job.bytes > 0)
  const now = Date.now()
  await harness.jobs.put('dl-1', {
    id: 'dl-1',
    kind: 'download',
    bookId: 'book-1',
    bookName: '测试书',
    status: 'done',
    fromIndex: 0,
    toIndex: 0,
    all: true,
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    bytes: 10,
    error: '',
    createdAt: now,
    updatedAt: now,
  })
  const { jobs } = await harness.service.listJobs({ bookId: 'book-1' })
  assert.deepEqual(jobs.map((item) => item.kind).sort(), ['download', 'export'])
})

test('24 小时清理：删过期产物与过期作业，保留活动作业', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const { cleanupExpiredExports } = await import('../dist/server/exports.js')
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
  const oldFile = path.join(harness.exportRoot, 'old.txt')
  await writeFile(oldFile, 'old')
  await utimes(oldFile, oldTime, oldTime)
  await writeFile(path.join(harness.exportRoot, 'fresh.txt'), 'fresh')
  const now = Date.now()
  const base = {
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    bytes: 3,
    error: '',
    fromIndex: 0,
    toIndex: 0,
    all: true,
    createdAt: now,
    updatedAt: now - 25 * 60 * 60 * 1000,
  }
  await harness.jobs.put('old-job', { ...base, id: 'old-job', kind: 'export', bookId: 'book-1', status: 'done' })
  await harness.jobs.put('live-job', { ...base, id: 'live-job', kind: 'export', bookId: 'book-2', status: 'running' })
  await harness.jobs.put('dl-old', { ...base, id: 'dl-old', kind: 'download', bookId: 'book-3', status: 'paused' })
  const result = await cleanupExpiredExports(harness.jobs)
  assert.equal(result.files, 1)
  assert.equal(result.jobs, 1)
  const names = await readdir(harness.exportRoot)
  assert.ok(!names.includes('old.txt'))
  assert.ok(names.includes('fresh.txt'))
  assert.equal(harness.jobs.get('old-job'), undefined)
  assert.ok(harness.jobs.get('live-job'))
  assert.ok(harness.jobs.get('dl-old'))
})

test('发起导出前顺带清理过期产物', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
  const stale = path.join(harness.exportRoot, 'stale-job.txt')
  await writeFile(stale, 'stale')
  await utimes(stale, oldTime, oldTime)
  const now = Date.now()
  await harness.jobs.put('stale-job', {
    id: 'stale-job',
    kind: 'export',
    bookId: 'book-9',
    bookName: '旧书',
    status: 'done',
    format: 'txt',
    filePath: 'stale-job.txt',
    fileName: '旧书.txt',
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    bytes: 5,
    error: '',
    fromIndex: 0,
    toIndex: 0,
    all: true,
    createdAt: now,
    updatedAt: oldTime.getTime(),
  })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  assert.equal((await harness.service.getJob({ id: started.job.id })).job.status, 'done')
  assert.equal(harness.jobs.get('stale-job'), undefined)
  assert.ok(!(await readdir(harness.exportRoot)).includes('stale-job.txt'))
})

test('受保护路由：200 返回文件与下载头', async () => {
  const harness = await makeHarness({ chapters: 2 })
  const route = harness.routes.find((item) => item.path === ROUTE)
  assert.ok(route, '导出产物路由已注册')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, ROUTE)
  assert.equal(route.auth, 'required')
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const response = await route.resource(new Request(BASE + ROUTE + '/' + started.job.id), owner)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  const disposition = response.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^attachment; filename="/)
  assert.ok(disposition.includes("filename*=UTF-8''" + encodeURIComponent('测试书.txt')))
  assert.equal(response.headers.get('cache-control'), 'private, max-age=0')
  const text = await response.text()
  assert.ok(text.includes('第1章正文内容。'))
  assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(text))
})

test('受保护路由：未登录 401、非属主 403', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const route = harness.routes.find((item) => item.path === ROUTE)
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const url = BASE + ROUTE + '/' + started.job.id
  const anonymous = await route.resource(new Request(url))
  assert.equal(anonymous.status, 401)
  const denied = await route.resource(new Request(url), { principal: { kind: 'guest' } })
  assert.equal(denied.status, 403)
})

test('受保护路由：非法 id、穿越路径与不存在作业都是 404', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const route = harness.routes.find((item) => item.path === ROUTE)
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const request = (pathname) => new Request(BASE + pathname)
  assert.equal((await route.resource(request(ROUTE + '/'), owner)).status, 404)
  assert.equal((await route.resource(request(ROUTE + '/..%2F..%2Fetc%2Fpasswd'), owner)).status, 404)
  assert.equal((await route.resource(request(ROUTE + '/..%2F' + started.job.id), owner)).status, 404)
  assert.equal((await route.resource(request(ROUTE + '/' + started.job.id + '/extra'), owner)).status, 404)
  assert.equal((await route.resource(request(ROUTE + '/00000000-0000-4000-8000-000000000000'), owner)).status, 404)
})

test('受保护路由：作业记录的相对路径越过导出目录时 404', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const { registerArtifactRoute } = await import('../dist/server/routes.js')
  const routes = []
  registerArtifactRoute(
    {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    {
      root: () => harness.exportRoot,
      locate: () => ({ filePath: '../escape.txt', fileName: 'escape.txt', contentType: 'text/plain' }),
    },
  )
  const response = await routes[0].resource(
    new Request(BASE + ROUTE + '/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
    owner,
  )
  assert.equal(response.status, 404)
})

test('受保护路由：HEAD 只回头、其他方法 405', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const route = harness.routes.find((item) => item.path === ROUTE)
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await harness.service.waitForExports()
  const url = BASE + ROUTE + '/' + started.job.id
  const head = await route.resource(new Request(url, { method: 'HEAD' }), owner)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.ok(Number(head.headers.get('content-length')) > 0)
  const post = await route.resource(new Request(url, { method: 'POST', body: 'x' }), owner)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
})

test('导出地址只在完成后给出，产物过期报错', async () => {
  const harness = await makeHarness({ chapters: 1 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'txt' })
  await assert.rejects(harness.service.getExportDownload({ jobId: started.job.id }), /导出尚未完成/)
  await harness.service.waitForExports()
  assert.ok((await harness.service.getExportDownload({ jobId: started.job.id })).url)
  const record = harness.jobs.get(started.job.id)
  await harness.jobs.put(started.job.id, { ...record, filePath: 'gone.txt' })
  await assert.rejects(harness.service.getExportDownload({ jobId: started.job.id }), /导出文件已过期/)
  await assert.rejects(harness.service.getExportDownload({ jobId: 'nope' }), /作业不存在/)
})

test('暂不支持的导出格式直接拒绝', async () => {
  const harness = await makeHarness({ chapters: 1 })
  await assert.rejects(
    harness.service.startExport({ bookId: 'book-1', format: 'mobi' }),
    /暂只支持 TXT \/ EPUB \/ PDF 导出/,
  )
})

// 1x1 透明 PNG：封面测试只关心字节原样嵌入，不需要真实图片内容。
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f6a0000000049454e44ae426082',
  'hex',
)

async function readEntry(zip, name) {
  const entry = zip.file(name)
  assert.ok(entry, '缺少 ' + name)
  return entry.async('string')
}

test('EPUB 全本：目录 60 章全部导出，nav 与 ncx 可跳转', async () => {
  const harness = await makeHarness({ chapters: 60 })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'epub' })
  assert.equal(started.job.format, 'epub')
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.total, 60)
  assert.equal(job.completed, 60)
  assert.equal(job.failed, 0)
  assert.equal(job.fileName, '测试书.epub')
  assert.equal(job.filePath, started.job.id + '.epub')

  const data = await readFile(path.join(harness.exportRoot, job.filePath))
  const zip = await JSZip.loadAsync(data)
  assert.equal(await readEntry(zip, 'mimetype'), 'application/epub+zip')
  assert.match(await readEntry(zip, 'META-INF/container.xml'), /full-path="OEBPS\/content\.opf"/)
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.match(opf, /<dc:title>测试书<\/dc:title>/)
  assert.match(opf, /<dc:creator>某人<\/dc:creator>/)
  assert.ok(!opf.includes('name="cover"'))
  const nav = await readEntry(zip, 'OEBPS/nav.xhtml')
  assert.equal((nav.match(/<li><a href="chapter\d+\.xhtml">/g) ?? []).length, 60)
  assert.ok(nav.includes('第60章'))
  const ncx = await readEntry(zip, 'OEBPS/toc.ncx')
  assert.equal((ncx.match(/<navPoint /g) ?? []).length, 60)
  assert.match(await readEntry(zip, 'OEBPS/chapter60.xhtml'), /第60章正文内容/)

  const download = await harness.service.getExportDownload({ jobId: job.id })
  assert.equal(download.url, BASE + ROUTE + '/' + job.id)
  assert.equal(download.fileName, '测试书.epub')
  const route = harness.routes.find((item) => item.path === ROUTE)
  const response = await route.resource(new Request(BASE + ROUTE + '/' + job.id), owner)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/epub+zip')
})

test('EPUB 缺作者：opf 不输出 dc:creator', async () => {
  const harness = await makeHarness({ chapters: 1 })
  harness.books.put('book-1', { ...harness.books.get('book-1'), author: '' })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'epub' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const zip = await JSZip.loadAsync(await readFile(path.join(harness.exportRoot, job.filePath)))
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.ok(!opf.includes('dc:creator'))
  assert.ok(!opf.includes('未知作者'))
  assert.match(opf, /<dc:title>测试书<\/dc:title>/)
})

test('EPUB 封面：data URL 直接内嵌，封面页在 spine 首位', async () => {
  const harness = await makeHarness({ chapters: 2 })
  harness.books.put('book-1', {
    ...harness.books.get('book-1'),
    coverUrl: 'data:image/png;base64,' + PNG_1X1.toString('base64'),
  })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'epub' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const zip = await JSZip.loadAsync(await readFile(path.join(harness.exportRoot, job.filePath)))
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.match(opf, /<meta name="cover" content="cover-image"\/>/)
  assert.match(opf, /<item id="cover-image" href="cover\.png" media-type="image\/png" properties="cover-image"\/>/)
  assert.match(await readEntry(zip, 'OEBPS/cover.xhtml'), /<img src="cover\.png"/)
  assert.deepEqual(await zip.file('OEBPS/cover.png').async('nodebuffer'), PNG_1X1)
  const spine = opf.slice(opf.indexOf('<spine'))
  assert.ok(spine.indexOf('idref="cover-page"') < spine.indexOf('idref="chapter1"'))
})

test('EPUB 封面抓取失败：跳过封面，导出照常完成', async () => {
  const harness = await makeHarness({ chapters: 2 })
  harness.books.put('book-1', { ...harness.books.get('book-1'), coverUrl: 'https://cdn.example.com/cover.jpg' })
  harness.service.fetchExportCover = async () => {
    throw new Error('封面抓取失败')
  }
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'epub' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const zip = await JSZip.loadAsync(await readFile(path.join(harness.exportRoot, job.filePath)))
  const opf = await readEntry(zip, 'OEBPS/content.opf')
  assert.ok(!opf.includes('name="cover"'))
  assert.equal(zip.file('OEBPS/cover.jpg'), null)
  assert.match(await readEntry(zip, 'OEBPS/chapter2.xhtml'), /第2章正文内容/)
})

test('EPUB 单章失败：不中止，失败计数可见，导航只列成功章节', async () => {
  const harness = await makeHarness({ chapters: 3, failUrls: [ORIGIN + '/ch/2'] })
  const started = await harness.service.startExport({ bookId: 'book-1', format: 'epub' })
  await harness.service.waitForExports()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 2)
  assert.equal(job.failed, 1)
  const zip = await JSZip.loadAsync(await readFile(path.join(harness.exportRoot, job.filePath)))
  const nav = await readEntry(zip, 'OEBPS/nav.xhtml')
  assert.equal((nav.match(/<li><a href="chapter\d+\.xhtml">/g) ?? []).length, 2)
  assert.ok(!nav.includes('第2章'))
  assert.match(await readEntry(zip, 'OEBPS/chapter2.xhtml'), /第3章正文内容/)
})

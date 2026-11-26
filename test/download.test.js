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

const ORIGIN = 'https://dl.example.com'
const CONTENT = (n) => `<div id="content"><p>第${n}章正文内容。</p></div>`
const TOC = [
  '<ul class="toc">',
  '  <li>第一卷 起源</li>',
  '  <li><a href="/ch/1">第1章</a></li>',
  '  <li><a href="/ch/2">第2章</a></li>',
  '  <li><a href="">第3章 未发布</a></li>',
  '</ul>',
].join('')

function buildToc(count) {
  const items = []
  for (let index = 1; index <= count; index += 1) {
    items.push(`<li><a href="/ch/${index}">第${index}章</a></li>`)
  }
  return `<ul class="toc">${items.join('')}</ul>`
}

async function makeHarness(options = {}) {
  process.env.MO_READER_CACHE_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-dl-cache-'))
  const { ReaderService } = await import('../dist/server/service.js')
  const { readCachedChapter } = await import('../dist/server/cache.js')
  const sources = fakeTable()
  const books = fakeTable()
  const readRecords = fakeTable()
  const jobs = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books,
    readRecords,
    jobs,
    chapters: fakeTable(),
    settings: { get: () => ({ theme: 'system', fontSize: 24, lineSpacing: 1.9 }), set: async () => {} },
  }
  service.downloadRetryBaseMs = 1
  sources.put('s1', {
    bookSourceUrl: ORIGIN,
    bookSourceName: '测试源',
    ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text||text', chapterUrl: 'a@href' },
    ruleContent: { content: 'id.content@text' },
    ...(options.source ?? {}),
  })
  books.put('book-1', {
    id: 'book-1',
    name: '测试书',
    author: '某人',
    origin: ORIGIN,
    originName: '测试源',
    bookUrl: `${ORIGIN}/book/1`,
    tocUrl: `${ORIGIN}/toc`,
  })
  const chapterCount = options.chapters ?? 0
  const toc = options.toc ?? (chapterCount ? buildToc(chapterCount) : TOC)
  const pages = {
    [`${ORIGIN}/toc`]: toc,
    [`${ORIGIN}/ch/1`]: CONTENT(1),
    [`${ORIGIN}/ch/2`]: CONTENT(2),
    ...(options.pages ?? {}),
  }
  for (let index = 3; index <= chapterCount; index += 1) {
    pages[`${ORIGIN}/ch/${index}`] = CONTENT(index)
  }
  const calls = []
  const delays = options.delays ?? {}
  service.fetch = async (request) => {
    calls.push(request.url)
    const delay = delays[request.url] ?? 0
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    const text = pages[request.url]
    if (!text) throw new Error(`页面不存在：${request.url}`)
    return { text, url: request.url, status: 200 }
  }
  const countOf = (url) => calls.filter((item) => item === url).length
  return { service, books, jobs, calls, countOf, pages, readCachedChapter }
}

test('整本下载：完成计数、跳过卷标题与空地址、正文写入缓存', async () => {
  const harness = await makeHarness()
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  assert.equal(started.existing, false)
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.total, 4)
  assert.equal(job.completed, 2)
  assert.equal(job.failed, 0)
  assert.equal(job.skipped, 2)
  assert.ok(job.bytes > 0)
  const cached = await harness.readCachedChapter(ORIGIN, `${ORIGIN}/ch/1`)
  assert.match(cached ?? '', /第1章正文内容/)
  const before = harness.countOf(`${ORIGIN}/ch/1`)
  const content = await harness.service.getContent({ sourceUrl: ORIGIN, chapterUrl: `${ORIGIN}/ch/1` })
  assert.equal(content.cached, true)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), before)
})

async function waitFor(check, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

test('默认从当前阅读章下到末尾', async () => {
  const harness = await makeHarness()
  harness.service.db.readRecords.put('book-1', { id: 'book-1', bookId: 'book-1', chapterIndex: 1 })
  const started = await harness.service.startDownload({ bookId: 'book-1' })
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.fromIndex, 1)
  assert.equal(job.toIndex, 3)
  assert.equal(job.total, 3)
  assert.equal(job.completed, 2)
  assert.equal(job.skipped, 1)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 1)
})

test('自定义起止章节只下区间，非法区间报错', async () => {
  const harness = await makeHarness()
  await assert.rejects(
    () => harness.service.startDownload({ bookId: 'book-1', fromIndex: 3, toIndex: 1 }),
    /起止章节无效/,
  )
  const started = await harness.service.startDownload({ bookId: 'book-1', fromIndex: 2, toIndex: 2 })
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.total, 1)
  assert.equal(job.completed, 1)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 0)
  assert.equal(harness.countOf(`${ORIGIN}/ch/2`), 1)
})

test('暂停后继续：已完成章不重下，重复启动返回同一活动作业', async () => {
  const harness = await makeHarness({ delays: { [`${ORIGIN}/ch/2`]: 80 } })
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => (await harness.service.getJob({ id: started.job.id })).job.completed >= 1)

  const paused = await harness.service.pauseJob({ id: started.job.id })
  assert.equal(paused.job.status, 'paused')
  await harness.service.waitForDownloads()

  const duplicate = await harness.service.startDownload({ bookId: 'book-1', all: true })
  assert.equal(duplicate.existing, true)
  assert.equal(duplicate.job.id, started.job.id)
  assert.equal((await harness.service.getJob({ id: started.job.id })).job.status, 'paused')

  const resumed = await harness.service.resumeJob({ id: started.job.id })
  assert.equal(resumed.job.status, 'queued')
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 2)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 1)
  assert.equal(harness.countOf(`${ORIGIN}/ch/2`), 1)
})

test('取消保留已完成章节，缓存仍可读', async () => {
  const harness = await makeHarness({ delays: { [`${ORIGIN}/ch/2`]: 80 } })
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => (await harness.service.getJob({ id: started.job.id })).job.completed >= 1)
  const cancelled = await harness.service.cancelJob({ id: started.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'cancelled')
  assert.ok(job.completed >= 1)
  const cached = await harness.readCachedChapter(ORIGIN, `${ORIGIN}/ch/1`)
  assert.match(cached ?? '', /第1章正文内容/)
})
test('单章失败重试 2 次后继续下一章，失败章可重试补齐', async () => {
  const harness = await makeHarness({ pages: { [`${ORIGIN}/ch/2`]: '' } })
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForDownloads()
  const first = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(first.status, 'done')
  assert.equal(first.completed, 1)
  assert.equal(first.failed, 1)
  assert.equal(first.skipped, 2)
  // 首次 + 2 次重试
  assert.equal(harness.countOf(`${ORIGIN}/ch/2`), 3)

  harness.pages[`${ORIGIN}/ch/2`] = CONTENT(2)
  const retried = await harness.service.retryDownload({ id: started.job.id })
  assert.equal(retried.job.status, 'queued')
  await harness.service.waitForDownloads()
  const second = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(second.status, 'done')
  assert.equal(second.completed, 2)
  assert.equal(second.failed, 0)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 1)
  assert.equal(harness.countOf(`${ORIGIN}/ch/2`), 4)
})

test('非文本章节不重试、计入失败；全部失败时作业失败', async () => {
  const harness = await makeHarness({
    source: { bookSourceType: 2, ruleContent: { content: 'img@src' } },
    pages: {
      [`${ORIGIN}/ch/1`]: '<div id="content"><img src="/img/1.jpg"></div>',
      [`${ORIGIN}/ch/2`]: '<div id="content"><img src="/img/2.jpg"></div>',
    },
  })
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.completed, 0)
  assert.equal(job.failed, 2)
  assert.equal(job.error, '全部章节下载失败')
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 1)
})
test('宿主重启：残留作业标为暂停并注明原因，继续可跑完', async () => {
  const harness = await makeHarness({ delays: { [`${ORIGIN}/ch/2`]: 60 } })
  const { recoverInterruptedJobs } = await import('../dist/server/download.js')
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => (await harness.service.getJob({ id: started.job.id })).job.completed >= 1)
  await harness.service.pauseJob({ id: started.job.id })
  await harness.service.waitForDownloads()

  // 模拟宿主崩溃：记录停在 running。
  const crashed = harness.jobs.map.get(started.job.id)
  harness.jobs.map.set(started.job.id, { ...crashed, status: 'running' })
  const recovered = await recoverInterruptedJobs(harness.jobs)
  assert.equal(recovered, 1)
  const paused = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(paused.status, 'paused')
  assert.equal(paused.error, '宿主重启')

  await harness.service.resumeJob({ id: started.job.id })
  await harness.service.waitForDownloads()
  const finished = (await harness.service.getJob({ id: started.job.id })).job
  assert.equal(finished.status, 'done')
  assert.equal(finished.completed, 2)
  assert.equal(harness.countOf(`${ORIGIN}/ch/1`), 1)
})

test('并发闸门：全局最多 4 章、同一来源最多 2 章', async () => {
  const { ChapterLimiter } = await import('../dist/server/download.js')
  const limiter = new ChapterLimiter(4, 2)
  let active = 0
  let maxActive = 0
  const perSource = new Map()
  const maxPerSource = new Map()
  const task = async (source) => {
    await limiter.acquire(source)
    active += 1
    maxActive = Math.max(maxActive, active)
    const used = (perSource.get(source) ?? 0) + 1
    perSource.set(source, used)
    maxPerSource.set(source, Math.max(maxPerSource.get(source) ?? 0, used))
    await new Promise((resolve) => setTimeout(resolve, 5))
    perSource.set(source, perSource.get(source) - 1)
    active -= 1
    limiter.release(source)
  }
  await Promise.all(['a', 'a', 'a', 'a', 'b', 'b', 'b', 'c', 'c'].map(task))
  assert.equal(maxActive, 4)
  assert.equal(maxPerSource.get('a'), 2)
  assert.equal(maxPerSource.get('b'), 2)
  assert.equal(maxPerSource.get('c'), 2)
})

test('进度落盘节流：12 章作业落盘次数远少于章数', async () => {
  const harness = await makeHarness({ chapters: 12 })
  const originalPut = harness.jobs.put
  let puts = 0
  harness.jobs.put = async (key, value) => {
    puts += 1
    return originalPut(key, value)
  }
  const started = await harness.service.startDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 12)
  assert.ok(puts >= 2 && puts < 12, `落盘次数 ${puts}`)
})

test('缓存 20 章入口与单章下载共用逻辑', async () => {
  const harness = await makeHarness({ chapters: 25 })
  const first = await harness.service.cacheBook({ bookId: 'book-1' })
  assert.equal(first.total, 25)
  assert.equal(first.cached, 20)
  assert.equal(first.failed, 0)
  assert.ok(first.bytes > 0)
  assert.equal(harness.countOf(`${ORIGIN}/ch/21`), 0)
  const second = await harness.service.cacheBook({ bookId: 'book-1' })
  assert.equal(second.cached, 20)
  assert.equal(second.bytes, 0)
  for (let index = 1; index <= 20; index += 1) {
    assert.equal(harness.countOf(`${ORIGIN}/ch/${index}`), 1, `第${index}章只应抓取一次`)
  }
})

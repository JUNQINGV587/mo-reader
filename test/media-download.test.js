import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 媒体离线下载（#112）的服务端测试：全部用假抓取与临时缓存目录，不联网。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */
const BASE = 'https://reader.example.com'
/** 公网 IP 字面量：代理登记时 SSRF 守卫不做 DNS。 */
const HOST = 'https://93.184.216.34'
const owner = { principal: { kind: 'owner' } }

const IMAGE_TOC = [
  '<ul class="toc">',
  '  <li><a href="/ch/1">第1章</a></li>',
  '  <li><a href="/ch/2">第2章</a></li>',
  '</ul>',
].join('')

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

function responseOf(data, type) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data))
  return () => ({
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': type, 'content-length': String(body.length) },
    }),
    finalUrl: 'https://93.184.216.34/media',
  })
}

function mountCtx(service, routes = []) {
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
      inject: (_deps, callback) => {
        callback({
          webServer,
          effect: (factory) => {
            factory()
          },
        })
      },
    },
  })
}

async function makeHarness(options = {}) {
  process.env.MO_READER_MEDIA_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-media-'))
  process.env.MO_READER_CACHE_ROOT = process.env.MO_READER_MEDIA_ROOT
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  const books = fakeTable()
  const readRecords = fakeTable()
  const jobs = fakeTable()
  const mediaEntries = fakeTable()
  const downloadEntries = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books,
    readRecords,
    jobs,
    mediaEntries,
    downloadEntries,
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    settings: { get: () => ({}), set: async () => {} },
  }
  service.downloadRetryBaseMs = 1
  mountCtx(service)
  const sourceUrl = options.sourceUrl ?? HOST
  sources.put('s1', {
    bookSourceUrl: sourceUrl,
    bookSourceName: '测试源',
    bookSourceType: options.type ?? 2,
    ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text||text', chapterUrl: 'a@href' },
    ruleContent: { content: options.contentRule ?? 'img@src' },
    header: options.header ?? '',
  })
  const bookId = options.bookId ?? 'book-1'
  books.put(bookId, {
    id: bookId,
    name: '测试书',
    origin: sourceUrl,
    bookUrl: `${sourceUrl}/book/1`,
    tocUrl: `${sourceUrl}/toc`,
    type: options.type ?? 2,
  })
  const pages = {
    [`${sourceUrl}/toc`]: options.toc ?? IMAGE_TOC,
    ...(options.pages ?? {}),
  }
  const fetched = []
  service.fetch = async (request) => {
    fetched.push(request.url)
    const text = pages[request.url]
    if (text === undefined) throw new Error(`页面不存在：${request.url}`)
    return { text, url: request.url, status: 200 }
  }
  const opened = []
  const opener = options.opener ?? (async (url) => responseOf(Buffer.from(`data:${url}`), 'image/jpeg')())
  service.mediaStreamOpener = async (url, streamOptions) => {
    opened.push({ url, options: streamOptions })
    return opener(url, streamOptions)
  }
  return { service, books, jobs, mediaEntries, sources, sourceUrl, bookId, pages, fetched, opened }
}

async function waitFor(check, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

function imagePages(sourceUrl, chapters = 2, images = 2) {
  const pages = {}
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    const tags = []
    for (let index = 1; index <= images; index += 1) {
      tags.push(`<img src="/img/${chapter}-${index}.jpg">`)
    }
    pages[`${sourceUrl}/ch/${chapter}`] = `<div id="content">${tags.join('')}</div>`
  }
  return pages
}

test('漫画整章下载：全部图片落盘后才发布索引，阅读返回本地地址', async () => {
  const harness = await makeHarness({ pages: imagePages(HOST) })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  assert.equal(started.existing, false)
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.kind, 'media-download')
  assert.equal(job.mediaKind, 'image')
  assert.equal(job.completed, 2)
  assert.equal(job.failed, 0)
  assert.equal(job.skipped, 0)
  assert.ok(job.bytes > 0)

  const entries = [...harness.mediaEntries.entries()]
  assert.equal(entries.length, 2)
  for (const [, entry] of entries) {
    assert.equal(entry.kind, 'image')
    assert.equal(entry.files.length, 2)
    for (const file of entry.files) {
      assert.match(file.id, /^[0-9a-f]{24}$/)
      const data = await readFile(path.join(process.env.MO_READER_MEDIA_ROOT, file.path))
      assert.ok(data.length > 0)
    }
  }

  const before = harness.fetched.length
  const content = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
  })
  assert.equal(content.kind, 'images')
  assert.equal(content.local, true)
  assert.equal(content.images.length, 2)
  for (const image of content.images) {
    assert.ok(image.startsWith(`${BASE}/reader/media-local/`), image)
  }
  assert.equal(harness.fetched.length, before, '本地命中不应再抓章节页')
})

test('音频按单个文件下载；无本地时回退在线代理，preferOnline 强制在线', async () => {
  const harness = await makeHarness({
    type: 1,
    contentRule: 'audio@src',
    toc: '<ul class="toc"><li><a href="/ch/1">第1章</a></li></ul>',
    pages: {
      [`${HOST}/ch/1`]: '<div id="content"><audio src="/media/a.mp3"></audio></div>',
    },
    opener: async () => responseOf(Buffer.from('mp3-bytes'), 'audio/mpeg')(),
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.mediaKind, 'audio')
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.equal(entry.kind, 'audio')
  assert.equal(entry.files.length, 1)
  assert.equal(entry.mime, 'audio/mpeg')

  const local = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
  })
  assert.equal(local.kind, 'audio')
  assert.equal(local.local, true)
  assert.ok(local.mediaUrl.startsWith(`${BASE}/reader/media-local/`))

  const online = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
    preferOnline: true,
  })
  assert.notEqual(online.local, true)
  assert.ok(online.mediaUrl.startsWith(`${BASE}/reader/media/`), online.mediaUrl)
})

test('暂停/继续：暂停后不再推进，继续后跑完', async () => {
  let gate = null
  const blocked = new Promise((resolve) => {
    gate = resolve
  })
  const harness = await makeHarness({
    pages: imagePages(HOST, 2, 1),
    opener: async (url) => {
      if (url.endsWith('/img/1-1.jpg')) await blocked
      return responseOf(Buffer.from(url), 'image/jpeg')()
    },
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => {
    const { job } = await harness.service.getJob({ id: started.job.id })
    return job.status === 'running'
  })
  const paused = await harness.service.pauseJob({ id: started.job.id })
  assert.equal(paused.job.status, 'paused')
  gate()
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'paused')
  // 未跑完的章节（第 1 章被阻塞）不发布索引。
  for (const [, entry] of harness.mediaEntries.entries()) assert.notEqual(entry.chapterIndex, 0)

  await harness.service.resumeJob({ id: started.job.id })
  await harness.service.waitForMediaDownloads()
  const { job: done } = await harness.service.getJob({ id: started.job.id })
  assert.equal(done.status, 'done')
  assert.equal(done.completed, 2)
  assert.equal(harness.mediaEntries.map.size, 2)
})

test('续跑/重跑跳过已离线章节，不重复抓取', async () => {
  const harness = await makeHarness({ pages: imagePages(HOST, 2, 1) })
  const first = await harness.service.startMediaDownload({ bookId: 'book-1', fromIndex: 0, toIndex: 0 })
  await harness.service.waitForMediaDownloads()
  const { job: firstJob } = await harness.service.getJob({ id: first.job.id })
  assert.equal(firstJob.status, 'done')

  const second = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job: secondJob } = await harness.service.getJob({ id: second.job.id })
  assert.equal(secondJob.status, 'done')
  assert.equal(secondJob.completed, 2)
  // 第 1 章第一次已离线，第二次整本下载不应再抓；第 2 章才需要新抓一次。
  const reused = harness.opened.filter((item) => item.url.endsWith('/img/1-1.jpg'))
  assert.equal(reused.length, 1)
  const fresh = harness.opened.filter((item) => item.url.endsWith('/img/2-1.jpg'))
  assert.equal(fresh.length, 1)
})

test('取消：作业终止且不发布半成品索引；重试后可再跑', async () => {
  let gate = null
  const blocked = new Promise((resolve) => {
    gate = resolve
  })
  const harness = await makeHarness({
    pages: imagePages(HOST, 2, 1),
    opener: async (url) => {
      if (url.endsWith('/img/1-1.jpg')) await blocked
      return responseOf(Buffer.from(url), 'image/jpeg')()
    },
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => {
    const { job } = await harness.service.getJob({ id: started.job.id })
    return job.status === 'running'
  })
  const cancelled = await harness.service.cancelJob({ id: started.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  gate()
  await harness.service.waitForMediaDownloads()
  for (const [, entry] of harness.mediaEntries.entries()) assert.notEqual(entry.chapterIndex, 0)

  const retried = await harness.service.retryDownload({ id: started.job.id })
  assert.equal(retried.job.status, 'queued')
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(harness.mediaEntries.map.size, 2)
})

test('章节失败：全部重试仍失败则作业失败且不发布索引；修复后重试成功', async () => {
  let broken = true
  const harness = await makeHarness({
    toc: '<ul class="toc"><li><a href="/ch/1">第1章</a></li></ul>',
    pages: { [`${HOST}/ch/1`]: '<div id="content"><img src="/img/1.jpg"></div>' },
    opener: async (url) => {
      if (broken) throw new Error('断流')
      return responseOf(Buffer.from(url), 'image/jpeg')()
    },
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.failed, 1)
  assert.equal(harness.mediaEntries.map.size, 0)

  // 失败后没有可播索引，阅读回退在线。
  const online = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
  })
  assert.notEqual(online.local, true)

  broken = false
  await harness.service.retryDownload({ id: started.job.id })
  await harness.service.waitForMediaDownloads()
  const { job: done } = await harness.service.getJob({ id: started.job.id })
  assert.equal(done.status, 'done')
  assert.equal(harness.mediaEntries.map.size, 1)
})

test('同一本书同一媒体类型只有一个活动作业', async () => {
  let gate = null
  const blocked = new Promise((resolve) => {
    gate = resolve
  })
  const harness = await makeHarness({
    pages: imagePages(HOST, 1, 1),
    opener: async () => {
      await blocked
      return responseOf(Buffer.from('img'), 'image/jpeg')()
    },
  })
  const first = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  const second = await harness.service.startMediaDownload({ bookId: 'book-1', fromIndex: 0, toIndex: 0 })
  assert.equal(second.existing, true)
  assert.equal(second.job.id, first.job.id)
  const listed = await harness.service.listJobs({ bookId: 'book-1' })
  assert.equal(listed.jobs.length, 1)
  gate()
  await harness.service.waitForMediaDownloads()
})

test('重启恢复：running/queued 的媒体作业变 paused 并注明宿主重启', async () => {
  const harness = await makeHarness()
  const { recoverInterruptedJobs } = await import('../dist/server/download.js')
  await harness.jobs.put('job-media', {
    id: 'job-media',
    kind: 'media-download',
    mediaKind: 'image',
    bookId: 'book-1',
    status: 'running',
    updatedAt: 1,
  })
  await harness.jobs.put('job-text', { id: 'job-text', kind: 'download', bookId: 'book-1', status: 'queued' })
  const changed = await recoverInterruptedJobs(harness.jobs)
  assert.equal(changed, 2)
  for (const id of ['job-media', 'job-text']) {
    const record = harness.jobs.get(id)
    assert.equal(record.status, 'paused')
    assert.equal(record.error, '宿主重启')
  }
})

test('HLS 章节跳过而不是失败', async () => {
  const harness = await makeHarness({
    type: 4,
    contentRule: 'video@src',
    toc: '<ul class="toc"><li><a href="/ch/1">第1章</a></li></ul>',
    pages: { [`${HOST}/ch/1`]: '<div id="content"><video src="/media/a.m3u8"></video></div>' },
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.skipped, 1)
  assert.equal(job.completed, 0)
  assert.equal(job.status, 'done')
  assert.equal(harness.mediaEntries.map.size, 0)
})

test('本地文件缺失：删除索引并回退在线，不直接失败', async () => {
  const harness = await makeHarness({
    toc: '<ul class="toc"><li><a href="/ch/1">第1章</a></li></ul>',
    pages: { [`${HOST}/ch/1`]: '<div id="content"><img src="/img/1.jpg"></div>' },
  })
  await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const entry = [...harness.mediaEntries.entries()][0][1]
  const filePath = path.join(process.env.MO_READER_MEDIA_ROOT, entry.files[0].path)
  await rm(filePath)

  const content = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
  })
  assert.equal(content.kind, 'images')
  assert.notEqual(content.local, true)
  assert.equal(content.localMissing, true)
  assert.ok(content.images[0].startsWith(`${BASE}/reader/media/`), content.images[0])
  assert.equal(harness.mediaEntries.map.size, 0)
})

test('其他书/其他章节不受影响', async () => {
  const harness = await makeHarness({ pages: imagePages(HOST, 2, 1) })
  await harness.service.startMediaDownload({ bookId: 'book-1', fromIndex: 0, toIndex: 0 })
  await harness.service.waitForMediaDownloads()

  const otherChapter = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/2`,
    bookId: 'book-1',
    chapterIndex: 1,
  })
  assert.notEqual(otherChapter.local, true)

  harness.books.put('book-2', {
    id: 'book-2',
    name: '另一本',
    origin: HOST,
    bookUrl: `${HOST}/book/2`,
    tocUrl: `${HOST}/toc`,
    type: 2,
  })
  await harness.service.startMediaDownload({ bookId: 'book-2', fromIndex: 0, toIndex: 0 })
  await harness.service.waitForMediaDownloads()
  assert.equal([...harness.mediaEntries.entries()].filter(([, e]) => e.bookId === 'book-2').length, 1)
})

test('按书删除媒体下载：清文件与索引，文字缓存不动', async () => {
  const harness = await makeHarness({ pages: imagePages(HOST, 1, 1) })
  await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const entry = [...harness.mediaEntries.entries()][0][1]
  const filePath = path.join(process.env.MO_READER_MEDIA_ROOT, entry.files[0].path)
  assert.ok((await readFile(filePath)).length > 0)

  const result = await harness.service.deleteMediaDownloads({ bookId: 'book-1' })
  assert.equal(result.removed, 1)
  assert.equal(harness.mediaEntries.map.size, 0)
  await assert.rejects(readFile(filePath))
})

test('本地媒体路由：受保护、inline、支持 Range/HEAD', async () => {
  const routes = []
  const harness = await makeHarness({ pages: imagePages(HOST, 1, 1) })
  mountCtx(harness.service, routes)
  harness.service.registerLocalMediaRoute()
  assert.equal(routes.length, 1)
  const route = routes[0]
  await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const file = [...harness.mediaEntries.entries()][0][1].files[0]
  const url = `${BASE}/reader/media-local/${file.id}`

  const response = await route.resource(new Request(url), owner)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', /^inline;/)
  const range = await route.resource(new Request(url, { headers: { range: 'bytes=0-3' } }), owner)
  assert.equal(range.status, 206)
  assert.equal((await range.arrayBuffer()).byteLength, 4)
  const head = await route.resource(new Request(url, { method: 'HEAD' }), owner)
  assert.equal(head.status, 200)

  assert.equal((await route.resource(new Request(url), undefined)).status, 401)
  assert.equal(
    (await route.resource(new Request(`${BASE}/reader/media-local/0123456789abcdef01234567`), owner)).status,
    404,
  )
})

test('暂停会立即中断在途媒体流，不等整章下完', async () => {
  // 永不结束的响应体：没有中断时关停/暂停会一直等这个流，模拟几百 MB 的视频。
  const stalled = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
    },
  })
  const harness = await makeHarness({
    pages: imagePages(HOST, 1, 1),
    opener: async () => ({
      response: new Response(stalled, {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
      finalUrl: 'https://93.184.216.34/media',
    }),
  })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await waitFor(async () => {
    const { job } = await harness.service.getJob({ id: started.job.id })
    return job.status === 'running' && harness.opened.length > 0
  })
  const pausedAt = Date.now()
  const { job: paused } = await harness.service.pauseJob({ id: started.job.id })
  assert.equal(paused.status, 'paused')
  await harness.service.waitForMediaDownloads()
  assert.ok(Date.now() - pausedAt < 2000, '暂停应立即中断在途流')

  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'paused')
  assert.equal(job.failed, 0, '中断不算失败次数')
  assert.equal(harness.mediaEntries.map.size, 0, '中断的章节不发布索引')
})

test('媒体下载摘要按书聚合类型、条数与字节', async () => {
  const harness = await makeHarness({ pages: imagePages(HOST, 2, 2) })
  await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { summary } = await harness.service.getMediaDownloadSummary({ bookId: 'book-1', total: 2 })
  assert.equal(summary.kind, 'image')
  assert.equal(summary.downloaded, 2)
  assert.equal(summary.total, 2)
  assert.ok(summary.bytes > 0)
  assert.equal(summary.job.status, 'done')
})

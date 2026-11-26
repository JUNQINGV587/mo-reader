import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 媒体配额与存储管理（#114）的服务端测试：全部用临时缓存目录与假数据，不联网、不起端口。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */
const BASE = 'https://reader.example.com'
/** 公网 IP 字面量：代理登记时 SSRF 守卫不做 DNS。 */
const HOST = 'https://93.184.216.34'

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

/** 每次用例独立的缓存/媒体/导出根目录。 */
async function useRoots() {
  const root = await mkdtemp(path.join(tmpdir(), 'mo-storage-'))
  const cache = path.join(root, 'cache')
  const media = path.join(root, 'media')
  const exports = path.join(root, 'exports')
  process.env.MO_READER_CACHE_ROOT = cache
  process.env.MO_READER_MEDIA_ROOT = media
  process.env.MO_READER_EXPORT_ROOT = exports
  delete process.env.MO_READER_MEDIA_QUOTA_BYTES
  await mkdir(cache, { recursive: true })
  await mkdir(media, { recursive: true })
  await mkdir(exports, { recursive: true })
  return { root, cache, media, exports }
}

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const books = fakeTable()
  const mediaEntries = fakeTable()
  const downloadEntries = fakeTable()
  const jobs = fakeTable()
  let settingsValue = {}
  const db = {
    books,
    mediaEntries,
    downloadEntries,
    jobs,
    sources: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    subscriptions: fakeTable(),
    settings: {
      get: () => settingsValue,
      set: async (next) => {
        settingsValue = next
      },
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  service.downloadRetryBaseMs = 1
  return {
    service,
    books,
    mediaEntries,
    downloadEntries,
    jobs,
    setSettings: (next) => {
      settingsValue = next
    },
    getSettings: () => settingsValue,
  }
}

/** 一章一个媒体目录：真实写文件，供用量扫描与清理断言。 */
async function putMediaBook(roots, { bookId, chapterIndex = 0, size = 10, fileName = 'a.bin' }) {
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const dir = path.join(roots.media, mediaStoreId(bookId, chapterIndex))
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, fileName), 'x'.repeat(size))
  return dir
}

function mediaIndexRow(bookId, chapterIndex, bytes) {
  return {
    id: `m-${bookId}`,
    bookId,
    chapterIndex,
    chapterUrl: `${HOST}/book/${bookId}/${chapterIndex}`,
    chapterTitle: `第${chapterIndex + 1}章`,
    sourceUrl: HOST,
    kind: 'image',
    mime: 'image/jpeg',
    bytes,
    files: [],
  }
}

test('存储用量：文字、媒体、导出分别统计，总量与按书明细来自实际占用', async () => {
  const roots = await useRoots()
  const { writeCachedChapter } = await import('../dist/server/cache.js')
  const { textCacheUsage, mediaUsage, exportUsage } = await import('../dist/server/storage-usage.js')

  await writeCachedChapter(HOST, `${HOST}/ch/1`, 'abc')
  await writeCachedChapter(HOST, `${HOST}/ch/2`, 'de')
  await putMediaBook(roots, { bookId: 'book-1', chapterIndex: 0, size: 10, fileName: 'a.bin' })
  await putMediaBook(roots, { bookId: 'book-1', chapterIndex: 0, size: 20, fileName: 'b.bin' })
  await putMediaBook(roots, { bookId: 'book-1', chapterIndex: 1, size: 5, fileName: 'c.bin' })
  await writeFile(path.join(roots.exports, 'a.epub'), '1234567')

  assert.deepEqual(await textCacheUsage(), { bytes: 5, files: 2 })
  assert.deepEqual(await mediaUsage(), { bytes: 35, files: 3, dirs: 2 })
  assert.deepEqual(await exportUsage(), { bytes: 7, files: 1 })

  const { service, books, mediaEntries, downloadEntries } = await makeService()
  books.put('book-1', { id: 'book-1', name: '样本', origin: HOST, lastReadAt: 500 })
  downloadEntries.put('d-1', {
    id: 'd-1',
    bookId: 'book-1',
    chapterIndex: 0,
    chapterUrl: `${HOST}/ch/1`,
    sourceUrl: HOST,
    bytes: 3,
  })
  mediaEntries.put('m-book-1-0', mediaIndexRow('book-1', 0, 30))
  mediaEntries.put('m-book-1-1', mediaIndexRow('book-1', 1, 5))

  const usage = await service.getStorageUsage()
  assert.deepEqual(usage.text, { bytes: 5, files: 2 })
  assert.equal(usage.media.bytes, 35)
  assert.equal(usage.media.files, 3)
  assert.equal(usage.media.entries, 2)
  assert.equal(usage.media.books, 1)
  assert.deepEqual(usage.exports, { bytes: 7, files: 1 })
  assert.equal(usage.total.bytes, 5 + 35 + 7)
  assert.equal(usage.total.files, 2 + 3 + 1)
  assert.equal(usage.quota.bytes, 50 * 1024 ** 3)
  assert.equal(usage.quota.source, 'default')
  assert.equal(usage.books.length, 1)
  assert.equal(usage.books[0].name, '样本')
  assert.equal(usage.books[0].textBytes, 3)
  assert.equal(usage.books[0].textCount, 1)
  assert.equal(usage.books[0].mediaBytes, 35)
  assert.equal(usage.books[0].mediaCount, 2)

  // 媒体与文字同根时，文字用量不重复计算媒体目录。
  const combined = await mkdtemp(path.join(tmpdir(), 'mo-storage-combined-'))
  process.env.MO_READER_CACHE_ROOT = combined
  process.env.MO_READER_MEDIA_ROOT = path.join(combined, 'media')
  await writeCachedChapter(HOST, `${HOST}/ch/9`, 'abcd')
  await putMediaBook({ media: path.join(combined, 'media') }, { bookId: 'book-2', size: 8 })
  assert.deepEqual(await textCacheUsage(), { bytes: 4, files: 1 })
  assert.deepEqual(await mediaUsage(), { bytes: 8, files: 1, dirs: 1 })
})

test('配额来源优先级：环境变量 > 设置 > 默认 50GiB，设置可写且不丢其余字段', async () => {
  const { resolveMediaQuota, DEFAULT_MEDIA_QUOTA_BYTES } = await import('../dist/server/storage-usage.js')
  delete process.env.MO_READER_MEDIA_QUOTA_BYTES
  try {
    const fallback = resolveMediaQuota({})
    assert.equal(fallback.bytes, 50 * 1024 ** 3)
    assert.equal(DEFAULT_MEDIA_QUOTA_BYTES, 50 * 1024 ** 3)
    assert.equal(fallback.source, 'default')
    const fromSettings = resolveMediaQuota({ mediaQuotaBytes: 1234 })
    assert.equal(fromSettings.source, 'settings')
    assert.equal(fromSettings.bytes, 1234)
    assert.equal(fromSettings.settingsBytes, 1234)
    process.env.MO_READER_MEDIA_QUOTA_BYTES = '777'
    const fromEnv = resolveMediaQuota({ mediaQuotaBytes: 1234 })
    assert.equal(fromEnv.source, 'env')
    assert.equal(fromEnv.bytes, 777)
    assert.equal(fromEnv.settingsBytes, 1234)
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      process.env.MO_READER_MEDIA_QUOTA_BYTES = bad
      assert.equal(resolveMediaQuota({}).source, 'default', bad)
    }
    delete process.env.MO_READER_MEDIA_QUOTA_BYTES
    assert.equal(resolveMediaQuota({ mediaQuotaBytes: 0 }).source, 'default')
  } finally {
    delete process.env.MO_READER_MEDIA_QUOTA_BYTES
  }

  const { service, setSettings, getSettings } = await makeService()
  setSettings({ theme: 'light', fontSize: 24 })
  const saved = await service.setMediaQuota({ bytes: 2048 })
  assert.equal(saved.settings.mediaQuotaBytes, 2048)
  assert.equal(saved.settings.theme, 'light')
  assert.equal(getSettings().fontSize, 24)
  const usage = await service.getStorageUsage()
  assert.equal(usage.quota.bytes, 2048)
  assert.equal(usage.quota.source, 'settings')
  assert.equal(usage.quota.settingsBytes, 2048)

  await assert.rejects(service.setMediaQuota({ bytes: -1 }), /配额无效/)
  await assert.rejects(service.setMediaQuota({ bytes: 1.5 }), /配额无效/)
  await assert.rejects(service.setMediaQuota({ bytes: 11 * 1024 ** 4 }), /配额无效/)
  assert.equal(getSettings().mediaQuotaBytes, 2048, '非法值不应写入设置')
})

test('超配额按整本最久未读淘汰：整本删除，索引与占用同步下降', async () => {
  const roots = await useRoots()
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const { service, books, mediaEntries, setSettings } = await makeService()
  setSettings({ mediaQuotaBytes: 250 })
  const specs = [
    ['book-old', '最久未读', 100],
    ['book-mid', '中间', 200],
    ['book-new', '最新', 300],
  ]
  for (const [bookId, name, lastReadAt] of specs) {
    books.put(bookId, { id: bookId, name, origin: HOST, lastReadAt })
    await putMediaBook(roots, { bookId, size: 100 })
    mediaEntries.put(`m-${bookId}`, mediaIndexRow(bookId, 0, 100))
  }

  const first = await service.ensureMediaQuota()
  assert.deepEqual(first.evicted, ['book-old'])
  assert.equal(first.usage, 200)
  assert.equal(first.quota, 250)
  assert.equal(first.source, 'settings')
  await assert.rejects(stat(path.join(roots.media, mediaStoreId('book-old', 0))), '整本媒体目录应删除')
  assert.equal(mediaEntries.get('m-book-old'), undefined)
  assert.ok(mediaEntries.get('m-book-mid'))
  assert.ok(mediaEntries.get('m-book-new'))

  // 继续收紧：剩下两本按同样顺序整本淘汰，一直降到配额内。
  setSettings({ mediaQuotaBytes: 50 })
  const second = await service.ensureMediaQuota()
  assert.deepEqual(second.evicted, ['book-mid', 'book-new'])
  assert.equal(second.usage, 0)
  assert.equal([...mediaEntries.entries()].length, 0)
})

test('置顶书与正在下载的书不淘汰；都不可淘汰时新下载直接失败且已有内容不受损', async () => {
  const roots = await useRoots()
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const { service, books, mediaEntries, jobs, setSettings } = await makeService()
  setSettings({ mediaQuotaBytes: 10 })
  const put = async (bookId, pinned, lastReadAt) => {
    books.put(bookId, { id: bookId, name: bookId, origin: HOST, pinned, lastReadAt })
    await putMediaBook(roots, { bookId, size: 100 })
    mediaEntries.put(`m-${bookId}`, mediaIndexRow(bookId, 0, 100))
  }
  await put('book-pin', true, 1)
  await put('book-busy', false, 2)
  await put('book-free', false, 3)
  jobs.put('job-1', { id: 'job-1', kind: 'media-download', bookId: 'book-busy', status: 'running' })

  const evicted = await service.ensureMediaQuota()
  assert.deepEqual(evicted.evicted, ['book-free'])
  assert.equal(evicted.usage, 200)
  assert.ok(evicted.usage > evicted.quota)
  assert.ok(mediaEntries.get('m-book-pin'))
  assert.ok(mediaEntries.get('m-book-busy'))

  const before = jobs.map.size
  await assert.rejects(
    service.startMediaDownload({ bookId: 'book-pin', all: true }),
    /媒体缓存已满且没有可清理的作品/,
  )
  assert.equal(jobs.map.size, before, '失败时不应建作业')
  assert.ok(mediaEntries.get('m-book-pin'), '已有媒体索引不受影响')
  const kept = await readFile(path.join(roots.media, mediaStoreId('book-pin', 0), 'a.bin'))
  assert.equal(kept.length, 100)
})

test('运行时复查配额：触发淘汰；仍超时永久失败并保留已下内容', async () => {
  const roots = await useRoots()
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const { PermanentMediaError } = await import('../dist/server/media-download.js')
  const { service, books, mediaEntries, setSettings } = await makeService()
  setSettings({ mediaQuotaBytes: 100 })
  books.put('book-other', { id: 'book-other', name: '别的书', origin: HOST, lastReadAt: 1 })
  books.put('book-current', { id: 'book-current', name: '当前书', origin: HOST, lastReadAt: 999 })
  await putMediaBook(roots, { bookId: 'book-other', size: 200 })
  mediaEntries.put('m-book-other', mediaIndexRow('book-other', 0, 200))

  const entry = {
    bookId: 'book-current',
    chapterIndex: 0,
    chapterUrl: `${HOST}/current/1`,
    chapterTitle: '第1章',
    sourceUrl: HOST,
    kind: 'image',
    mime: 'image/jpeg',
    bytes: 10,
    files: [],
  }
  await service.mediaDownloadHost().recordMediaDownload(entry)
  const runtimeRows = [...mediaEntries.entries()]
  assert.equal(runtimeRows.length, 1)
  assert.equal(runtimeRows[0][1].bookId, 'book-current', '当前书刚发布的章节保留')
  assert.equal(mediaEntries.get('m-book-other'), undefined, '别的书被整本淘汰')

  // 只剩置顶书可留：复查后仍超配额，抛永久失败并保留它已有的内容。
  const { service: pinnedService, books: pinnedBooks, mediaEntries: pinnedEntries, setSettings: setPinned } = await makeService()
  setPinned({ mediaQuotaBytes: 10 })
  pinnedBooks.put('book-pin', { id: 'book-pin', name: '置顶', origin: HOST, pinned: true, lastReadAt: 1 })
  await putMediaBook(roots, { bookId: 'book-pin', size: 100 })
  pinnedEntries.put('m-book-pin', mediaIndexRow('book-pin', 0, 100))
  const pinnedEntry = { ...entry, bookId: 'book-pin', chapterIndex: 1, bytes: 10 }
  await assert.rejects(pinnedService.mediaDownloadHost().recordMediaDownload(pinnedEntry), (error) => {
    assert.ok(error instanceof PermanentMediaError)
    assert.match(error.message, /媒体缓存已满/)
    return true
  })
  assert.ok(pinnedEntries.get('m-book-pin'))
  assert.equal((await readFile(path.join(roots.media, mediaStoreId('book-pin', 0), 'a.bin'))).length, 100)
})

test('媒体作业运行时超配额：作业 failed 且 error 含「媒体缓存已满」，已下章节保留', async () => {
  await useRoots()
  const { ReaderService } = await import('../dist/server/service.js')
  const harness = await makeMediaHarness(ReaderService)
  harness.setSettings({ mediaQuotaBytes: 1 })
  const started = await harness.service.startMediaDownload({ bookId: harness.bookId, all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.match(job.error, /媒体缓存已满/)
  const entries = [...harness.mediaEntries.entries()]
  assert.ok(entries.length >= 1, '失败前落盘的章节仍保留索引')
  for (const [, entry] of entries) {
    for (const file of entry.files) {
      const data = await readFile(path.join(process.env.MO_READER_MEDIA_ROOT, file.path))
      assert.ok(data.length > 0)
    }
  }
})

test('配额将满时开始下载给出提示，未接近配额时不提示', async () => {
  const { ReaderService } = await import('../dist/server/service.js')
  const near = await makeMediaHarness(ReaderService)
  near.setSettings({ mediaQuotaBytes: 100 })
  // 先占 85 字节：没超配额，但已到 80% 提示线。
  await putMediaBook(
    { media: process.env.MO_READER_MEDIA_ROOT },
    { bookId: near.bookId, chapterIndex: 5, size: 85, fileName: 'q.bin' },
  )
  const started = await near.service.startMediaDownload({ bookId: near.bookId, all: true })
  assert.match(String(started.warning), /接近配额/)
  await near.service.cancelJob({ id: started.job.id })
  await near.service.waitForMediaDownloads()

  const fresh = await makeMediaHarness(ReaderService)
  fresh.setSettings({ mediaQuotaBytes: 100 })
  const quiet = await fresh.service.startMediaDownload({ bookId: fresh.bookId, all: true })
  assert.equal(String(quiet.warning ?? ''), '')
  await fresh.service.cancelJob({ id: quiet.job.id })
  await fresh.service.waitForMediaDownloads()
})

/** 最小媒体下载外壳：假 TOC / 假章节页 / 假文件流，用来跑真实作业。 */
async function makeMediaHarness(ReaderService) {
  process.env.MO_READER_MEDIA_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-storage-media-'))
  process.env.MO_READER_CACHE_ROOT = process.env.MO_READER_MEDIA_ROOT
  const books = fakeTable()
  const sources = fakeTable()
  const jobs = fakeTable()
  const mediaEntries = fakeTable()
  let settingsValue = {}
  const service = Object.create(ReaderService.prototype)
  service.db = {
    books,
    sources,
    jobs,
    mediaEntries,
    downloadEntries: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    settings: {
      get: () => settingsValue,
      set: async (next) => {
        settingsValue = next
      },
    },
  }
  service.downloadRetryBaseMs = 1
  // 受保护路由与本地媒体地址需要宿主上下文；下载本身不需要真实端口。
  Object.defineProperty(service, 'ctx', {
    configurable: true,
    writable: true,
    value: {
      webServer: { getOrigin: () => BASE },
      inject: (_deps, callback) => {
        callback({
          webServer: { register: () => () => {} },
          effect: (factory) => {
            factory()
          },
        })
      },
    },
  })
  sources.put('s1', {
    bookSourceUrl: HOST,
    bookSourceName: '测试源',
    bookSourceType: 2,
    ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text||text', chapterUrl: 'a@href' },
    ruleContent: { content: 'img@src' },
  })
  const bookId = 'book-quota'
  books.put(bookId, {
    id: bookId,
    name: '配额测试书',
    origin: HOST,
    bookUrl: `${HOST}/book/1`,
    tocUrl: `${HOST}/toc`,
    type: 2,
    pinned: true,
  })
  const pages = {
    [`${HOST}/toc`]: '<ul class="toc"><li><a href="/ch/1">第1章</a></li><li><a href="/ch/2">第2章</a></li></ul>',
    [`${HOST}/ch/1`]: '<div id="content"><img src="/img/1.jpg"></div>',
    [`${HOST}/ch/2`]: '<div id="content"><img src="/img/2.jpg"></div>',
  }
  service.fetch = async (request) => {
    const text = pages[request.url]
    if (text === undefined) throw new Error(`页面不存在：${request.url}`)
    return { text, url: request.url, status: 200 }
  }
  service.mediaStreamOpener = async (url) => {
    const body = Buffer.from(`image:${url}`)
    return {
      response: new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) },
      }),
      finalUrl: url,
    }
  }
  return {
    service,
    mediaEntries,
    bookId,
    setSettings: (next) => {
      settingsValue = next
    },
  }
}

test('按书清理：文字缓存与媒体目录、索引同步删除，别的书不受影响', async () => {
  const roots = await useRoots()
  const { writeCachedChapter, readCachedChapter } = await import('../dist/server/cache.js')
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const { service, books, mediaEntries, downloadEntries } = await makeService()
  books.put('book-a', { id: 'book-a', name: '甲书', origin: HOST })
  books.put('book-b', { id: 'book-b', name: '乙书', origin: HOST })
  await writeCachedChapter(HOST, `${HOST}/a/1`, 'aaaa')
  await writeCachedChapter(HOST, `${HOST}/a/2`, 'bb')
  await writeCachedChapter(HOST, `${HOST}/b/1`, 'c')
  downloadEntries.put('d-a1', { id: 'd-a1', bookId: 'book-a', chapterIndex: 0, chapterUrl: `${HOST}/a/1`, sourceUrl: HOST, bytes: 4 })
  downloadEntries.put('d-a2', { id: 'd-a2', bookId: 'book-a', chapterIndex: 1, chapterUrl: `${HOST}/a/2`, sourceUrl: HOST, bytes: 2 })
  downloadEntries.put('d-b1', { id: 'd-b1', bookId: 'book-b', chapterIndex: 0, chapterUrl: `${HOST}/b/1`, sourceUrl: HOST, bytes: 1 })
  await putMediaBook(roots, { bookId: 'book-a', size: 10 })
  await putMediaBook(roots, { bookId: 'book-b', size: 5 })
  mediaEntries.put('m-book-a', mediaIndexRow('book-a', 0, 10))
  mediaEntries.put('m-book-b', mediaIndexRow('book-b', 0, 5))

  const result = await service.clearBookStorage({ bookId: 'book-a' })
  assert.deepEqual(result, {
    text: { removed: 2, bytes: 6 },
    media: { removed: 1, bytes: 10 },
  })
  assert.equal(await readCachedChapter(HOST, `${HOST}/a/1`), null)
  assert.equal(await readCachedChapter(HOST, `${HOST}/a/2`), null)
  await assert.rejects(stat(path.join(roots.media, mediaStoreId('book-a', 0))))
  assert.equal(downloadEntries.get('d-a1'), undefined)
  assert.equal(mediaEntries.get('m-book-a'), undefined)

  assert.equal(await readCachedChapter(HOST, `${HOST}/b/1`), 'c', '别的书文字缓存保留')
  assert.ok(downloadEntries.get('d-b1'))
  assert.ok(mediaEntries.get('m-book-b'))
  assert.equal((await readFile(path.join(roots.media, mediaStoreId('book-b', 0), 'a.bin'))).length, 5)

  const usage = await service.getStorageUsage()
  assert.deepEqual(usage.text, { bytes: 1, files: 1 })
  assert.equal(usage.media.entries, 1)
  assert.equal(usage.books.length, 1)
  assert.equal(usage.books[0].bookId, 'book-b')
})

test('书架导出不带媒体与导出产物：全量版与 Legado 版只含书目字段', async () => {
  const { exportFullShelf, exportLegadoShelf } = await import('../dist/core/reader/shelf-transfer.js')
  const book = {
    id: 'b1',
    name: '样板书',
    author: '甲',
    origin: HOST,
    bookUrl: `${HOST}/book/1`,
    pinned: true,
    lastReadAt: 1_700_000_000_000,
    content: '正文不应导出',
    chapters: [{ title: '不应导出' }],
    // 即使书目记录里混进了产物字段，导出白名单也不会带出去。
    mediaEntries: [{ id: 'm-1', bookId: 'b1', bytes: 10 }],
    downloadEntries: [{ id: 'd-1', bookId: 'b1', bytes: 4 }],
    exports: [{ file: 'a.epub' }],
  }
  const full = exportFullShelf([book])
  assert.equal(full.format, 'mo-reader-books')
  assert.equal(full.books[0].name, '样板书')
  assert.equal(full.books[0].pinned, true)
  assert.equal(full.books[0].content, undefined)
  assert.equal(full.books[0].mediaEntries, undefined)
  assert.equal(full.books[0].downloadEntries, undefined)
  const fullJson = JSON.stringify(full)
  for (const key of ['media_entries', 'mediaEntries', 'download_entries', 'downloadEntries', 'exports', 'a.epub', '.jpg']) {
    assert.equal(fullJson.includes(key), false, `全量导出不应含 ${key}`)
  }
  const legado = exportLegadoShelf([book])
  assert.equal(legado.length, 1)
  const legadoJson = JSON.stringify(legado)
  for (const key of ['media_entries', 'mediaEntries', 'download_entries', 'downloadEntries', '缓存', '导出产物']) {
    assert.equal(legadoJson.includes(key), false, `Legado 导出不应含 ${key}`)
  }
})

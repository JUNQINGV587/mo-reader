/**
 * HLS 离线下载（#113）端到端测试：本地 node:http 起 fixture，不连公网。
 * 假 opener 先跑真实的 assertPublicHttpUrl（和 openMediaStream 的 SSRF 守卫一致），
 * 通过后再把公网字面量地址映射到 127.0.0.1 fixture；私网分片因此会被真正拒绝。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { createCipheriv } from 'node:crypto'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { assertPublicHttpUrl } from '../dist/core/net/guard.js'

const BASE = 'https://reader.example.com'
/** 公网 IP 字面量：SSRF 守卫不做 DNS，假 opener 负责映射到本地 fixture。 */
const HOST = 'https://93.184.216.34'
const OWNER = { principal: { kind: 'owner' } }
const KEY = Buffer.from('mo-reader-key-01')
const HLS_TYPE = 'application/vnd.apple.mpegurl'

function plainSegment(index) {
  return Buffer.from(`SEG${String(index).padStart(13, '0')}`)
}

/** AES-128 缺省 IV：分片 media sequence 的 16 字节大端。 */
function ivFor(sequence) {
  const iv = Buffer.alloc(16)
  iv.writeBigUInt64BE(BigInt(sequence), 8)
  return iv
}

function encryptSegment(data, sequence) {
  const cipher = createCipheriv('aes-128-cbc', KEY, ivFor(sequence))
  return Buffer.concat([cipher.update(data), cipher.final()])
}

function playlistOf(lines) {
  return `${lines.join('\n')}\n`
}

function encryptedPlaylist() {
  return playlistOf([
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-KEY:METHOD=AES-128,URI="/hls/keys/k1.bin"',
    ...Array.from({ length: 3 }, (_item, index) => [`#EXTINF:4,`, `seg-${index}.ts`]).flat(),
    '#EXT-X-ENDLIST',
  ])
}

function plainPlaylist(prefix, count) {
  return playlistOf([
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    ...Array.from({ length: count }, (_item, index) => [`#EXTINF:4,`, `seg-${index}.ts`]).flat(),
    '#EXT-X-ENDLIST',
  ])
}

function hlsRoutes() {
  const routes = {
    '/hls/master.m3u8': {
      body: playlistOf([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360',
        'low/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
        'high/index.m3u8',
      ]),
      type: HLS_TYPE,
    },
    '/hls/high/index.m3u8': { body: encryptedPlaylist(), type: HLS_TYPE },
    '/hls/low/index.m3u8': { body: plainPlaylist('low', 1), type: HLS_TYPE },
    '/hls/keys/k1.bin': { body: KEY, type: 'application/octet-stream' },
    '/plain/index.m3u8': { body: plainPlaylist('plain', 3), type: HLS_TYPE },
    '/drm/index.m3u8': {
      body: playlistOf([
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm-key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"',
        '#EXTINF:4,',
        'seg-0.ts',
        '#EXT-X-ENDLIST',
      ]),
      type: HLS_TYPE,
    },
    '/ssrf/index.m3u8': {
      body: playlistOf([
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXTINF:4,',
        'http://127.0.0.1:9/ssrf/segment.ts',
        '#EXT-X-ENDLIST',
      ]),
      type: HLS_TYPE,
    },
    '/player/stream': { body: plainPlaylist('player', 1), type: 'application/x-mpegURL' },
  }
  for (let index = 0; index < 3; index += 1) {
    routes[`/hls/high/seg-${index}.ts`] = {
      body: encryptSegment(plainSegment(index), 7 + index),
      type: 'video/mp2t',
    }
    routes[`/plain/seg-${index}.ts`] = { body: plainSegment(10 + index), type: 'video/mp2t' }
  }
  routes['/drm/seg-0.ts'] = { body: plainSegment(20), type: 'video/mp2t' }
  routes['/player/seg-0.ts'] = { body: plainSegment(30), type: 'video/mp2t' }
  return routes
}

async function startFixture(routes) {
  const requests = []
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(pathname)
    const route = routes[pathname]
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
      response.end('not found')
      return
    }
    const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(String(route.body))
    response.writeHead(200, {
      'content-type': route.type,
      'content-length': String(body.length),
      connection: 'close',
    })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** 记录每一条上游请求次数，供「只补缺分片」「不重试」这类断言使用。 */
function countOf(requests, pathname) {
  return requests.filter((item) => item === pathname).length
}

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

function mountCtx(service, routes) {
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

async function waitFor(check, timeout = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时')
}

/** 与真实 openMediaStream 一样先过 SSRF 守卫，再把公网字面量映射到本地 fixture。 */
function makeOpener(fixture, hook) {
  return async (url, options = {}) => {
    await assertPublicHttpUrl(url)
    const target = new URL(new URL(url).pathname, fixture.origin)
    if (hook) await hook(url)
    const response = await fetch(target, { headers: options.headers ?? {} })
    return { response, finalUrl: url }
  }
}

async function makeHarness(fixture, options = {}) {
  process.env.MO_READER_MEDIA_ROOT = await mkdtemp(path.join(tmpdir(), 'mo-hls-'))
  process.env.MO_READER_CACHE_ROOT = process.env.MO_READER_MEDIA_ROOT
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  const books = fakeTable()
  const mediaEntries = fakeTable()
  const jobs = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books,
    readRecords: fakeTable(),
    jobs,
    mediaEntries,
    downloadEntries: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    settings: { get: () => ({}), set: async () => {} },
  }
  service.downloadRetryBaseMs = 1
  services.push(service)
  sources.put('s1', {
    bookSourceUrl: HOST,
    bookSourceName: '测试源',
    bookSourceType: 4,
    ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text||text', chapterUrl: 'a@href' },
    ruleContent: { content: 'video@src' },
    header: '',
  })
  books.put('book-1', {
    id: 'book-1',
    name: '测试书',
    origin: HOST,
    bookUrl: `${HOST}/book/1`,
    tocUrl: `${HOST}/toc`,
    type: 4,
  })
  const pages = {
    [`${HOST}/toc`]: '<ul class="toc"><li><a href="/ch/1">第1章</a></li></ul>',
    [`${HOST}/ch/1`]: `<div id="content"><video src="${options.mediaSrc ?? '/hls/master.m3u8'}"></video></div>`,
  }
  service.fetch = async (request) => {
    const text = pages[request.url]
    if (text === undefined) throw new Error(`页面不存在：${request.url}`)
    return { text, url: request.url, status: 200 }
  }
  service.mediaStreamOpener = makeOpener(fixture, options.hook)
  return { service, jobs, mediaEntries, mediaRoot: process.env.MO_READER_MEDIA_ROOT }
}

const services = []
test.after(async () => {
  for (const service of services) await service.shutdown?.()
})

test('HLS：选最高码率、AES-128 分片解密落盘，本地播放地址以 .m3u8 结尾', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture)
  const routes = []
  mountCtx(harness.service, routes)
  harness.service.registerLocalMediaRoute()
  assert.equal(routes.length, 1)

  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 1)
  assert.equal(job.skipped, 0)
  assert.equal(job.failed, 0)
  assert.equal(countOf(fixture.requests, '/hls/high/index.m3u8'), 1, '应选 BANDWIDTH 最高的变体')
  assert.equal(countOf(fixture.requests, '/hls/low/index.m3u8'), 0, '不应下载低码率变体')

  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.deepEqual(
    entry.files.map((file) => file.name),
    ['index.m3u8', 'seg-000.ts', 'seg-001.ts', 'seg-002.ts'],
  )
  const dir = path.join(harness.mediaRoot, entry.files[0].path.split('/')[0])
  const playlistText = await readFile(path.join(harness.mediaRoot, entry.files[0].path), 'utf8')
  assert.ok(playlistText.endsWith('\n'))
  assert.match(playlistText, /(?:^|\n)seg-000\.ts\n/, '本地 playlist 应写相对分片名')
  assert.match(playlistText, /(?:^|\n)seg-002\.ts\n/)
  assert.ok(!playlistText.includes('/hls/'), '本地 playlist 不能残留源站绝对地址')
  assert.doesNotMatch(playlistText, /EXT-X-KEY/, '本地 playlist 不能残留密钥标签')
  for (let index = 0; index < 3; index += 1) {
    const data = await readFile(path.join(harness.mediaRoot, entry.files[index + 1].path))
    assert.deepEqual(data, plainSegment(index), `分片 ${index} 应已解密`)
  }
  const names = await readdir(dir)
  assert.ok(!names.some((name) => name.endsWith('.key')), '密钥不落盘')

  const content = await harness.service.getContent({
    sourceUrl: HOST,
    chapterUrl: `${HOST}/ch/1`,
    bookId: 'book-1',
    chapterIndex: 0,
  })
  assert.equal(content.kind, 'video')
  assert.equal(content.local, true)
  assert.ok(content.mediaUrl.startsWith(`${BASE}/reader/media-local/`))
  assert.match(content.mediaUrl, /\/index\.m3u8$/)

  const playlistId = entry.files[0].id
  const route = routes[0]
  const playlist = await route.resource(new Request(content.mediaUrl), OWNER)
  assert.equal(playlist.status, 200)
  assert.equal(playlist.headers.get('content-type'), HLS_TYPE)
  assert.equal(await playlist.text(), playlistText)
  const segment = await route.resource(
    new Request(`${BASE}/reader/media-local/${playlistId}/seg-000.ts`),
    OWNER,
  )
  assert.equal(segment.status, 200)
  assert.deepEqual(Buffer.from(await segment.arrayBuffer()), plainSegment(0))
  assert.equal(
    (await route.resource(new Request(`${BASE}/reader/media-local/${playlistId}/nope.ts`), OWNER)).status,
    404,
  )
  assert.equal(
    (await route.resource(new Request(`${BASE}/reader/media-local/${playlistId}`), OWNER)).status,
    200,
    '旧的单段 id 地址继续可用',
  )
})

test('HLS：响应头声明 playlist（地址不是 .m3u8）也能识别并离线', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/player/stream' })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 1)
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.deepEqual(entry.files.map((file) => file.name), ['index.m3u8', 'seg-000.ts'])
  const data = await readFile(path.join(harness.mediaRoot, entry.files[1].path))
  assert.deepEqual(data, plainSegment(30))
})

test('HLS DRM：永久失败、作业 failed 带文案、不重试也不发布索引', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/drm/index.m3u8' })
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const { HLS_DRM_MESSAGE } = await import('../dist/server/hls.js')
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.error, HLS_DRM_MESSAGE)
  assert.equal(job.failed, 0, 'DRM 是永久失败，不算章节重试失败')
  assert.equal(harness.mediaEntries.map.size, 0)
  assert.equal(countOf(fixture.requests, '/drm/index.m3u8'), 1, 'DRM 不重试')
  assert.equal(countOf(fixture.requests, '/drm/seg-0.ts'), 0)
  const storeDir = path.join(harness.mediaRoot, mediaStoreId('book-1', 0))
  await assert.rejects(stat(storeDir), 'DRM 失败要清掉半成品目录')
})

test('HLS 暂停后继续：只补缺分片，已落盘分片不重下', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  let harness = null
  let jobId = ''
  let paused = false
  const hook = async (url) => {
    if (paused || !jobId || !url.endsWith('/plain/seg-1.ts')) return
    paused = true
    await harness.service.pauseJob({ id: jobId })
  }
  harness = await makeHarness(fixture, { mediaSrc: '/plain/index.m3u8', hook })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  jobId = started.job.id
  await waitFor(async () => {
    const { job } = await harness.service.getJob({ id: jobId })
    return job.status === 'paused'
  })
  const pausedJob = (await harness.service.getJob({ id: jobId })).job
  assert.equal(pausedJob.status, 'paused')
  assert.equal(pausedJob.failed, 0, '暂停中断不算失败')
  assert.equal(harness.mediaEntries.map.size, 0, '暂停不发布半成品索引')

  await harness.service.resumeJob({ id: jobId })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: jobId })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 1)
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.equal(entry.files.length, 4)
  assert.equal(countOf(fixture.requests, '/plain/seg-0.ts'), 1, '已下完的分片不应重下')
  assert.equal(countOf(fixture.requests, '/plain/seg-1.ts'), 2, '中断的分片要继续补齐')
  assert.equal(countOf(fixture.requests, '/plain/seg-2.ts'), 1)
  for (let index = 0; index < 3; index += 1) {
    const data = await readFile(path.join(harness.mediaRoot, entry.files[index + 1].path))
    assert.deepEqual(data, plainSegment(10 + index))
  }
})

test('HLS 分片指向内网地址：SSRF 守卫拒绝，作业失败且不落盘', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/ssrf/index.m3u8' })
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'failed')
  assert.match(String(job.error), /全部章节下载失败|禁止访问/)
  assert.equal(harness.mediaEntries.map.size, 0)
  assert.equal(countOf(fixture.requests, '/ssrf/segment.ts'), 0, '私网分片请求不应发出')
  const storeDir = path.join(harness.mediaRoot, mediaStoreId('book-1', 0))
  const names = await readdir(storeDir).catch(() => [])
  assert.ok(!names.some((name) => name.startsWith('seg-')), '私网分片不应落盘')
})

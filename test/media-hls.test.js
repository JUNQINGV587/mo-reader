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

/** 显式 IV（playlist 里写死）与加密初始化段：EXT-X-MAP 复用生效 EXT-X-KEY 的 IV。 */
const MAP_IV = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
const MAP_BYTES = Buffer.from('0123456789abcdef0123456789abcdef')

function encryptWithIv(data, iv) {
  const cipher = createCipheriv('aes-128-cbc', KEY, iv)
  return Buffer.concat([cipher.update(data), cipher.final()])
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

  routes['/byterange/index.m3u8'] = {
    body: playlistOf([
      '#EXTM3U',
      '#EXT-X-VERSION:4',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-BYTERANGE:1000@0',
      '#EXTINF:4,',
      'seg-0.ts',
      '#EXT-X-ENDLIST',
    ]),
    type: HLS_TYPE,
  }
  routes['/byterange/seg-0.ts'] = { body: plainSegment(40), type: 'video/mp2t' }

  routes['/byterange-map/index.m3u8'] = {
    body: playlistOf([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4",BYTERANGE="1000@0"',
      '#EXTINF:4,',
      'seg-0.ts',
      '#EXT-X-ENDLIST',
    ]),
    type: HLS_TYPE,
  }
  routes['/byterange-map/init.mp4'] = { body: MAP_BYTES, type: 'video/mp4' }
  routes['/byterange-map/seg-0.ts'] = { body: plainSegment(41), type: 'video/mp2t' }

  const mapEncPlaylist = playlistOf([
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-KEY:METHOD=AES-128,URI="/map-enc/key.bin",IV=0x${MAP_IV.toString('hex')}`,
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'seg-0.ts',
    '#EXT-X-ENDLIST',
  ])
  routes['/map-enc/index.m3u8'] = { body: mapEncPlaylist, type: HLS_TYPE }
  routes['/map-enc/key.bin'] = { body: KEY, type: 'application/octet-stream' }
  routes['/map-enc/init.mp4'] = { body: encryptWithIv(MAP_BYTES, MAP_IV), type: 'video/mp4' }
  routes['/map-enc/seg-0.ts'] = { body: encryptWithIv(plainSegment(1), MAP_IV), type: 'video/mp2t' }

  routes['/map-plain/index.m3u8'] = {
    body: playlistOf([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4,',
      'seg-0.ts',
      '#EXT-X-ENDLIST',
    ]),
    type: HLS_TYPE,
  }
  routes['/map-plain/init.mp4'] = { body: MAP_BYTES, type: 'video/mp4' }
  routes['/map-plain/seg-0.ts'] = { body: plainSegment(42), type: 'video/mp2t' }

  // 非规范源站：EXT-X-KEY 不带 IV。分片按 media sequence 推 IV，初始化段按 0（AES 默认）兜底。
  routes['/map-noiv/index.m3u8'] = {
    body: playlistOf([
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-KEY:METHOD=AES-128,URI="/map-noiv/key.bin"',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:4,',
      'seg-0.ts',
      '#EXT-X-ENDLIST',
    ]),
    type: HLS_TYPE,
  }
  routes['/map-noiv/key.bin'] = { body: KEY, type: 'application/octet-stream' }
  routes['/map-noiv/init.mp4'] = { body: encryptWithIv(MAP_BYTES, ivFor(0)), type: 'video/mp4' }
  routes['/map-noiv/seg-0.ts'] = { body: encryptWithIv(plainSegment(43), ivFor(0)), type: 'video/mp2t' }
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

test('HLS 按字节范围切分：分片与初始化段都是永久失败、不重试', async (t) => {
  const { HLS_BYTERANGE_MESSAGE } = await import('../dist/server/hls.js')
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const cases = [
    { mediaSrc: '/byterange/index.m3u8', untouched: '/byterange/seg-0.ts' },
    { mediaSrc: '/byterange-map/index.m3u8', untouched: '/byterange-map/init.mp4' },
  ]
  for (const item of cases) {
    const fixture = await startFixture(hlsRoutes())
    t.after(() => fixture.close())
    const harness = await makeHarness(fixture, { mediaSrc: item.mediaSrc })
    const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
    await harness.service.waitForMediaDownloads()
    const { job } = await harness.service.getJob({ id: started.job.id })
    assert.equal(job.status, 'failed', item.mediaSrc)
    assert.equal(job.error, HLS_BYTERANGE_MESSAGE, item.mediaSrc)
    assert.match(String(job.error), /暂不支持按字节范围切分的 HLS/)
    assert.equal(job.failed, 0, '永久失败不计章节重试失败')
    assert.equal(countOf(fixture.requests, item.mediaSrc), 1, '一次失败后不重试')
    assert.equal(countOf(fixture.requests, item.untouched), 0)
    assert.equal(harness.mediaEntries.map.size, 0)
    await assert.rejects(
      stat(path.join(harness.mediaRoot, mediaStoreId('book-1', 0))),
      '永久失败要清掉半成品目录',
    )
  }
})

test('HLS 加密初始化段：按 EXT-X-KEY 的 IV 解密，本地 playlist 不残留密钥', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/map-enc/index.m3u8' })
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.completed, 1)
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.deepEqual(entry.files.map((file) => file.name), ['index.m3u8', 'init-000.mp4', 'seg-000.ts'])
  const playlistText = await readFile(path.join(harness.mediaRoot, entry.files[0].path), 'utf8')
  assert.match(playlistText, /EXT-X-MAP:URI="init-000\.mp4"/, '初始化段改写成本地相对名')
  assert.doesNotMatch(playlistText, /EXT-X-KEY/, '本地 playlist 不能残留密钥标签')
  assert.ok(!playlistText.includes('/map-enc/'), '本地 playlist 不能残留源站地址')
  const init = await readFile(path.join(harness.mediaRoot, entry.files[1].path))
  assert.deepEqual(init, MAP_BYTES, '加密初始化段应已解密')
  const segment = await readFile(path.join(harness.mediaRoot, entry.files[2].path))
  assert.deepEqual(segment, plainSegment(1))
  const names = await readdir(path.join(harness.mediaRoot, mediaStoreId('book-1', 0)))
  assert.ok(!names.includes('.hls-partial.json'), '成功后不残留续传清单')
})

test('HLS 明文初始化段：未加密源行为不变', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/map-plain/index.m3u8' })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.deepEqual(entry.files.map((file) => file.name), ['index.m3u8', 'init-000.mp4', 'seg-000.ts'])
  assert.deepEqual(await readFile(path.join(harness.mediaRoot, entry.files[1].path)), MAP_BYTES)
  assert.deepEqual(await readFile(path.join(harness.mediaRoot, entry.files[2].path)), plainSegment(42))
  const playlistText = await readFile(path.join(harness.mediaRoot, entry.files[0].path), 'utf8')
  assert.match(playlistText, /EXT-X-MAP:URI="init-000\.mp4"/)
  assert.doesNotMatch(playlistText, /EXT-X-KEY/)
})

test('HLS 加密初始化段：源站省略 IV 时按 0 兜底，不静默失败', async (t) => {
  const fixture = await startFixture(hlsRoutes())
  t.after(() => fixture.close())
  const harness = await makeHarness(fixture, { mediaSrc: '/map-noiv/index.m3u8' })
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const entry = [...harness.mediaEntries.entries()][0][1]
  assert.deepEqual(await readFile(path.join(harness.mediaRoot, entry.files[1].path)), MAP_BYTES)
  assert.deepEqual(await readFile(path.join(harness.mediaRoot, entry.files[2].path)), plainSegment(43))
})

test('HLS 加密分片：边下边解密落盘，不整片读入内存', async (t) => {
  const plain = Buffer.alloc(4 * 1024 * 1024, 0x41)
  const encrypted = encryptWithIv(plain, ivFor(0))
  const cut = 2 * 1024 * 1024
  let releaseGate = () => {}
  const gate = new Promise((resolve) => {
    releaseGate = resolve
  })
  let bytesSent = 0
  const requests = []
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.push(pathname)
    if (pathname === '/big/index.m3u8') {
      const body = Buffer.from(
        playlistOf([
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-KEY:METHOD=AES-128,URI="/big/key.bin"',
          '#EXTINF:4,',
          'seg-0.ts',
          '#EXT-X-ENDLIST',
        ]),
      )
      response.writeHead(200, {
        'content-type': HLS_TYPE,
        'content-length': String(body.length),
        connection: 'close',
      })
      response.end(body)
      return
    }
    if (pathname === '/big/key.bin') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', connection: 'close' })
      response.end(KEY)
      return
    }
    if (pathname === '/big/seg-0.ts') {
      response.writeHead(200, {
        'content-type': 'video/mp2t',
        'content-length': String(encrypted.length),
        connection: 'close',
      })
      response.write(encrypted.subarray(0, cut))
      bytesSent = cut
      await gate
      response.end(encrypted.subarray(cut))
      bytesSent = encrypted.length
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain', connection: 'close' })
    response.end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  )
  const fixture = { origin, requests, close: async () => {} }
  const harness = await makeHarness(fixture, { mediaSrc: '/big/index.m3u8' })
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const storeDir = path.join(harness.mediaRoot, mediaStoreId('book-1', 0))
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })

  // 上游只发了一半时磁盘上就应有解密后的数据：说明边下边写，而不是整片读入内存后再落盘。
  await waitFor(async () => {
    const info = await stat(path.join(storeDir, 'seg-000.ts')).catch(() => null)
    return info !== null && info.size > 0
  }, 3000)
  assert.equal(bytesSent, cut, '首块落盘时上游仍停在一半，未被整片缓冲')

  releaseGate()
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: started.job.id })
  assert.equal(job.status, 'done')
  const data = await readFile(path.join(storeDir, 'seg-000.ts'))
  assert.deepEqual(data, plain, '分块解密结果应与原文一致')
})

test('HLS 续传指纹：只认分片/密钥/初始化段语义，注释与无关标签不影响', async () => {
  const { parseMediaPlaylist, hlsPlanFingerprint } = await import('../dist/server/hls.js')
  const iv = '000102030405060708090a0b0c0d0e0f'
  const baseLines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:7',
    `#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.bin",IV=0x${iv}`,
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'seg-0.ts',
    '#EXTINF:4,',
    'seg-1.ts',
    '#EXT-X-ENDLIST',
  ]
  const parse = (lines) => parseMediaPlaylist(playlistOf(lines), 'https://reader.example.com/fp/index.m3u8')
  const base = hlsPlanFingerprint(parse(baseLines))
  const noisyLines = [
    '#EXTM3U',
    '# 源站调整了一条注释',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:8',
    '#EXT-X-MEDIA-SEQUENCE:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.bin",IV=0x${iv}`,
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'seg-0.ts',
    '#EXTINF:4,',
    'seg-1.ts',
    '#EXT-X-ENDLIST',
  ]
  assert.equal(hlsPlanFingerprint(parse(noisyLines)), base, '注释与无关标签变化不改变指纹')
  assert.notEqual(
    hlsPlanFingerprint(parse(baseLines.map((line) => (line === 'seg-1.ts' ? 'seg-1b.ts' : line)))),
    base,
    '分片地址变化要重下',
  )
  assert.notEqual(
    hlsPlanFingerprint(parse(baseLines.map((line) => line.replace(iv, iv.replace('0f', 'ff'))))),
    base,
    '密钥 IV 变化要重下',
  )
  assert.notEqual(
    hlsPlanFingerprint(parse(baseLines.map((line) => line.replace('init.mp4', 'init2.mp4')))),
    base,
    '初始化段地址变化要重下',
  )
})

test('HLS 续传：源 playlist 只改注释与无关标签时只补缺分片，成功后清清单', async (t) => {
  const routes = hlsRoutes()
  const fixture = await startFixture(routes)
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
  const { mediaStoreId } = await import('../dist/server/media-cache.js')
  const started = await harness.service.startMediaDownload({ bookId: 'book-1', all: true })
  jobId = started.job.id
  await waitFor(async () => {
    const { job } = await harness.service.getJob({ id: jobId })
    return job.status === 'paused'
  })
  const storeDir = path.join(harness.mediaRoot, mediaStoreId('book-1', 0))
  assert.ok(
    (await readdir(storeDir)).includes('.hls-partial.json'),
    '暂停时保留续传清单',
  )

  // 只改注释 / TARGETDURATION 等与下载无关的内容：续传应复用已下分片。
  routes['/plain/index.m3u8'].body = playlistOf([
    '#EXTM3U',
    '# 源站改了一条注释',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:8',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:4,',
    'seg-0.ts',
    '#EXTINF:4,',
    'seg-1.ts',
    '#EXTINF:4,',
    'seg-2.ts',
    '#EXT-X-ENDLIST',
  ])
  await harness.service.resumeJob({ id: jobId })
  await harness.service.waitForMediaDownloads()
  const { job } = await harness.service.getJob({ id: jobId })
  assert.equal(job.status, 'done')
  assert.equal(countOf(fixture.requests, '/plain/seg-0.ts'), 1, '已下完的分片不因无关标签变化重下')
  assert.equal(countOf(fixture.requests, '/plain/seg-1.ts'), 2, '中断的分片要继续补齐')
  assert.equal(countOf(fixture.requests, '/plain/seg-2.ts'), 1)
  assert.ok(
    !(await readdir(storeDir)).includes('.hls-partial.json'),
    '成功后清理续传清单',
  )
  const entry = [...harness.mediaEntries.entries()][0][1]
  for (let index = 0; index < 3; index += 1) {
    const data = await readFile(path.join(harness.mediaRoot, entry.files[index + 1].path))
    assert.deepEqual(data, plainSegment(10 + index))
  }
})

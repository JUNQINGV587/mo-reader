import assert from 'node:assert/strict'
import test from 'node:test'

const { ReaderService } = await import('../dist/server/service.js')
const { MEDIA_ROUTE_PATH, MediaRegistry } = await import('../dist/server/media.js')

/** 宿主对外地址：代理地址都拼在它下面。 */
const BASE = 'https://reader.example.com'
/** 公网 IP 字面量：SSRF 守卫对字面量不做 DNS，测试全程不联网。 */
const HOST = 'https://93.184.216.34'
const owner = { principal: { kind: 'owner' } }
const guest = { principal: { kind: 'guest' } }

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

/** 假 db + 空登记表；不启真实端口，也不碰真实存储。 */
function makeService() {
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources: fakeTable(),
    books: fakeTable(),
    readRecords: fakeTable(),
    settings: { get: () => null, set: async () => {} },
  }
  service.mediaRegistry = new MediaRegistry()
  return service
}

/** 按 service 的注册方式挂上媒体路由，返回收集到的路由对象。 */
function mountMediaRoute(service) {
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
  service.registerMediaRoute()
  assert.equal(routes.length, 1)
  return routes[0]
}

/** 替换上游抓取：记录每次调用，返回预置响应，绝不联网。 */
function stubOpener(service, handler) {
  const calls = []
  service.mediaStreamOpener = async (url, options) => {
    calls.push({ url, options })
    return handler(url, options, calls.length)
  }
  return calls
}

/** 代理地址里的 token（路径形如 /reader/media/<token>/<文件名>）。 */
function tokenOf(url) {
  const pathname = new URL(url).pathname
  const parts = pathname.split('/')
  return parts[3]
}

function putSource(service, sourceUrl, source) {
  service.db.sources.put(sourceUrl, { bookSourceUrl: sourceUrl, header: '{"X-Source":"1"}', ...source })
}

test('getContent 图片：登记后只返回代理地址，私网图片回退原地址', async () => {
  const service = makeService()
  mountMediaRoute(service)
  const sourceUrl = `${HOST}/source-images`
  const chapterUrl = `${HOST}/book/1/ch/3.html`
  putSource(service, sourceUrl, { bookSourceName: '图源', bookSourceType: 2 })
  service.fetch = async () => ({
    status: 200,
    text: `<img src="${HOST}/img/a.jpg"><img src="${HOST}/img/b.jpg"><img src="http://127.0.0.1/private.jpg">`,
    url: chapterUrl,
  })
  const result = await service.getContent({ chapterUrl, sourceUrl })
  assert.equal(result.kind, 'images')
  assert.equal(result.images.length, 3)
  for (const image of result.images.slice(0, 2)) {
    assert.ok(image.startsWith(`${BASE}${MEDIA_ROUTE_PATH}/`), image)
    assert.match(tokenOf(image), /^[A-Za-z0-9_-]{24}$/)
    assert.ok(!image.includes('93.184.216.34'), '代理地址不能带原始主机')
    assert.ok(!image.includes('/img/'), '代理地址不能带原始目录')
  }
  // 私网地址登记失败时退回原地址，阅读不因此中断。
  assert.equal(result.images[2], 'http://127.0.0.1/private.jpg')
  const entry = service.mediaRegistry.get(tokenOf(result.images[0]))
  assert.equal(entry.url, `${HOST}/img/a.jpg`)
  assert.equal(entry.ext, 'jpg')
  assert.equal(entry.kind, 'image')
  assert.equal(entry.headers['X-Source'], '1')
  assert.equal(entry.headers.Referer, chapterUrl)
})

test('getContent 音频：无解析规则时直接代理章节地址，Referer 用书籍页', async () => {
  const service = makeService()
  mountMediaRoute(service)
  const sourceUrl = `${HOST}/source-audio`
  const chapterUrl = `${HOST}/audio/a.mp3`
  putSource(service, sourceUrl, { bookSourceName: '音频源', bookSourceType: 1 })
  let fetched = 0
  service.fetch = async () => {
    fetched += 1
    throw new Error('不该请求章节页')
  }
  const result = await service.getContent({ chapterUrl, sourceUrl, bookUrl: `${HOST}/book/a` })
  assert.equal(result.kind, 'audio')
  assert.equal(fetched, 0)
  assert.ok(result.mediaUrl.startsWith(`${BASE}${MEDIA_ROUTE_PATH}/`))
  assert.ok(result.mediaUrl.endsWith('.mp3'))
  const entry = service.mediaRegistry.get(tokenOf(result.mediaUrl))
  assert.equal(entry.url, chapterUrl)
  assert.equal(entry.kind, 'audio')
  assert.equal(entry.headers.Referer, `${HOST}/book/a`)
  assert.equal(entry.headers['X-Source'], '1')
})

test('getContent 视频：按规则解析出的媒体地址走代理，原始地址不外泄', async () => {
  const service = makeService()
  mountMediaRoute(service)
  const sourceUrl = `${HOST}/source-video`
  const chapterUrl = `${HOST}/book/2/ch/5.html`
  const media = `${HOST}/v/movie.mp4`
  putSource(service, sourceUrl, {
    bookSourceName: '视频源',
    bookSourceType: 4,
    ruleContent: { content: 'tag.video@src' },
  })
  service.fetch = async () => ({
    status: 200,
    text: `<video src="${media}"></video>`,
    url: chapterUrl,
  })
  const result = await service.getContent({ chapterUrl, sourceUrl })
  assert.equal(result.kind, 'video')
  assert.ok(result.mediaUrl.startsWith(`${BASE}${MEDIA_ROUTE_PATH}/`))
  assert.ok(result.mediaUrl.endsWith('.mp4'))
  assert.ok(!JSON.stringify(result).includes(media), '结果里不能出现原始媒体地址')
  const entry = service.mediaRegistry.get(tokenOf(result.mediaUrl))
  assert.equal(entry.url, media)
  assert.equal(entry.headers.Referer, chapterUrl)
})

test('代理路由：默认要求登录态，只认已登记 token', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, MEDIA_ROUTE_PATH)
  assert.equal(route.auth, 'required')

  const token = service.mediaRegistry.register(`${HOST}/v/movie.mp4`, { kind: 'video' })
  const url = `${BASE}${MEDIA_ROUTE_PATH}/${token}/movie.mp4`

  const missingPeer = await route.resource(new Request(url), undefined)
  assert.equal(missingPeer.status, 401)
  const denied = await route.resource(new Request(url), guest)
  assert.equal(denied.status, 403)
  const unknown = await route.resource(
    new Request(`${BASE}${MEDIA_ROUTE_PATH}/${'A'.repeat(24)}/movie.mp4`),
    owner,
  )
  assert.equal(unknown.status, 404)
  const malformed = await route.resource(new Request(`${BASE}${MEDIA_ROUTE_PATH}/short/movie.mp4`), owner)
  assert.equal(malformed.status, 404)
  const post = await route.resource(new Request(url, { method: 'POST' }), owner)
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')
  assert.ok(service.mediaRegistry.get(token))
})

test('代理路由：200 全量透传类型、长度与请求头', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  const token = service.mediaRegistry.register(`${HOST}/v/movie.mp4`, {
    headers: { Referer: `${HOST}/book/1` },
    kind: 'video',
  })
  const calls = stubOpener(service, (url) => ({
    response: new Response('0123456789', {
      status: 200,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes' },
    }),
    finalUrl: url,
  }))
  const response = await route.resource(new Request(`${BASE}${MEDIA_ROUTE_PATH}/${token}/movie.mp4`), owner)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(response.headers.get('content-length'), '10')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  assert.equal(response.headers.get('cache-control'), 'private, max-age=0')
  assert.ok(response.headers.get('content-disposition').startsWith('inline'))
  assert.equal(await response.text(), '0123456789')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.headers.Referer, `${HOST}/book/1`)
})

test('代理路由：Range 透传 206 与 Content-Range，HEAD 不带 body', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  const token = service.mediaRegistry.register(`${HOST}/v/movie.mp4`, { kind: 'video' })
  const url = `${BASE}${MEDIA_ROUTE_PATH}/${token}/movie.mp4`
  const calls = stubOpener(service, (target, options) => {
    if (options.method === 'HEAD') {
      return {
        response: new Response(null, {
          status: 200,
          headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes' },
        }),
        finalUrl: target,
      }
    }
    if (options.range) {
      return {
        response: new Response('part', {
          status: 206,
          headers: {
            'Content-Type': 'video/mp4',
            'Content-Length': '4',
            'Content-Range': 'bytes 0-3/10',
            'Accept-Ranges': 'bytes',
          },
        }),
        finalUrl: target,
      }
    }
    return { response: new Response(null, { status: 500 }), finalUrl: target }
  })

  const ranged = await route.resource(new Request(url, { headers: { Range: 'bytes=0-3' } }), owner)
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-3/10')
  assert.equal(ranged.headers.get('content-length'), '4')
  assert.equal(await ranged.text(), 'part')
  assert.equal(calls[0].options.range, 'bytes=0-3')

  const head = await route.resource(new Request(url, { method: 'HEAD' }), owner)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.equal(head.headers.get('content-length'), '10')
  assert.equal(calls[1].options.method, 'HEAD')
})

test('代理路由：上游失败返回 502 而不是静默空响应', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  const token = service.mediaRegistry.register(`${HOST}/v/movie.mp4`, { kind: 'video' })
  stubOpener(service, () => {
    throw new Error('upstream down')
  })
  const response = await route.resource(new Request(`${BASE}${MEDIA_ROUTE_PATH}/${token}/movie.mp4`), owner)
  assert.equal(response.status, 502)
  assert.match(await response.text(), /媒体代理抓取失败/)
})

test('HLS：分片、子 playlist 与 key 都改写成新 token', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  const playlistUrl = `${HOST}/hls/index.m3u8`
  const token = service.mediaRegistry.register(playlistUrl, {
    headers: { Referer: `${HOST}/book/1` },
    kind: 'hls',
    ext: 'm3u8',
  })
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    `#EXT-X-KEY:METHOD=AES-128,URI="${HOST}/hls/k.key"`,
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4,',
    'seg0.ts',
    '#EXTINF:4,',
    `${HOST}/hls/seg1.ts?token=abc`,
    '#EXT-X-STREAM-INF:BANDWIDTH=800000',
    'low/index.m3u8',
    '#EXT-X-ENDLIST',
  ].join('\n')
  const calls = stubOpener(service, (url) => ({
    response: new Response(playlist, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    }),
    finalUrl: url,
  }))
  const url = `${BASE}${MEDIA_ROUTE_PATH}/${token}/index.m3u8`
  const response = await route.resource(new Request(url), owner)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'application/vnd.apple.mpegurl')
  const body = await response.text()
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body)))
  // 所有 URI 行与 URI 属性都必须是指向代理的绝对地址，一个原地址都不能留。
  const rawUris = [...body.matchAll(/URI="([^"]*)"/g)].map((m) => m[1])
  for (const line of body.split('\n')) {
    if (line.trim() && !line.startsWith('#')) rawUris.push(line.trim())
  }
  assert.equal(rawUris.length, 5)
  for (const uri of rawUris) {
    assert.ok(uri.startsWith(`${BASE}${MEDIA_ROUTE_PATH}/`), uri)
  }
  assert.ok(!body.includes(`${HOST}/hls/seg1.ts`), '绝对分片不能保留原地址')

  const proxyTokens = [...body.matchAll(/\/reader\/media\/([A-Za-z0-9_-]{24})\//g)].map((m) => m[1])
  assert.equal(proxyTokens.length, 5)
  const restored = proxyTokens.map((value) => service.mediaRegistry.get(value).url).sort()
  assert.deepEqual(restored, [
    `${HOST}/hls/init.mp4`,
    `${HOST}/hls/k.key`,
    `${HOST}/hls/low/index.m3u8`,
    `${HOST}/hls/seg0.ts`,
    `${HOST}/hls/seg1.ts?token=abc`,
  ])
  const keyEntry = service.mediaRegistry.get(proxyTokens.find((value) => service.mediaRegistry.get(value).url.endsWith('k.key')))
  assert.equal(keyEntry.headers.Referer, playlistUrl)
  assert.equal(keyEntry.headers['X-Source'], undefined)

  // HEAD 也要报改写后的长度，但没有 body。
  const head = await route.resource(new Request(url, { method: 'HEAD' }), owner)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
  assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(body)))
  assert.equal(calls.length, 2)
})

test('HLS：playlist 里指向私网的地址直接拒绝，不发起请求', async () => {
  const service = makeService()
  const route = mountMediaRoute(service)
  const token = service.mediaRegistry.register(`${HOST}/hls/index.m3u8`, { kind: 'hls', ext: 'm3u8' })
  // 私网地址排在前面：一旦被拒，后面的分片一个都不该登记。
  const playlist = ['#EXTM3U', '#EXTINF:4,', 'http://127.0.0.1:8080/seg1.ts', '#EXTINF:4,', `${HOST}/hls/seg0.ts`].join(
    '\n',
  )
  const calls = stubOpener(service, (url) => ({
    response: new Response(playlist, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } }),
    finalUrl: url,
  }))
  const before = service.mediaRegistry.size()
  const response = await route.resource(new Request(`${BASE}${MEDIA_ROUTE_PATH}/${token}/index.m3u8`), owner)
  assert.equal(response.status, 403)
  assert.match(await response.text(), /播放列表包含不允许的地址/)
  assert.equal(calls.length, 1, '只抓 playlist，不抓私网分片')
  assert.equal(service.mediaRegistry.size(), before)
})

test('代理路由：过期 token 返回 404', async () => {
  const service = makeService()
  service.mediaRegistry = new MediaRegistry({ ttlMs: 0 })
  const route = mountMediaRoute(service)
  const token = service.mediaRegistry.register(`${HOST}/v/movie.mp4`, { kind: 'video' })
  const response = await route.resource(new Request(`${BASE}${MEDIA_ROUTE_PATH}/${token}/movie.mp4`), owner)
  assert.equal(response.status, 404)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { proxyResponse } from '../lib/media-http.js'
import { MEDIA_PROBE_TIMEOUT_MS, extractMediaCandidates, firstPlayableMedia, probeMediaUrl } from '../lib/media-probe.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://rss.example'
const DEAD = 'https://media.example/dead.mp4'
const LIVE = 'https://media.example/live.m3u8'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function source(extra = {}) {
  return {
    sourceName: '示例视频订阅',
    sourceUrl: SITE + '#',
    sortUrl: '视频::/video/page/{{page}}.html',
    header: JSON.stringify({
      'User-Agent': 'ExampleVideo/2.0',
      Referer: SITE + '/watch',
      Cookie: 'session=must-not-leak',
    }),
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleContent: '#player',
    ...extra,
  }
}

function listPage() {
  return '<div class="entry"><a href="/post/1" title="第一条视频">第一条视频</a></div>'
}

function playPage(candidates = [DEAD, LIVE]) {
  const video = candidates[0]?.endsWith('.mp4') ? '<video src="' + candidates[0] + '"></video>' : ''
  const literals = candidates.slice(candidates[0]?.endsWith('.mp4') ? 1 : 0)
    .map((url, index) => 'var source' + index + ' = "' + url.replace(/\//g, '\\/') + '";')
    .join('\n')
  return '<div id="player">' + video + '<script>' + literals + '</script></div>'
}

async function fixture(options = {}) {
  let live = options.live !== false
  const probes = []
  let fetches = 0
  const engine = new SourceEngine({
    fetch: async (url, config = {}) => {
      fetches += 1
      const path = new URL(url).pathname
      if (path === '/video/page/1.html') return response(url, listPage())
      if (path === '/post/1') return response(url, playPage(options.candidates))
      if (url === DEAD) throw Object.assign(new Error('404'), { status: 404 })
      if (url === LIVE) {
        probes.push({ method: config.method, headers: config.headers || {}, timeoutMs: config.timeoutMs })
        if (!live) throw Object.assign(new Error('404'), { status: 404 })
        return { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, text: '#EXTM3U' }
      }
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  return {
    service,
    db,
    book: added.books[0],
    sourceId: imported.sourceId,
    probes,
    fetches: () => fetches,
    setLive: (value) => { live = value },
  }
}

test('a video entry probes candidates in order, plays the first working address and caches it', async () => {
  const { service, book, db, probes, fetches } = await fixture()
  const toc = await service.toc({ bookId: book.id })
  const chapter = await service.toc({ bookId: book.id }).then(items => service.chapter({ bookId: book.id, chapterId: items[0].id }))

  assert.equal(toc.length, 1)
  assert.equal(chapter.mediaUrl, LIVE)
  assert.equal(chapter.text, undefined)
  const stored = db.chapters.get(toc[0].id)
  assert.equal(stored.mediaUrl, LIVE)
  // 分页原文只用于本次解析，不随章节永久落库。
  assert.equal('pages' in stored, false)
  assert.equal('raw' in stored, false)
  assert.equal('ruleHtml' in stored, false)
  assert.equal(probes.length, 1)
  assert.equal(probes[0].method, 'HEAD')
  assert.ok(probes[0].timeoutMs <= MEDIA_PROBE_TIMEOUT_MS && probes[0].timeoutMs > MEDIA_PROBE_TIMEOUT_MS - 20, '探测应使用剩余总预算')
  assert.equal(probes[0].headers.referer, SITE + '/watch')
  assert.equal(probes[0].headers['user-agent'], 'ExampleVideo/2.0')
  assert.equal(probes[0].headers.cookie, undefined)

  const before = fetches()
  await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(fetches(), before)
})

test('a long article with an ad video literal stays an article', async () => {
  const requested = []
  const longText = '正'.repeat(300)
  const engine = new SourceEngine({
    fetch: async (url) => {
      requested.push(url)
      const path = new URL(url).pathname
      if (path === '/video/page/1.html') return response(url, listPage())
      if (path === '/post/1') return response(url, '<div id="player"><p>' + longText + '</p><script>var ad = "https://ads.example/ad.mp4";</script></div>')
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  assert.equal(chapter.mediaUrl, undefined)
  assert.match(chapter.text, /正{10}/)
  assert.equal(requested.some((url) => url.includes('ads.example')), false)
})

test('when every media candidate fails a text fallback still renders', async () => {
  const engine = new SourceEngine({
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/video/page/1.html') return response(url, listPage())
      if (path === '/post/1') return response(url, '<div id="player"><video src="' + DEAD + '"></video><p>备用正文还在</p></div>')
      if (url === DEAD) throw Object.assign(new Error('404'), { status: 404 })
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  assert.equal(chapter.mediaUrl, undefined)
  assert.match(chapter.text, /备用正文还在/)
})

test('a text entry in a subscription still renders as blocks', async () => {
  const engine = new SourceEngine({
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/video/page/1.html') return response(url, listPage())
      if (path === '/post/1') return response(url, '<div id="player"><p>只有文字</p></div>')
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  assert.equal(chapter.text, '只有文字')
  assert.equal(chapter.mediaUrl, undefined)
})

test('all dead candidates fail with a readable retryable error and can be retried', async () => {
  const { service, book, setLive } = await fixture({ live: false })
  const toc = await service.toc({ bookId: book.id })
  await assert.rejects(service.chapter({ bookId: book.id, chapterId: toc[0].id }), /媒体地址失效/)
  setLive(true)
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.mediaUrl, LIVE)
})

test('the proxy plays a probed subscription video with the source headers', async () => {
  const { service, book, db } = await fixture()
  const toc = await service.toc({ bookId: book.id })
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.mediaUrl, LIVE)
  assert.equal(db.chapters.get(toc[0].id).headers.referer, SITE + '/watch')
  // 模拟进程重启：内存里的 streamHeaders 没了，仍要靠落库的条目头回放。
  service.streamHeaders.clear()
  const cached = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(cached.headers.referer, SITE + '/watch')

  const calls = []
  service.fetchRemote = async (url, options) => {
    calls.push({ url, options })
    return { status: 200, url, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, text: '#EXTM3U\n#EXT-X-ENDLIST' }
  }
  const response = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?bookId=' + book.id + '&chapterId=' + toc[0].id))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /mpegurl/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, LIVE)
  assert.equal(calls[0].options.headers.referer, SITE + '/watch')
  assert.equal(calls[0].options.headers.cookie, undefined)
})

test('a server that rejects HEAD is probed again with a one-byte range request', async () => {
  const calls = []
  const found = await probeMediaUrl('https://media.example/live.m3u8', {
    timeoutMs: 1234,
    headers: { referer: SITE + '/watch' },
    fetch: async (url, options) => {
      calls.push({ method: options.method, headers: options.headers, timeoutMs: options.timeoutMs })
      if (options.method === 'HEAD') return { status: 405, headers: {}, text: '' }
      return { status: 206, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, text: '' }
    },
  })
  assert.equal(found, 'https://media.example/live.m3u8')
  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET'])
  assert.equal(calls[1].headers.range, 'bytes=0-0')
  assert.equal(calls[1].headers.referer, SITE + '/watch')
  assert.equal(calls[1].timeoutMs, 1234)
})

test('probing five hanging candidates respects one overall budget', async () => {
  const started = Date.now()
  await assert.rejects(
    firstPlayableMedia(['https://media.example/1.mp4', 'https://media.example/2.mp4', 'https://media.example/3.mp4', 'https://media.example/4.mp4', 'https://media.example/5.mp4'], {
      fetch: () => new Promise(() => {}),
      timeoutMs: 40,
    }),
    /媒体地址失效/,
  )
  assert.ok(Date.now() - started < 1000, '总预算应远小于每个候选 8 秒叠加')
})

test('extractMediaCandidates keeps document order, dedupes and caps at five', () => {
  const html = [
    '<video src="/a.mp4"></video>',
    '<source src="https://cdn.example/b.m3u8">',
    '<script>var c = "https:\\/\\/cdn.example\\/c.m3u8"; var again = "https:\\/\\/cdn.example\\/c.m3u8";</script>',
    '<script>var d = "https://cdn.example/d.mp4"; var e = "https://cdn.example/e.m3u8"; var f = "https://cdn.example/f.mp4";</script>',
    '<img src="https://cdn.example/cover.jpg">',
  ].join('\n')
  const values = extractMediaCandidates(html, SITE)
  assert.deepEqual(values, [
    SITE + '/a.mp4',
    'https://cdn.example/b.m3u8',
    'https://cdn.example/c.m3u8',
    'https://cdn.example/d.mp4',
    'https://cdn.example/e.m3u8',
  ])
})

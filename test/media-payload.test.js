import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

function mediaSource(type, rules, host) {
  return {
    bookSourceName: `${type} 源`,
    bookSourceUrl: `https://${host}.example`,
    bookSourceType: type,
    search: { url: '/search?q={{key}}', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    ...rules,
  }
}

async function fixture(raw, fetch) {
  const engine = new SourceEngine({ fetch })
  const { service, db } = await serviceFixture(engine)
  await service.importSource({ text: JSON.stringify([raw]) })
  const record = (await service.state()).sources.find(item => item.id !== 'local')
  return { service, db, sourceId: record.id, source: record }
}

function page(title = '作品') {
  return `<!doctype html><h1>${title}</h1><div class="chapter"><a href="/chapter/1">第一章</a></div>`
}

async function runChain(raw, fetch) {
  const { service, db, sourceId } = await fixture(raw, fetch)
  const found = await service.search({ sourceId, query: '测试' })
  assert.equal(found.items.length, 1)
  const book = await service.addBook({ sourceId, bookUrl: found.items[0].bookUrl })
  const toc = await service.toc({ bookId: book.id })
  assert.equal(toc.length, 1)
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  return { service, db, book, chapter, sourceId }
}

test('novel media chain keeps text payload and content type', async () => {
  const fetch = async url => {
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">小说</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/chapter/')) return { url, headers: { 'content-type': 'text/html' }, text: '<main id="content"><p>第一段</p><p>第二段</p></main>' }
    return { url, headers: { 'content-type': 'text/html' }, text: page('小说') }
  }
  const { chapter, book } = await runChain(mediaSource(0, { content: { content: '#content' } }, 'novel'), fetch)
  assert.equal(book.contentType, 'novel')
  assert.equal(chapter.contentType, 'novel')
  assert.equal(chapter.text, '第一段\n第二段')
})

test('comic media chain returns ordered, unique, http(s) image urls', async () => {
  const fetch = async url => {
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">漫画</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/chapter/')) return {
      url,
      headers: { 'content-type': 'text/html' },
      text: '<main id="comic"><img data-src="/img/second.jpg"><img src="/img/first.jpg"><img src="/img/second.jpg"><img src="data:image/png;base64,AAAA"><img src="ftp://bad.example/x.jpg"></main>',
    }
    return { url, headers: { 'content-type': 'text/html' }, text: page('漫画') }
  }
  const { chapter, book } = await runChain(mediaSource(2, { content: { content: '#comic' } }, 'comic'), fetch)
  assert.equal(book.contentType, 'comic')
  assert.equal(chapter.contentType, 'comic')
  assert.deepEqual(chapter.images, ['https://comic.example/img/second.jpg', 'https://comic.example/img/first.jpg'])
})

test('audio media chain returns stream url and source headers', async () => {
  const fetch = async url => {
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">音频</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/chapter/')) return { url, headers: { 'content-type': 'text/html' }, text: '<audio id="player" data-src="/media/episode.m3u8"></audio>' }
    return { url, headers: { 'content-type': 'text/html' }, text: page('音频') }
  }
  const { chapter } = await runChain(mediaSource(1, {
    content: { content: '#player@data-src', headers: { Referer: 'https://audio.example/book/1', 'User-Agent': 'ReaderTest' } },
  }, 'audio'), fetch)
  assert.equal(chapter.contentType, 'audio')
  assert.equal(chapter.mediaUrl, 'https://audio.example/media/episode.m3u8')
  assert.deepEqual(chapter.headers, { Referer: 'https://audio.example/book/1', 'User-Agent': 'ReaderTest' })
})

test('video media chain supports JSON POST and JSONPath payloads', async () => {
  const calls = []
  const fetch = async (url, config) => {
    calls.push({ url, config })
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">视频</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/api/content')) return { url, headers: { 'content-type': 'application/json' }, text: '{"data":{"video":"https://cdn.video.example/episode.m3u8"}}' }
    return { url, headers: { 'content-type': 'text/html' }, text: page('视频') }
  }
  const { chapter } = await runChain(mediaSource(4, {
    content: {
      url: '/api/content',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://video.example/book/1' },
      body: '{"chapter":"{{chapterUrl}}"}',
      content: '$..video',
    },
  }, 'video'), fetch)
  const post = calls.find(call => call.url.endsWith('/api/content'))
  assert.equal(post.config.method, 'POST')
  assert.equal(post.config.jsonBody, true)
  assert.equal(post.config.body, '{"chapter":"https://video.example/chapter/1"}')
  assert.equal(chapter.contentType, 'video')
  assert.equal(chapter.mediaUrl, 'https://cdn.video.example/episode.m3u8')
  assert.equal(chapter.headers.Referer, 'https://video.example/book/1')
})

test('media payloads reject mismatch, empty images, empty streams and DRM', async () => {
  const engine = new SourceEngine({ fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<main id="comic"></main>' }) })
  const comic = {
    id: 'comic', name: 'comic', bookSourceUrl: 'https://comic.example', allowHttp: false, contentType: 'comic',
    rules: { content: { content: '#comic' } },
  }
  const chapter = { id: 'c1', title: '第一章', url: 'https://comic.example/chapter/1' }
  await assert.rejects(engine.content(comic, { bookUrl: 'https://comic.example/book/1', contentType: 'novel' }, chapter), error => error.code === 'reader/type-mismatch')
  await assert.rejects(engine.content(comic, { bookUrl: 'https://comic.example/book/1', contentType: 'comic' }, chapter), error => error.code === 'reader/parse-error' && error.details.chapter.id === 'c1')

  const audio = {
    ...comic, id: 'audio', contentType: 'audio', bookSourceUrl: 'https://audio.example',
    rules: { content: { content: '#player@data-src' } },
  }
  const noAudio = new SourceEngine({ fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<main></main>' }) })
  await assert.rejects(noAudio.content(audio, { bookUrl: 'https://audio.example/book/1', contentType: 'audio' }, chapter), error => error.code === 'reader/parse-error')

  const drm = new SourceEngine({ fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"' }) })
  await assert.rejects(drm.content(audio, { bookUrl: 'https://audio.example/book/1', contentType: 'audio' }, chapter), error => error.code === 'reader/unsupported-media')

  const mention = new SourceEngine({ fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<main>Widevine and FairPlay are unsupported.</main><audio id="player" data-src="/ok.mp3"></audio>' }) })
  const allowed = await mention.content(audio, { bookUrl: 'https://audio.example/book/1', contentType: 'audio' }, { ...chapter, url: 'https://audio.example/chapter/1' })
  assert.equal(allowed.mediaUrl, 'https://audio.example/ok.mp3')

  const poster = new SourceEngine({ fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<video poster="/poster.jpg"></video>' }) })
  const video = { ...audio, id: 'video', contentType: 'video', rules: { content: { content: '#movie' } } }
  await assert.rejects(poster.content(video, { bookUrl: 'https://video.example/book/1', contentType: 'video' }, chapter), error => error.code === 'reader/parse-error')
})

test('media payloads support XPath and JS rules', async () => {
  const html = '<div id="c"><img src="/a.jpg"><img src="/b.jpg"></div>'
  const engine = new SourceEngine({
    fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: html }),
  })
  const comic = {
    id: 'xpath-comic', name: 'XPath 漫画', bookSourceUrl: 'https://xpath.example', allowHttp: false, contentType: 'comic',
    rules: { content: { content: '//div[@id="c"]/img' } },
  }
  const audio = {
    id: 'js-audio', name: 'JS 音频', bookSourceUrl: 'https://js.example', allowHttp: false, contentType: 'audio',
    rules: { content: { content: '<js>"https://js.example/episode.m3u8"</js>' } },
  }
  const chapter = { id: 'c1', title: '第一章', url: 'https://xpath.example/chapter/1' }
  const comicPayload = await engine.content(comic, { bookUrl: 'https://xpath.example/book/1', contentType: 'comic' }, chapter)
  assert.deepEqual(comicPayload.images, ['https://xpath.example/a.jpg', 'https://xpath.example/b.jpg'])
  const audioPayload = await engine.content(audio, { bookUrl: 'https://js.example/book/1', contentType: 'audio' }, { ...chapter, url: 'https://js.example/chapter/1' })
  assert.equal(audioPayload.mediaUrl, 'https://js.example/episode.m3u8')
})

test('explicit comic image attributes do not leak placeholder src values', async () => {
  const engine = new SourceEngine({
    fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<div id="c"><img data-src="/real1.jpg" src="/loading.gif"><img data-src="/real2.jpg" src="/loading.gif"></div>' }),
  })
  const comic = {
    id: 'lazy-comic', name: '懒加载漫画', bookSourceUrl: 'https://lazy.example', allowHttp: false, contentType: 'comic',
    rules: { content: { content: '#c img@data-src' } },
  }
  const payload = await engine.content(comic, { bookUrl: 'https://lazy.example/book/1', contentType: 'comic' }, { id: 'c1', title: '第一章', url: 'https://lazy.example/chapter/1' })
  assert.deepEqual(payload.images, ['https://lazy.example/real1.jpg', 'https://lazy.example/real2.jpg'])
})

test('refreshing the toc preserves cached comic payloads', async () => {
  const fetch = async url => {
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">漫画</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/chapter/')) return { url, headers: { 'content-type': 'text/html' }, text: '<main id="comic"><img data-src="/img/one.jpg"></main>' }
    return { url, headers: { 'content-type': 'text/html' }, text: page('漫画') }
  }
  const { service, book, chapter } = await runChain(mediaSource(2, { content: { content: '#comic' } }, 'comic'), fetch)
  const toc = await service.toc({ bookId: book.id, refresh: true })
  assert.equal(toc[0].downloaded, true)
  const cached = await service.chapter({ bookId: book.id, chapterId: chapter.id })
  assert.deepEqual(cached.images, ['https://comic.example/img/one.jpg'])
})

test('downloading a comic caches its image payload as a completed chapter', async () => {
  const fetch = async url => {
    if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="book"><span class="name">漫画</span><a href="/book/1">详情</a></div>' }
    if (url.includes('/chapter/')) return { url, headers: { 'content-type': 'text/html' }, text: '<main id="comic"><img data-src="/img/one.jpg"></main>' }
    return { url, headers: { 'content-type': 'text/html' }, text: page('漫画') }
  }
  const { service, db, book, chapter } = await runChain(mediaSource(2, { content: { content: '#comic' } }, 'comic'), fetch)
  const job = await service.download({ bookId: book.id })
  await service.runningJobs.get(job.id)
  const stored = db.chapters.get(chapter.id)
  assert.deepEqual(stored.images, ['https://comic.example/img/one.jpg'])
  assert.equal(stored.text, undefined)
  const view = (await service.state()).books.find(item => item.id === book.id)
  assert.equal(view.download.status, 'completed')
  assert.equal(view.download.done, 1)
})

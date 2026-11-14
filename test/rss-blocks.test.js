import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SUBSCRIPTION_PAYLOAD_VERSION } from '../lib/content-types.js'
import { MediaStore } from '../lib/media-store.js'
import { proxyResponse } from '../lib/media-http.js'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://rss.example'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function source() {
  return {
    sourceName: '图文订阅',
    sourceUrl: SITE + '#',
    sortUrl: '图文::/news/page/{{page}}.html',
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleImage: 'img@src',
    rulePubDate: '.date@text',
    ruleContent: '#article',
  }
}

function listPage() {
  return '<div class="entry"><a href="/post/1" title="一篇图文">一篇图文</a><img src="/cover/1.jpg"><span class="date">2026-11-13 09:00</span></div>'
}

function detail(body) {
  return '<!doctype html><html><body><div id="article">' + body + '</div></body></html>'
}

async function fixture(t, body) {
  const article = detail(body)
  const engine = new SourceEngine({
    fetch: async (url) => {
      const pathname = new URL(url).pathname
      if (pathname === '/news/page/1.html') return response(url, listPage())
      if (pathname === '/post/1') return response(url, article)
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  return { service, db, book: added.books[0], chapterId: toc[0].id }
}

test('an HTML entry becomes ordered blocks and keeps images between paragraphs', async (t) => {
  const { service, book, chapterId } = await fixture(t, [
    '<h2>小标题</h2>',
    '<p>第一段<img src="/img/one.jpg" alt="图一">尾巴</p>',
    '<blockquote>引用一句</blockquote>',
    '<pre><code>const x = 1</code></pre>',
    '<ul><li>甲</li><li>乙</li></ul>',
  ].join(''))

  const chapter = await service.chapter({ bookId: book.id, chapterId })
  assert.deepEqual(chapter.blocks.map((block) => block.type), [
    'heading', 'paragraph', 'image', 'paragraph', 'quote', 'code', 'list',
  ])
  assert.equal(chapter.blocks[0].level, 2)
  assert.equal(chapter.blocks[0].text, '小标题')
  assert.equal(chapter.blocks[1].text, '第一段')
  assert.equal(chapter.blocks[2].url, SITE + '/img/one.jpg')
  assert.equal(chapter.blocks[2].alt, '图一')
  assert.equal(chapter.blocks[3].text, '尾巴')
  assert.equal(chapter.blocks[4].text, '引用一句')
  assert.equal(chapter.blocks[5].text, 'const x = 1')
  assert.deepEqual(chapter.blocks[6].items, ['甲', '乙'])
  assert.equal(chapter.blocks[6].ordered, false)
  assert.match(chapter.text, /第一段/)
  assert.equal(chapter.text.includes('<'), false)

  const cached = await service.chapter({ bookId: book.id, chapterId })
  assert.deepEqual(cached.blocks, chapter.blocks)
})

test('images inside quotes and lists keep their place instead of disappearing', async (t) => {
  const { service, book, chapterId } = await fixture(t, [
    '<blockquote><p>引用一</p><p>引用二<img src="/img/q.jpg" alt="引图"></p></blockquote>',
    '<ul><li>甲<img src="/img/l.jpg" alt="列图"></li><li>乙</li></ul>',
  ].join(''))
  const chapter = await service.chapter({ bookId: book.id, chapterId })
  assert.deepEqual(chapter.blocks.map((block) => block.type), [
    'quote', 'quote', 'image', 'list', 'image', 'list',
  ])
  assert.equal(chapter.blocks[0].text, '引用一')
  assert.equal(chapter.blocks[1].text, '引用二')
  assert.equal(chapter.blocks[2].url, SITE + '/img/q.jpg')
  assert.deepEqual(chapter.blocks[3].items, ['甲'])
  assert.equal(chapter.blocks[4].url, SITE + '/img/l.jpg')
  assert.deepEqual(chapter.blocks[5].items, ['乙'])
})

test('srcset is used when an image has no src attribute', async (t) => {
  const { service, book, chapterId } = await fixture(t, '<p>前文</p><img srcset="/small.jpg 480w, /large.jpg 960w" alt="图"><p>后文</p>')
  const chapter = await service.chapter({ bookId: book.id, chapterId })
  const image = chapter.blocks.find((block) => block.type === 'image')
  assert.equal(image.url, SITE + '/small.jpg')
  assert.equal(image.alt, '图')
})

test('scripts and iframes are removed instead of being rendered', async (t) => {
  const { service, book, chapterId } = await fixture(t, '<p>安全<script>alert(1)</script><iframe src="https://evil.example/frame"></iframe>文本</p>')
  const chapter = await service.chapter({ bookId: book.id, chapterId })
  const serialized = JSON.stringify(chapter.blocks)
  assert.equal(serialized.includes('alert(1)'), false)
  assert.equal(serialized.includes('evil.example'), false)
  assert.deepEqual(chapter.blocks, [{ type: 'paragraph', text: '安全文本' }])
})

test('an unreadable text-only entry still returns its stored text', async (t) => {
  const { service, db } = await serviceFixture()
  const source = { id: 'source-old', name: '旧源', bookSourceUrl: SITE, allowHttp: false, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-old', name: '旧订阅', sourceId: source.id, contentType: 'subscription', local: false }
  const chapter = { id: 'chapter-old', bookId: book.id, index: 0, title: '旧条目', contentType: 'subscription', text: '旧正文\n第二段' }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  const loaded = await service.chapter({ bookId: book.id, chapterId: chapter.id })
  assert.equal(loaded.text, '旧正文\n第二段')
  assert.equal(loaded.blocks, undefined)
})

test('a text-only entry from the previous version is refreshed into blocks once', async (t) => {
  let fetches = 0
  const article = detail('<h2>小标题</h2><p>新正文</p>')
  const engine = new SourceEngine({
    fetch: async (url) => {
      fetches += 1
      const pathname = new URL(url).pathname
      if (pathname === '/news/page/1.html') return response(url, listPage())
      if (pathname === '/post/1') return response(url, article)
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const stored = db.chapters.get(toc[0].id)
  await db.chapters.put(stored.id, { ...stored, text: '旧正文' })

  const loaded = await service.chapter({ bookId: added.books[0].id, chapterId: stored.id })
  assert.deepEqual(loaded.blocks.map((block) => block.type), ['heading', 'paragraph'])
  assert.equal(db.chapters.get(stored.id).payloadVersion, SUBSCRIPTION_PAYLOAD_VERSION)
  const before = fetches
  await service.chapter({ bookId: added.books[0].id, chapterId: stored.id })
  assert.equal(fetches, before)
})

test('relative images resolve against the final content page URL', async (t) => {
  const engine = new SourceEngine({
    fetch: async (url) => {
      const pathname = new URL(url).pathname
      if (pathname === '/news/page/1.html') return response(url, listPage())
      if (pathname === '/post/1') return response('https://cdn.example/articles/1/', detail('<p>正文</p><img src="pic.jpg" alt="图">'))
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  const image = chapter.blocks.find((block) => block.type === 'image')
  assert.equal(image.url, 'https://cdn.example/articles/1/pic.jpg')
})

test('a feed summary falls back to blocks when the entry has no content rule', async (t) => {
  const engine = new SourceEngine({ fetch: async (url) => { throw new Error('unexpected URL ' + url) } })
  const { service, db } = await serviceFixture(engine)
  const source = { id: 'source-summary', name: '摘要源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-summary', sourceId: source.id, contentType: 'subscription', name: '摘要订阅' }
  const chapter = {
    id: 'chapter-summary', bookId: book.id, index: 0, title: '摘要条目', contentType: 'subscription',
    url: SITE + '/post/summary', description: '<blockquote>引用摘要</blockquote><p>摘要正文</p>',
  }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  const loaded = await service.chapter({ bookId: book.id, chapterId: chapter.id })
  assert.deepEqual(loaded.blocks, [
    { type: 'quote', text: '引用摘要' },
    { type: 'paragraph', text: '摘要正文' },
  ])
  assert.match(loaded.text, /引用摘要/)
})

test('a block-only summary keeps its semantics and images', async (t) => {
  const engine = new SourceEngine({ fetch: async (url) => { throw new Error('unexpected URL ' + url) } })
  const { service, db } = await serviceFixture(engine)
  const source = { id: 'source-summary-block', name: '摘要源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-summary-block', sourceId: source.id, contentType: 'subscription', name: '摘要订阅' }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  const cases = [
    { id: 'quote', description: '<blockquote>只有引用</blockquote>', expected: ['quote'] },
    { id: 'list', description: '<ul><li>甲<img src="/x.jpg" alt="图"></li></ul>', expected: ['list', 'image'] },
    { id: 'image', description: '<img src="/only.jpg" alt="只有图">', expected: ['image'] },
    { id: 'code', description: '<pre><code>const a = 1</code></pre>', expected: ['code'] },
  ]
  for (const item of cases) {
    const chapter = { id: 'chapter-summary-' + item.id, bookId: book.id, index: 0, title: item.id, contentType: 'subscription', url: SITE + '/post/' + item.id, description: item.description }
    await db.chapters.put(chapter.id, chapter)
    const loaded = await service.chapter({ bookId: book.id, chapterId: chapter.id })
    assert.deepEqual(loaded.blocks.map((block) => block.type), item.expected)
  }
})

test('refreshing the entry list keeps stored blocks', async (t) => {
  const { service, db, book, chapterId } = await fixture(t, '<p>第一段</p><p>第二段</p>')
  const first = await service.chapter({ bookId: book.id, chapterId })
  assert.equal(first.blocks.length, 2)
  await service.toc({ bookId: book.id, refresh: true })
  const stored = db.chapters.get(chapterId)
  assert.deepEqual(stored.blocks.map((block) => block.type), ['paragraph', 'paragraph'])
  const again = await service.chapter({ bookId: book.id, chapterId })
  assert.deepEqual(again.blocks, first.blocks)
})

test('a subscription image is cached after the first proxy request', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mo-reader-blocks-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = new MediaStore({ root })
  await store.init()
  const { service, db } = await serviceFixture({}, { mediaStore: store })
  const source = { id: 'source-image', name: '图源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-image', sourceId: source.id, contentType: 'subscription', name: '图文订阅' }
  const chapter = {
    id: 'chapter-image', bookId: book.id, index: 0, title: '一篇图文', contentType: 'subscription', text: '',
    blocks: [{ type: 'image', url: SITE + '/img/one.jpg', alt: '图一' }],
  }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  let fetches = 0
  service.fetchRemote = async (url) => {
    fetches += 1
    return { status: 200, url, headers: { 'content-type': 'image/png', 'content-length': '3' }, buffer: Buffer.from('png') }
  }
  const request = () => new Request('http://reader.local/api/reader/proxy?bookId=' + book.id + '&chapterId=' + chapter.id + '&block=0')
  const first = await proxyResponse(service, request())
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.equal(await first.text(), 'png')
  const second = await proxyResponse(service, request())
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('content-type'), 'image/png')
  assert.equal(second.headers.get('cache-control'), 'private, max-age=86400')
  assert.equal(await second.text(), 'png')
  assert.equal(fetches, 1)
})

test('a block image response must really be an image', async (t) => {
  const { service, db } = await serviceFixture()
  const source = { id: 'source-html', name: '图源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-html', sourceId: source.id, contentType: 'subscription', name: '图文订阅' }
  const chapter = {
    id: 'chapter-html', bookId: book.id, index: 0, title: '一条', contentType: 'subscription', text: '',
    blocks: [{ type: 'image', url: SITE + '/img/fake.jpg', alt: '' }],
  }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  service.fetchRemote = async (url) => ({ status: 200, url, headers: { 'content-type': 'text/html' }, text: '<html></html>' })
  const response = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?bookId=' + book.id + '&chapterId=' + chapter.id + '&block=0'))
  assert.equal(response.status, 415)
  assert.equal((await response.json()).error, 'reader/unsupported-media')
})

test('a subscription entry cover goes through the media proxy and is cached', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-rss-cover-'))
  const store = new MediaStore({ root, quotaBytes: 4 * 1024 * 1024 })
  await store.init()
  const { service, db } = await serviceFixture({}, { mediaStore: store })
  const source = { id: 'source-cover', name: '图源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-cover', sourceId: source.id, contentType: 'subscription', name: '图文订阅' }
  const chapter = {
    id: 'chapter-cover', bookId: book.id, index: 0, title: '一篇图文', contentType: 'subscription', text: '',
    coverUrl: SITE + '/cover/1.jpg', blocks: [{ type: 'paragraph', text: '正文' }],
  }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  let fetches = 0
  service.fetchRemote = async (url) => {
    fetches += 1
    return { status: 200, url, headers: { 'content-type': 'image/jpeg', 'content-length': '3' }, buffer: Buffer.from('jpg') }
  }
  const request = () => new Request('http://reader.local/api/reader/proxy?bookId=' + book.id + '&chapterId=' + chapter.id + '&cover=1')
  const first = await proxyResponse(service, request())
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('content-type'), 'image/jpeg')
  assert.equal(await first.text(), 'jpg')
  const second = await proxyResponse(service, request())
  assert.equal(second.status, 200)
  assert.equal(second.headers.get('cache-control'), 'private, max-age=86400')
  assert.equal(await second.text(), 'jpg')
  assert.equal(fetches, 1)
})

test('a cover request without a cover is refused', async () => {
  const { service, db } = await serviceFixture()
  const source = { id: 'source-nocover', name: '图源', bookSourceUrl: SITE, allowHttp: false, enabled: true, kind: 'rss', contentType: 'subscription', rules: {} }
  const book = { id: 'book-nocover', sourceId: source.id, contentType: 'subscription', name: '图文订阅' }
  const chapter = { id: 'chapter-nocover', bookId: book.id, index: 0, title: '一篇图文', contentType: 'subscription', text: '', blocks: [] }
  await db.sources.put(source.id, source)
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)
  const response = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?bookId=' + book.id + '&chapterId=' + chapter.id + '&cover=1'))
  assert.equal(response.status, 404)
  assert.equal((await response.json()).error, 'reader/media-not-found')
})

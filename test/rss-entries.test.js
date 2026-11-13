import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://rss.example'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function entry(id, title, date) {
  return '<div class="entry"><a href="/post/' + id + '" title="' + title + '">' + title + '</a><img src="/cover/' + id + '.jpg"><span class="date">' + date + '</span></div>'
}

function rssSource() {
  return {
    sourceName: '示例订阅',
    sourceUrl: SITE + '#',
    sortUrl: '新闻::/news/page/{{page}}.html',
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleImage: 'img@src',
    rulePubDate: '.date@text',
    ruleNextPage: 'page',
    ruleContent: '#article',
  }
}

function pages() {
  return {
    '/news/page/1.html': entry(1, '第一篇', '2026-11-13 09:00') + entry(2, '第二篇', '2026-11-12 09:00'),
    '/news/page/2.html': entry(3, '第三篇', '2026-11-11 09:00') + entry(1, '第一篇', '2026-11-13 09:00'),
    '/news/page/3.html': entry(4, '第四篇', '2026-11-10 09:00'),
  }
}

function detail(text) {
  return '<!doctype html><html><body><div id="article">' + text + '</div></body></html>'
}

async function fixture(options = {}) {
  const maxTocPages = options.maxTocPages || 3
  const article = options.article || detail('<p>第一段</p><p>第二段</p>')
  const content = pages()
  let fail = false
  let fetches = 0
  const engine = new SourceEngine({
    maxTocPages,
    fetch: async (url, config = {}) => {
      fetches += 1
      if (fail) throw new Error('network down')
      const path = new URL(url).pathname
      if (content[path]) return response(url, content[path])
      if (/^\/post\/\d+$/.test(path)) return response(url, path === '/post/3' ? detail('') : article)
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(rssSource()) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  return {
    service,
    db,
    sourceId: imported.sourceId,
    book: added.books[0],
    fetches: () => fetches,
    fail: (value) => { fail = value },
  }
}

test('first toc pulls entries across pages, dedupes links and reads one entry as text', async () => {
  const { service, book, fetches } = await fixture({ maxTocPages: 2 })
  const toc = await service.toc({ bookId: book.id })

  assert.equal(toc.length, 3)
  assert.deepEqual(toc.map((item) => item.title), ['第一篇', '第二篇', '第三篇'])
  assert.equal(toc[0].url, SITE + '/post/1')
  assert.equal(toc[0].coverUrl, SITE + '/cover/1.jpg')
  assert.equal(toc[0].publishedAt, '2026-11-13 09:00')
  assert.equal(fetches(), 2)

  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.text, '第一段\n第二段')

  const count = fetches()
  await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(fetches(), count)
})

test('reopening the same subscription keeps entries and their order', async () => {
  const { service, book, fetches } = await fixture()
  const first = await service.toc({ bookId: book.id })
  const afterFirst = fetches()

  const cached = await service.toc({ bookId: book.id })
  assert.deepEqual(cached.map((item) => item.id), first.map((item) => item.id))
  assert.equal(fetches(), afterFirst)

  const refreshed = await service.toc({ bookId: book.id, refresh: true })
  assert.deepEqual(refreshed.map((item) => item.id), first.map((item) => item.id))
  assert.equal(refreshed.length, first.length)
})

test('a failed refresh keeps the existing directory and reports a readable error', async () => {
  const { service, book, fail } = await fixture()
  const first = await service.toc({ bookId: book.id })
  fail(true)

  await assert.rejects(service.toc({ bookId: book.id, refresh: true }), /network down/)
  const cached = await service.toc({ bookId: book.id })
  assert.deepEqual(cached.map((item) => item.id), first.map((item) => item.id))
})

test('an entry without any text reports a readable error instead of an empty page', async () => {
  const { service, book } = await fixture()
  const toc = await service.toc({ bookId: book.id })
  await assert.rejects(service.chapter({ bookId: book.id, chapterId: toc[2].id }), /没有正文/)
})

test('a category page without entries reports a readable error and names dropped capabilities', async () => {
  const engine = new SourceEngine({
    fetch: async (url) => response(url, '<div></div>'),
  })
  const { service } = await serviceFixture(engine)
  const source = { ...rssSource(), enabledCookieJar: true }
  const imported = await service.importSource({ text: JSON.stringify(source) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  await assert.rejects(service.toc({ bookId: added.books[0].id }), /没有解析到条目.*Cookie/)
})

test('an entry without a content rule falls back to the list description', async () => {
  const source = { ...rssSource(), ruleContent: undefined, ruleNextPage: undefined, ruleDescription: '.summary@text' }
  const engine = new SourceEngine({
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/news/page/1.html') {
        return response(url, '<div class="entry"><a href="/post/5" title="摘要条目">摘要条目</a><span class="summary">摘要第一段\n摘要第二段</span></div>')
      }
      throw new Error('detail page should not be fetched: ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  assert.equal(chapter.text, '摘要第一段\n摘要第二段')
})

test('entries are ordered newest first even when the list page is not', async () => {
  const source = { ...rssSource(), ruleNextPage: undefined }
  const engine = new SourceEngine({
    fetch: async (url) => response(url, entry(2, '旧的一篇', '2026-11-12 09:00') + entry(1, '新的一篇', '2026-11-13 09:00')),
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  assert.deepEqual(toc.map((item) => item.title), ['新的一篇', '旧的一篇'])
})

test('a URL template in ruleNextPage advances to the next page', async () => {
  const source = { ...rssSource(), ruleNextPage: '/news/page/{{page}}.html' }
  const content = pages()
  const engine = new SourceEngine({
    maxTocPages: 2,
    fetch: async (url) => response(url, content[new URL(url).pathname]),
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  assert.equal(toc.length, 3)
})

test('an empty content rule still falls back to the list summary', async () => {
  const source = { ...rssSource(), ruleContent: '#missing', ruleNextPage: undefined, ruleDescription: '.summary@text' }
  const engine = new SourceEngine({
    fetch: async (url) => {
      if (new URL(url).pathname === '/news/page/1.html') {
        return response(url, '<div class="entry"><a href="/post/6" title="摘要条目">摘要条目</a><span class="summary">摘要第一段\n摘要第二段</span></div>')
      }
      return response(url, detail('<p>没有命中的正文</p>'))
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(source) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const toc = await service.toc({ bookId: added.books[0].id })
  const chapter = await service.chapter({ bookId: added.books[0].id, chapterId: toc[0].id })
  assert.equal(chapter.text, '摘要第一段\n摘要第二段')
})

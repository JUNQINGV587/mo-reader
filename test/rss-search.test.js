import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://rss.example'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function entry(id, title, date) {
  return '<div class="entry"><a href="/post/' + id + '" title="' + title + '">' + title + '</a><img src="/cover/' + id + '.jpg"><span class="date">' + date + '</span><span class="summary">摘要 ' + id + '</span></div>'
}

function rssSource() {
  return {
    sourceName: '示例订阅',
    sourceUrl: SITE + '#',
    sortUrl: '新闻::/news/page/{{page}}.html',
    searchUrl: '/search/page/{{page}}/wd/{{key}}.html',
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleImage: 'img@src',
    rulePubDate: '.date@text',
    ruleDescription: '.summary@text',
    ruleContent: '#article',
  }
}

function pages() {
  return {
    '/news/page/1.html': entry(1, '第一篇', '2026-11-13 09:00') + entry(2, '第二篇', '2026-11-12 09:00'),
    '/search/page/1/wd/%E9%BA%BB%E8%B1%86.html': entry(9, '搜索结果', '2026-11-14 09:00') + entry(1, '第一篇', '2026-11-13 09:00'),
  }
}

async function fixture(options = {}) {
  const content = pages()
  let fetches = 0
  const engine = new SourceEngine({
    maxTocPages: 2,
    fetch: async (url) => {
      fetches += 1
      const path = new URL(url).pathname
      if (content[path]) return response(url, content[path])
      if (/^\/post\/\d+$/.test(path)) return response(url, '<div id="article"><p>' + path + ' 正文</p></div>')
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify({ ...rssSource(), ...(options.source || {}) }) })
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  return { service, imported, book: added.books[0], fetches: () => fetches }
}

test('searchSubscription renders the searchUrl with the query and returns entries', async () => {
  const { service, book, fetches } = await fixture()
  const result = await service.searchSubscription({ bookId: book.id, query: '麻豆' })
  assert.equal(result.page, 1)
  assert.equal(result.hasMore, false)
  assert.deepEqual(result.items.map((item) => item.title), ['搜索结果', '第一篇'])
  assert.equal(result.items[0].url, SITE + '/post/9')
  assert.equal(result.items[0].coverUrl, SITE + '/cover/9.jpg')
  assert.equal(result.items[0].publishedAt, '2026-11-14 09:00')
  assert.equal(result.items[0].description, '摘要 9')
  assert.equal(fetches(), 1)
})

test('searchSubscription validates the query before marking the source failed', async () => {
  const { service, book } = await fixture()
  await assert.rejects(
    service.searchSubscription({ bookId: book.id, query: '' }),
    (error) => error.code === 'reader/invalid-input',
  )
  const listed = await service.state()
  assert.equal(listed.sources.find((item) => item.id === book.sourceId).lastError, undefined)
})

test('searchSubscription refuses a subscription without a searchUrl', async () => {
  const { service, book } = await fixture({ source: { searchUrl: undefined } })
  await assert.rejects(
    service.searchSubscription({ bookId: book.id, query: '麻豆' }),
    (error) => error.code === 'reader/unsupported-source' && /没有提供搜索/.test(error.message),
  )
})

test('openSubscriptionEntry adds a search result to the subscription once and opens its content', async () => {
  const { service, book } = await fixture()
  await service.toc({ bookId: book.id })
  const result = await service.searchSubscription({ bookId: book.id, query: '麻豆' })
  const opened = await service.openSubscriptionEntry({
    bookId: book.id,
    title: result.items[0].title,
    url: result.items[0].url,
    coverUrl: result.items[0].coverUrl,
    publishedAt: result.items[0].publishedAt,
    description: result.items[0].description,
  })
  assert.equal(opened.title, '搜索结果')
  assert.equal(opened.publishedAt, '2026-11-14 09:00')

  const toc = await service.toc({ bookId: book.id })
  assert.deepEqual(toc.map((item) => item.title), ['搜索结果', '第一篇', '第二篇'])
  assert.equal(toc[0].id, opened.id)

  const again = await service.openSubscriptionEntry({
    bookId: book.id,
    title: '换了标题也不应重复',
    url: result.items[0].url,
  })
  assert.equal(again.id, opened.id)
  assert.equal((await service.toc({ bookId: book.id })).length, 3)

  const chapter = await service.chapter({ bookId: book.id, chapterId: opened.id })
  assert.match(chapter.text, /正文/)
})

test('openSubscriptionEntry refuses a URL outside the source address', async () => {
  const { service, book } = await fixture()
  await assert.rejects(
    service.openSubscriptionEntry({ bookId: book.id, title: '坏结果', url: 'https://127.0.0.1/post/1' }),
    (error) => error.code === 'reader/ssrf-blocked',
  )
})

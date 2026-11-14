import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { REMOTE_METHODS } from '../index.js'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://rss.example'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function entry(id, title) {
  return '<div class="entry"><a href="/post/' + id + '" title="' + title + '">' + title + '</a><span class="date">2026-11-13</span></div>'
}

function rssSource() {
  return {
    sourceName: '示例订阅',
    sourceUrl: SITE + '#',
    sortUrl: '新闻::/news/page/{{page}}.html\n其它::/other/page/{{page}}.html',
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    rulePubDate: '.date@text',
    ruleNextPage: 'page',
    ruleContent: '#article',
  }
}

function page(ids, other = false) {
  return ids.map((id) => entry(id, (other ? '其它' : '新闻') + id)).join('')
}

function detail(id) {
  return '<!doctype html><html><body><div id="article"><p>正文' + id + '</p></div></body></html>'
}

async function fixture() {
  const lists = { news: [2, 1], other: [9] }
  const engine = new SourceEngine({
    maxTocPages: 2,
    fetch: async (url) => {
      const path = new URL(url).pathname
      if (path === '/news/page/1.html') return response(url, page(lists.news))
      if (path === '/other/page/1.html') return response(url, page(lists.other, true))
      if (/^\/(?:news|other)\/page\/\d+\.html$/.test(path)) return response(url, '')
      const match = path.match(/^\/post\/(\d+)$/)
      if (match) return response(url, detail(match[1]))
      throw new Error('unexpected URL ' + url)
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(rssSource()) })
  const category = (name) => imported.categories.find((item) => item.name === name).url
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [category('新闻'), category('其它')] })
  const book = (name) => added.books.find((item) => item.name === name)
  return { service, db, sourceId: imported.sourceId, news: book('新闻'), other: book('其它'), lists }
}

function currentBook(service, bookId) {
  return service.bookView(service.book(bookId))
}

test('opening a subscription entry counts down unread once and never below zero', async () => {
  const { service, news } = await fixture()
  const toc = await service.toc({ bookId: news.id })
  assert.equal(currentBook(service, news.id).unread, 2)

  const first = await service.markChapterRead({ bookId: news.id, chapterId: toc[0].id })
  assert.equal(first.unread, 1)
  assert.equal(typeof (await service.toc({ bookId: news.id }))[0].readAt, 'string')

  const again = await service.markChapterRead({ bookId: news.id, chapterId: toc[0].id })
  assert.equal(again.unread, 1)
  assert.equal(currentBook(service, news.id).unread, 1)

  assert.equal((await service.markChapterRead({ bookId: news.id, chapterId: toc[1].id })).unread, 0)
  assert.equal((await service.markChapterRead({ bookId: news.id, chapterId: toc[1].id })).unread, 0)
})

test('marking a subscription read clears every entry and keeps later entries unread', async () => {
  const { service, news, lists } = await fixture()
  await service.toc({ bookId: news.id })

  const marked = await service.markBookRead({ bookId: news.id })
  assert.equal(marked.unread, 0)
  const toc = await service.toc({ bookId: news.id })
  assert.ok(toc.every((item) => typeof item.readAt === 'string'))

  lists.news = [5, 2, 1]
  const refreshed = await service.toc({ bookId: news.id, refresh: true })
  assert.equal(refreshed.length, 3)
  assert.equal(refreshed.find((item) => item.title === '新闻5').readAt, undefined)
  assert.equal(currentBook(service, news.id).unread, 1)
  assert.equal((await service.markBookRead({ bookId: news.id })).unread, 0)
})

test('unread is isolated per subscription from the same source', async () => {
  const { service, news, other } = await fixture()
  const newsToc = await service.toc({ bookId: news.id })
  await service.toc({ bookId: other.id })
  await service.markChapterRead({ bookId: news.id, chapterId: newsToc[0].id })

  assert.equal(currentBook(service, news.id).unread, 1)
  assert.equal(currentBook(service, other.id).unread, 1)
  await service.markBookRead({ bookId: other.id })
  assert.equal(currentBook(service, other.id).unread, 0)
  assert.equal(currentBook(service, news.id).unread, 1)
})

test('legacy subscriptions without readBaselineAt start fully read, then only new entries are unread', async () => {
  const { service, db, news, lists } = await fixture()
  await service.toc({ bookId: news.id })
  const legacy = db.books.get(news.id)
  delete legacy.readBaselineAt
  await db.books.put(news.id, legacy)
  for (const chapter of service.chapters(news.id)) {
    delete chapter.readAt
    await db.chapters.put(chapter.id, chapter)
  }

  const state = await service.state()
  assert.equal(state.books.find((book) => book.id === news.id).unread, 0)

  lists.news = [7, 2, 1]
  const refreshed = await service.toc({ bookId: news.id, refresh: true })
  assert.equal(refreshed.length, 3)
  assert.equal((await service.state()).books.find((book) => book.id === news.id).unread, 1)
  assert.ok(service.chapters(news.id).filter((chapter) => chapter.title !== '新闻7').every((chapter) => typeof chapter.readAt === 'string'))
  const baseline = db.books.get(news.id).readBaselineAt
  assert.equal(typeof baseline, 'string')

  lists.news = [8, 7, 2, 1]
  await service.toc({ bookId: news.id, refresh: true })
  assert.equal(db.books.get(news.id).readBaselineAt, baseline)
  assert.equal((await service.state()).books.find((book) => book.id === news.id).unread, 2)
})

test('a legacy subscription with no cache treats its first fetched batch as read', async () => {
  const { service, db, news, lists } = await fixture()
  const legacy = db.books.get(news.id)
  delete legacy.readBaselineAt
  await db.books.put(news.id, legacy)
  for (const chapter of service.chapters(news.id)) await db.chapters.delete(chapter.id)
  assert.equal(service.chapters(news.id).length, 0)

  lists.news = [4, 3, 2, 1]
  const first = await service.toc({ bookId: news.id, refresh: true })
  assert.equal(first.length, 4)
  assert.ok(first.every((item) => typeof item.readAt === 'string'))
  assert.equal(currentBook(service, news.id).unread, 0)

  lists.news = [5, 4, 3, 2, 1]
  await service.toc({ bookId: news.id, refresh: true })
  assert.equal(currentBook(service, news.id).unread, 1)
})

test('a refresh keeps earlier entries read when new entries arrive', async () => {
  const { service, news, lists } = await fixture()
  const toc = await service.toc({ bookId: news.id })
  const first = toc[0]
  await service.markChapterRead({ bookId: news.id, chapterId: first.id })
  const before = (await service.toc({ bookId: news.id })).find((item) => item.id === first.id).readAt
  assert.equal(typeof before, 'string')
  assert.equal(currentBook(service, news.id).unread, 1)

  lists.news = [6, 2, 1]
  const refreshed = await service.toc({ bookId: news.id, refresh: true })
  assert.equal(refreshed.find((item) => item.id === first.id).readAt, before)
  assert.equal(refreshed.find((item) => item.title === '新闻6').readAt, undefined)
  assert.equal(currentBook(service, news.id).unread, 2)
})

test('markChapterRead does not change novels and markBookRead keeps their old behaviour', async () => {
  const { service, db } = await serviceFixture({})
  const book = { id: 'novel-1', sourceId: 'missing', name: '小说', contentType: 'novel', local: true }
  const chapter = { id: 'chapter-1', bookId: book.id, index: 0, title: '第一章', text: '正文' }
  await db.books.put(book.id, book)
  await db.chapters.put(chapter.id, chapter)

  const result = await service.markChapterRead({ bookId: book.id, chapterId: chapter.id })
  assert.equal(result.unread, 1)
  assert.equal(db.chapters.get(chapter.id).readAt, undefined)

  await service.markBookRead({ bookId: book.id })
  assert.equal(typeof db.books.get(book.id).readAt, 'string')
  assert.equal(db.chapters.get(chapter.id).readAt, undefined)
})

test('markChapterRead is exposed through the host and the client bridge', () => {
  assert.ok(REMOTE_METHODS.includes('markChapterRead'))
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /'markChapterRead'/)
})

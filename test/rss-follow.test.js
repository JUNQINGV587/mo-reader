import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'
import { chapterId } from '../lib/utils.js'

const SITE = 'https://follow.example'

function entry(id, publishedAt, title = `标题${id}`) {
  return '<div class="entry"><a class="link" href="/post/' + id + '" title="' + title + '">' + title + '</a><span class="date">' + (publishedAt || '') + '</span></div>'
}

function page(items) {
  return items.map((item) => entry(item.id, item.publishedAt, item.title)).join('')
}

function detail(id) {
  return '<!doctype html><html><body><div id="article"><p>正文' + id + '</p></div></body></html>'
}

function rssSource(categories = [{ key: 'news', name: '新闻' }]) {
  return {
    sourceName: '追更示例',
    sourceUrl: SITE + '#',
    sortUrl: categories.map((category) => `${category.name}::/cat/${category.key}/page/{{page}}.html`).join('\n'),
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    rulePubDate: '.date@text',
    ruleNextPage: 'page',
    ruleContent: '#article',
  }
}

async function fixture({ categories = [{ key: 'news', name: '新闻' }], lists = {}, delay = 0 } = {}) {
  const state = { fail: false, active: 0, maxActive: 0, delay, lists }
  const engine = new SourceEngine({
    maxTocPages: 2,
    fetch: async (url) => {
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      try {
        if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
        if (state.fail) throw new Error('站点 502')
        const path = new URL(url).pathname
        const list = path.match(/^\/cat\/([^/]+)\/page\/(\d+)\.html$/)
        if (list) {
          const items = Number(list[2]) === 1 ? state.lists[list[1]] || [] : []
          return { url, headers: { 'content-type': 'text/html; charset=utf-8' }, text: page(items) }
        }
        const article = path.match(/^\/post\/(\d+)$/)
        if (article) return { url, headers: { 'content-type': 'text/html; charset=utf-8' }, text: detail(article[1]) }
        throw new Error('unexpected URL ' + url)
      } finally {
        state.active -= 1
      }
    },
  })
  const { service, db } = await serviceFixture(engine)
  const imported = await service.importSource({ text: JSON.stringify(rssSource(categories)) })
  const selected = categories.map((category) => imported.categories.find((item) => item.name === category.name).url)
  const added = await service.addSubscriptions({ sourceId: imported.sourceId, categories: selected })
  const books = new Map(added.books.map((book) => [book.name, book]))
  return { service, db, state, sourceId: imported.sourceId, books }
}

function chapterOf(book, id) {
  return {
    id: chapterId(book.id, SITE + '/post/' + id),
    bookId: book.id,
    url: SITE + '/post/' + id,
    title: '标题' + id,
    publishedAt: '2026-11-' + String(1 + (id % 28)).padStart(2, '0'),
    contentType: 'subscription',
  }
}

test('a new entry is prepended while old entries, read marks and progress survive', async () => {
  const { service, db, state, books } = await fixture({ lists: { news: [{ id: 3, publishedAt: '2026-11-13' }, { id: 2, publishedAt: '2026-11-12' }, { id: 1, publishedAt: '2026-11-11' }] } })
  const book = books.get('新闻')
  const toc = await service.toc({ bookId: book.id })
  assert.deepEqual(toc.map((item) => item.title), ['标题3', '标题2', '标题1'])
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/3')

  await service.markChapterRead({ bookId: book.id, chapterId: toc[0].id })
  const readAt = (await service.toc({ bookId: book.id }))[0].readAt
  await service.saveProgress({ bookId: book.id, chapterId: toc[1].id, offset: 7, percent: 12 })

  state.lists.news = [{ id: 4, publishedAt: '2026-11-14' }, { id: 3, publishedAt: '2026-11-13' }, { id: 2, publishedAt: '2026-11-12' }, { id: 1, publishedAt: '2026-11-11' }]
  const result = await service.checkUpdates()
  assert.equal(result.checked, 1)
  assert.equal(result.updated, 1)
  assert.deepEqual(result.errors, [])

  const after = await service.toc({ bookId: book.id })
  assert.deepEqual(after.map((item) => item.title), ['标题4', '标题3', '标题2', '标题1'])
  assert.equal(after.find((item) => item.title === '标题3').readAt, readAt)
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/4')
  assert.equal(db.books.get(book.id).progress.chapterId, toc[1].id)
  assert.equal(db.books.get(book.id).progress.percent, 12)
})

test('an anchor off the first page falls back to published dates, and stops when dates are incomplete', async () => {
  const { service, db, state, books } = await fixture({ lists: { news: [{ id: 5, publishedAt: '2026-11-15' }, { id: 4, publishedAt: '2026-11-14' }] } })
  const book = books.get('新闻')
  await service.toc({ bookId: book.id })
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/5')

  state.lists.news = [{ id: 7, publishedAt: '2026-11-17' }, { id: 6, publishedAt: '2026-11-16' }]
  await service.checkUpdates()
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题7', '标题6', '标题5', '标题4'])
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/7')
  const beforeUncertain = db.books.get(book.id).updatedAt

  state.lists.news = [{ id: 9, publishedAt: '2026-11-19' }, { id: 8 }]
  const uncertain = await service.checkUpdates()
  assert.equal(uncertain.updated, 0)
  assert.equal(uncertain.warnings.length, 1)
  assert.match(uncertain.warnings[0].message, /发布时间/)
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题7', '标题6', '标题5', '标题4'])
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/7')
  assert.equal(db.books.get(book.id).updatedAt, beforeUncertain, 'uncertain rounds must not reorder the shelf')
  assert.match(db.books.get(book.id).subscription.anchorError, /发布时间/)

  state.lists.news = [{ id: 9, publishedAt: '2026-11-19' }, { id: 8, publishedAt: '2026-11-18' }]
  const retried = await service.checkUpdates()
  assert.equal(retried.updated, 1)
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题9', '标题8', '标题7', '标题6', '标题5', '标题4'])
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/9')
  assert.equal(db.books.get(book.id).subscription.anchorError, undefined)
})

test('date fallback accepts duplicates that are clearly newer than the anchor', async () => {
  const { service, db, state, books } = await fixture({ lists: { news: [{ id: 5, publishedAt: '2026-11-15' }] } })
  const book = books.get('新闻')
  await service.toc({ bookId: book.id })
  state.lists.news = [{ id: 9, publishedAt: '2026-11-17' }, { id: 8, publishedAt: '2026-11-17' }]
  const result = await service.checkUpdates()
  assert.equal(result.updated, 1)
  assert.equal(result.warnings.length, 0)
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题9', '标题8', '标题5'])
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/9')
})

test('a failed refresh keeps the old directory, marks the source and reports one readable error', async () => {
  const { service, db, state, sourceId, books } = await fixture({ lists: { news: [{ id: 2, publishedAt: '2026-11-12' }, { id: 1, publishedAt: '2026-11-11' }] } })
  const book = books.get('新闻')
  await service.toc({ bookId: book.id })

  state.fail = true
  const failed = await service.checkUpdates()
  assert.equal(failed.errors.length, 1)
  assert.match(failed.errors[0].message, /502/)
  assert.match(db.sources.get(sourceId).lastError, /502/)
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题2', '标题1'])

  state.fail = false
  state.lists.news = [{ id: 3, publishedAt: '2026-11-13' }, { id: 2, publishedAt: '2026-11-12' }, { id: 1, publishedAt: '2026-11-11' }]
  const retried = await service.checkUpdates()
  assert.equal(retried.updated, 1)
  assert.equal(db.sources.get(sourceId).lastError, undefined)
  assert.deepEqual((await service.toc({ bookId: book.id })).map((item) => item.title), ['标题3', '标题2', '标题1'])
})

test('subscriptions from the same source are checked one after another', async () => {
  const { service, state, books } = await fixture({
    categories: [{ key: 'news', name: '新闻' }, { key: 'other', name: '其它' }],
    lists: { news: [{ id: 2, publishedAt: '2026-11-12' }], other: [{ id: 9, publishedAt: '2026-11-09' }] },
    delay: 10,
  })
  assert.equal(books.size, 2)
  const result = await service.checkUpdates()
  assert.equal(result.checked, 2)
  assert.equal(result.updated, 2)
  assert.equal(state.maxActive, 1)

  state.fail = true
  const failed = await service.checkUpdates()
  assert.equal(failed.errors.length, 1, 'same source and same message should not flood the error list')
})

test('the 500 entry cap removes only old entries that are read, not downloaded and not in progress', async () => {
  const { service, db, books } = await fixture({ lists: { news: [{ id: 0, publishedAt: '2026-11-01' }] } })
  const book = books.get('新闻')
  const seeded = []
  for (let index = 0; index < 505; index += 1) {
    const chapter = { ...chapterOf(book, index), index }
    if (index >= 500) chapter.readAt = '2026-11-02T00:00:00.000Z'
    seeded.push(chapter)
    await db.chapters.put(chapter.id, chapter)
  }
  const latest = { ...book, subscription: { ...book.subscription, anchorUrl: seeded[0].url }, progress: { chapterId: seeded[0].id, offset: 0, percent: 0 } }
  await db.books.put(book.id, latest)

  const toc = await service.toc({ bookId: book.id, refresh: true })
  assert.equal(toc.length, 500)
  const kept = new Set(toc.map((item) => item.title))
  for (const index of [500, 501, 502, 503, 504]) assert.equal(kept.has('标题' + index), false)
  assert.equal(kept.has('标题499'), true)
  assert.equal(db.books.get(book.id).subscription.anchorUrl, seeded[0].url)
})

test('the 500 entry cap never removes unread, offline or in-progress entries', async () => {
  const { service, db, books } = await fixture({ lists: { news: [{ id: 0, publishedAt: '2026-11-01' }] } })
  const book = books.get('新闻')
  const seeded = []
  for (let index = 0; index < 505; index += 1) {
    const chapter = { ...chapterOf(book, index), index }
    if (index >= 500 && index !== 502) chapter.readAt = '2026-11-02T00:00:00.000Z'
    if (index === 500) chapter.offline = { kind: 'comic', images: ['media-1'] }
    if (index === 501) chapter.offline = { kind: 'comic', images: ['media-2'] }
    // 只是打开阅读时缓存过，不等于用户下载了：这条应该被清理。
    if (index === 503) chapter.downloadedAt = '2026-11-02T02:00:00.000Z'
    seeded.push(chapter)
    await db.chapters.put(chapter.id, chapter)
  }
  const latest = { ...book, subscription: { ...book.subscription, anchorUrl: seeded[0].url }, progress: { chapterId: seeded[504].id, offset: 0, percent: 0 } }
  await db.books.put(book.id, latest)

  const toc = await service.toc({ bookId: book.id, refresh: true })
  assert.equal(toc.length, 504)
  for (const index of [500, 501, 502, 504]) assert.equal(toc.some((item) => item.title === '标题' + index), true)
  assert.equal(toc.some((item) => item.title === '标题503'), false)
})

test('reading an entry caches its payload without marking it downloaded', async () => {
  const { service, db, books } = await fixture({ lists: { news: [{ id: 5, publishedAt: '2026-11-15' }] } })
  const book = books.get('新闻')
  const toc = await service.toc({ bookId: book.id })
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.equal(chapter.text, '正文5')
  const stored = db.chapters.get(toc[0].id)
  assert.equal(stored.downloadedAt, undefined)
  assert.equal(stored.payloadVersion, 2)
})

test('the 500 entry cap keeps the follow anchor even when it is old', async () => {
  const { service, db, books } = await fixture({ lists: { news: [{ id: 0, publishedAt: '2026-11-01' }] } })
  const book = books.get('新闻')
  const seeded = []
  for (let index = 0; index < 505; index += 1) {
    const chapter = { ...chapterOf(book, index), index, readAt: '2026-11-02T00:00:00.000Z' }
    if (index === 504) {
      chapter.url = SITE + '/post/anchor'
      chapter.title = '锚点'
      chapter.publishedAt = '2026-12-01'
    }
    seeded.push(chapter)
    await db.chapters.put(chapter.id, chapter)
  }
  const latest = { ...book, subscription: { ...book.subscription, anchorUrl: SITE + '/post/anchor' }, progress: { chapterId: seeded[0].id, offset: 0, percent: 0 } }
  await db.books.put(book.id, latest)

  const toc = await service.toc({ bookId: book.id, refresh: true })
  assert.equal(toc.length, 500)
  assert.equal(toc.some((item) => item.title === '锚点'), true)
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/anchor')
})

test('re-adding a category keeps the follow anchor and read baseline', async () => {
  const { service, db, books, sourceId } = await fixture({ lists: { news: [{ id: 2, publishedAt: '2026-11-12' }] } })
  const book = books.get('新闻')
  await service.toc({ bookId: book.id })
  const before = db.books.get(book.id)
  assert.equal(before.subscription.anchorUrl, SITE + '/post/2')

  const categoryUrl = db.sources.get(sourceId).categories[0].url
  const again = await service.addSubscriptions({ sourceId, categories: [categoryUrl] })
  assert.equal(again.added, 0)
  assert.equal(again.updated, 1)
  assert.equal(db.books.get(book.id).subscription.anchorUrl, SITE + '/post/2')
  assert.equal(db.books.get(book.id).readBaselineAt, before.readBaselineAt)
})

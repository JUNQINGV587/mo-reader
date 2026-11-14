import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'
import { stableId } from '../lib/utils.js'

const FEED_URL = 'https://feed.example/rss.xml'
const ATOM_URL = 'https://feed.example/atom.xml'
const PAGE_URL = 'https://feed.example/page.html'

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function item({ title, link, description, encoded, date, guid, thumb }) {
  return '<item>'
    + '<title>' + xmlEscape(title) + '</title>'
    + (link ? '<link>' + xmlEscape(link) + '</link>' : '')
    + (guid ? '<guid>' + xmlEscape(guid) + '</guid>' : '')
    + (description ? '<description><![CDATA[' + description + ']]></description>' : '')
    + (encoded ? '<content:encoded><![CDATA[' + encoded + ']]></content:encoded>' : '')
    + (date ? '<pubDate>' + xmlEscape(date) + '</pubDate>' : '')
    + (thumb ? '<media:thumbnail url="' + xmlEscape(thumb) + '"/>' : '')
    + '</item>'
}

function feed({ title = '示例 Feed', items = [] } = {}) {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">'
    + '<channel><title>' + xmlEscape(title) + '</title><link>https://feed.example/</link>'
    + '<description>示例订阅</description>'
    + items.join('')
    + '</channel></rss>'
}

const atom = '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 示例</title><entry><title>第一篇</title><link href="https://feed.example/atom/1"/><updated>2025-11-13T09:00:00Z</updated><summary>摘要</summary></entry></feed>'

function response(url, text, contentType = 'application/rss+xml; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

async function fixture(initial, { finalUrl = null } = {}) {
  let body = initial
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    return response(String(url), body)
  }
  const engine = new SourceEngine({ fetch })
  const { service, db } = await serviceFixture(engine, {
    fetchRemote: async (url) => {
      calls.push('import:' + url)
      return response(finalUrl || String(url), body)
    },
  })
  return {
    service,
    db,
    calls,
    setBody: (value) => { body = value },
  }
}

function books(db) {
  return [...db.books.entries()].map(([, value]) => value)
}

function chapters(db) {
  return [...db.chapters.entries()].map(([, value]) => value).sort((a, b) => a.index - b.index)
}

test('a pasted feed URL becomes a subscription book with entries newest first', async () => {
  const body = feed({
    items: [
      item({ title: '旧的一篇', link: 'https://feed.example/posts/old', description: '<p>旧摘要</p>', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
      item({ title: '新的一篇', link: '/posts/new', description: '<p>新摘要</p>', date: 'Thu, 13 Nov 2025 09:00:00 GMT', thumb: '/cover/new.jpg' }),
    ],
  })
  const { service, db } = await fixture(body)

  const imported = await service.importSource({ url: FEED_URL })
  assert.equal(imported.kind, 'rss')
  assert.equal(imported.feed, true)
  assert.equal(imported.name, '示例 Feed')
  assert.equal(imported.categories.length, 1)
  assert.equal(imported.categories[0].url, FEED_URL)
  assert.equal(imported.added, 1)

  const all = books(db)
  assert.equal(all.length, 1)
  const book = all[0]
  assert.equal(book.contentType, 'subscription')
  assert.equal(book.bookUrl, FEED_URL)
  assert.equal(book.name, '示例 Feed')
  assert.equal(book.subscription.sortUrl, FEED_URL)

  const toc = await service.toc({ bookId: book.id })
  assert.deepEqual(toc.map((entry) => entry.title), ['新的一篇', '旧的一篇'])
  assert.equal(toc[0].url, 'https://feed.example/posts/new')
  assert.equal(toc[0].coverUrl, 'https://feed.example/cover/new.jpg')

  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.match(chapter.text, /新摘要/)
})

test('importing the same feed twice keeps one source and one subscription', async () => {
  const body = feed({ items: [item({ title: '唯一一篇', link: '/posts/only', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  const first = await service.importSource({ url: FEED_URL })
  const second = await service.importSource({ url: FEED_URL })
  assert.equal(first.added, 1)
  assert.equal(second.added, 0)
  assert.equal(db.sources.size, 1)
  assert.equal(db.books.size, 1)
})

test('a redirected feed URL becomes the base for relative entries', async () => {
  const finalUrl = 'https://feed.example/final.xml'
  const body = feed({ items: [item({ title: '重定向条目', link: '/posts/redirect', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body, { finalUrl })
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  assert.equal(book.bookUrl, finalUrl)
  const toc = await service.toc({ bookId: book.id })
  assert.equal(toc[0].url, 'https://feed.example/posts/redirect')
})

test('content:encoded is preferred over the plain description', async () => {
  const body = feed({
    items: [
      item({
        title: '全文条目',
        link: '/posts/full',
        description: '<p>摘要不应该出现</p>',
        encoded: '<p>全文第一段</p><p>全文第二段</p>',
        date: 'Thu, 13 Nov 2025 09:00:00 GMT',
      }),
    ],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const toc = await service.toc({ bookId: book.id })
  const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
  assert.match(chapter.text, /全文第一段/)
  assert.match(chapter.text, /全文第二段/)
  assert.doesNotMatch(chapter.text, /摘要不应该出现/)
})

test('Atom feeds are refused with a readable message and leave no source or book', async () => {
  const { service, db } = await fixture(atom)
  await assert.rejects(
    service.importSource({ url: ATOM_URL }),
    (error) => error.code === 'reader/unsupported-source' && /暂不支持 Atom/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('Atom is still recognised when the XML has a stylesheet instruction', async () => {
  const body = '<?xml-stylesheet type="text/xsl" href="/atom.xsl"?>' + atom
  const { service, db } = await fixture(body)
  await assert.rejects(
    service.importSource({ url: ATOM_URL }),
    (error) => error.code === 'reader/unsupported-source' && /暂不支持 Atom/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('pasted Atom XML is refused before asking for a feed URL', async () => {
  const { service, db } = await fixture('')
  await assert.rejects(
    service.importSource({ text: atom }),
    (error) => error.code === 'reader/unsupported-source' && /暂不支持 Atom/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('an empty RSS feed is refused instead of creating an empty subscription', async () => {
  const { service, db } = await fixture(feed({ items: [] }))
  await assert.rejects(
    service.importSource({ url: FEED_URL }),
    (error) => error.code === 'reader/parse-error' && /没有可阅读的条目/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('a link-only entry is not stored as a dead chapter', async () => {
  const body = feed({ items: [item({ title: '只有链接', link: '/posts/link-only', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  await assert.rejects(
    service.importSource({ url: FEED_URL }),
    (error) => error.code === 'reader/parse-error' && /没有可阅读的条目/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('entries without link or guid are skipped instead of using their position', async () => {
  const body = feed({
    items: [
      item({ title: '没有身份', description: '摘要', date: 'Fri, 14 Nov 2025 09:00:00 GMT' }),
      item({ title: '正常条目', link: '/posts/ok', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
    ],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const toc = await service.toc({ bookId: book.id })
  assert.deepEqual(toc.map((entry) => entry.title), ['正常条目'])
})

test('an opaque guid stays the stable identity when a new entry is prepended', async () => {
  const first = feed({
    items: [
      item({ title: '第一篇', link: '/posts/1', description: '摘要一', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
      item({ title: '第二篇', link: '/posts/2', description: '摘要二', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
      item({ title: '第三篇', link: '/posts/3', description: '摘要三', date: 'Tue, 11 Nov 2025 09:00:00 GMT' }),
    ],
  })
  const { service, db, setBody } = await fixture(first)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const initial = await service.toc({ bookId: book.id })
  assert.equal(initial.length, 3)

  setBody(feed({
    items: [
      item({ title: '新条目', guid: 'opaque-guid-new', description: '新摘要', date: 'Fri, 14 Nov 2025 09:00:00 GMT' }),
      item({ title: '第一篇', link: '/posts/1', description: '摘要一', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
      item({ title: '第二篇', link: '/posts/2', description: '摘要二', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
      item({ title: '第三篇', link: '/posts/3', description: '摘要三', date: 'Tue, 11 Nov 2025 09:00:00 GMT' }),
    ],
  }))
  const result = await service.checkUpdates()
  assert.equal(result.updated, 1)
  assert.deepEqual(result.errors, [])
  const toc = await service.toc({ bookId: book.id })
  assert.deepEqual(toc.map((entry) => entry.title), ['新条目', '第一篇', '第二篇', '第三篇'])
  assert.match(toc[0].url, /#guid-/)
  assert.equal(toc.some((entry) => entry.url.includes('#item-')), false)

  const again = await service.checkUpdates()
  assert.equal(again.updated, 0)
  assert.equal((await service.toc({ bookId: book.id })).length, 4)
})

test('feed cover URLs go through the same remote URL policy as other content', async () => {
  const body = feed({
    items: [item({
      title: '私网封面',
      link: '/posts/private-cover',
      description: '摘要',
      date: 'Thu, 13 Nov 2025 09:00:00 GMT',
      thumb: 'http://127.0.0.1:8080/cover.jpg',
    })],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const toc = await service.toc({ bookId: book.id })
  assert.equal(toc[0].coverUrl, undefined)
})

test('prefixed Atom roots are still reported as unsupported Atom', async () => {
  const body = '<?xml version="1.0" encoding="utf-8"?>'
    + '<atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:title>Atom 前缀</atom:title>'
    + '<atom:entry><atom:title>一篇</atom:title><atom:link href="https://feed.example/atom/1"/><atom:summary>摘要</atom:summary></atom:entry>'
    + '</atom:feed>'
  const { service, db } = await fixture(body)
  await assert.rejects(
    service.importSource({ url: ATOM_URL }),
    (error) => error.code === 'reader/unsupported-source' && /暂不支持 Atom/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('DOCTYPE internal subsets do not hide the RSS root', async () => {
  const body = '<!DOCTYPE rss [ <!ENTITY sample ">"> ]>'
    + feed({ items: [item({ title: '带内部子集', link: '/posts/subset', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  const result = await service.importSource({ url: FEED_URL })
  assert.equal(result.feed, true)
  assert.equal(books(db).length, 1)
})

test('backup rejects non-string chapter fields instead of trusting a summary', async () => {
  const body = feed({ items: [item({ title: '备份字段', link: '/posts/types', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT', thumb: '/cover/types.jpg' })] })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  await service.toc({ bookId: book.id })
  const backup = JSON.parse(await service.exportBackup())
  const variants = [
    (chapter) => { chapter.text = 123 },
    (chapter) => { chapter.description = 123 },
    (chapter) => { chapter.coverUrl = 123 },
  ]
  for (const mutate of variants) {
    const copy = JSON.parse(JSON.stringify(backup))
    mutate(copy.chapters[0])
    const fresh = await fixture(body)
    await assert.rejects(
      fresh.service.importBackup({ data: copy }),
      (error) => error.code === 'reader/invalid-backup',
    )
  }
})

test('a DOCTYPE before the RSS root does not hide the feed', async () => {
  const body = '<!DOCTYPE rss>' + feed({ items: [item({ title: '带 DOCTYPE', link: '/posts/doctype', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  const result = await service.importSource({ url: FEED_URL })
  assert.equal(result.feed, true)
  assert.equal(books(db).length, 1)
})

test('a pasted feed over the 2 MiB limit is refused before parsing', async () => {
  const { service, db } = await fixture('')
  const body = '<rss version="2.0">' + ' '.repeat(2 * 1024 * 1024) + '</rss>'
  await assert.rejects(
    service.importSource({ text: body, url: FEED_URL }),
    (error) => error.code === 'reader/too-large',
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('an ordinary HTML page is not mistaken for a feed', async () => {
  const { service, db } = await fixture('<!doctype html><html><body><h1>不是 feed</h1></body></html>')
  await assert.rejects(
    service.importSource({ url: PAGE_URL }),
    (error) => error.code === 'reader/invalid-source' && /不是 RSS\/Atom feed/.test(error.message),
  )
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('checkUpdates appends newly published feed entries without deleting old ones', async () => {
  const first = feed({
    items: [
      item({ title: '第一篇', link: '/posts/1', description: '第一摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
      item({ title: '第二篇', link: '/posts/2', description: '第二摘要', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
    ],
  })
  const { service, db, setBody } = await fixture(first)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  assert.deepEqual((await service.toc({ bookId: book.id })).map((entry) => entry.title), ['第一篇', '第二篇'])

  setBody(feed({
    items: [
      item({ title: '第三篇', link: '/posts/3', description: '第三摘要', date: 'Fri, 14 Nov 2025 09:00:00 GMT' }),
      item({ title: '第一篇', link: '/posts/1', description: '第一摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
      item({ title: '第二篇', link: '/posts/2', description: '第二摘要', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
    ],
  }))
  const result = await service.checkUpdates()
  assert.equal(result.checked, 1)
  assert.equal(result.updated, 1)
  assert.deepEqual(result.errors, [])
  assert.deepEqual((await service.toc({ bookId: book.id })).map((entry) => entry.title), ['第三篇', '第一篇', '第二篇'])
})

test('feed subscriptions reuse the 500 entry cap', async () => {
  const items = Array.from({ length: 505 }, (_, index) => {
    const number = 505 - index
    return item({
      title: '条目' + number,
      link: '/posts/' + number,
      description: '摘要' + number,
      date: new Date(Date.UTC(2025, 10, 13, 9, number)).toUTCString(),
    })
  })
  const { service, db } = await fixture(feed({ items }))
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const initial = await service.toc({ bookId: book.id })
  assert.equal(initial.length, 505)

  for (const entry of initial.slice(-5)) await service.markChapterRead({ bookId: book.id, chapterId: entry.id })
  const result = await service.checkUpdates()
  assert.equal(result.updated, 0)
  assert.deepEqual(result.errors, [])
  const capped = await service.toc({ bookId: book.id })
  assert.equal(capped.length, 500)
  // 被清掉的是最旧、已读的五条；最新一条必须还在顶部。
  const cappedIds = new Set(capped.map((entry) => entry.id))
  for (const entry of initial.slice(-5)) assert.equal(cappedIds.has(entry.id), false)
  assert.equal(capped[0].title, '条目505')
  assert.equal(chapters(db).length, 500)
})

test('backup rejects invalid subscription book metadata', async () => {
  const body = feed({ items: [item({ title: '元数据', link: '/posts/meta', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  await service.toc({ bookId: book.id })
  const backup = JSON.parse(await service.exportBackup())
  const variants = [
    (entry) => { entry.latestChapter = {} },
    (entry) => { entry.latestChapter = 123 },
    (entry) => { entry.readBaselineAt = 1 },
  ]
  for (const mutate of variants) {
    const copy = JSON.parse(JSON.stringify(backup))
    mutate(copy.books[0])
    const fresh = await fixture(body)
    await assert.rejects(
      fresh.service.importBackup({ data: copy }),
      (error) => error.code === 'reader/invalid-backup',
    )
  }
})

test('a restored subscription without latestChapter falls back to its newest entry', async () => {
  const body = feed({
    items: [
      item({ title: '最新条目', link: '/posts/newest', description: '摘要', date: 'Fri, 14 Nov 2025 09:00:00 GMT' }),
      item({ title: '最旧条目', link: '/posts/oldest', description: '摘要', date: 'Wed, 12 Nov 2025 09:00:00 GMT' }),
    ],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  await service.toc({ bookId: book.id })
  const stored = db.books.get(book.id)
  delete stored.latestChapter
  await db.books.put(book.id, stored)
  const state = await service.state()
  const view = state.books.find((entry) => entry.id === book.id)
  assert.equal(view.latestChapter, '最新条目')
})

test('feed cover HTTP policy follows allowHttp', async () => {
  const body = feed({
    items: [item({
      title: '明文封面',
      link: '/posts/http-cover',
      description: '摘要',
      date: 'Thu, 13 Nov 2025 09:00:00 GMT',
      thumb: 'http://feed.example/cover.jpg',
    })],
  })
  const plain = await fixture(body)
  await plain.service.importSource({ url: FEED_URL })
  const plainToc = await plain.service.toc({ bookId: books(plain.db)[0].id })
  assert.equal(plainToc[0].coverUrl, undefined)

  const allowed = await fixture(body)
  await allowed.service.importSource({ url: FEED_URL, allowHttp: true })
  const allowedToc = await allowed.service.toc({ bookId: books(allowed.db)[0].id })
  assert.equal(allowedToc[0].coverUrl, 'http://feed.example/cover.jpg')
})

test('a failed subscription creation rolls back a newly imported feed source', async () => {
  const body = feed({ items: [item({ title: '回滚', link: '/posts/rollback', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  service.addSubscriptions = async () => { throw new Error('boom') }
  await assert.rejects(service.importSource({ url: FEED_URL }), /boom/)
  assert.equal(db.sources.size, 0)
  assert.equal(db.books.size, 0)
})

test('a feed with more than 2000 entries is capped during parsing', async () => {
  const items = Array.from({ length: 2001 }, (_, index) => item({
    title: '条目' + index,
    link: '/posts/' + index,
    description: '摘要' + index,
    date: new Date(Date.UTC(2025, 10, 13, 9, index % 60)).toUTCString(),
  }))
  const { service, db } = await fixture(feed({ items }))
  await service.importSource({ url: FEED_URL })
  const toc = await service.toc({ bookId: books(db)[0].id })
  assert.equal(toc.length, 2000)
})

test('a restored feed with too many categories is rejected', async () => {
  const body = feed({ items: [item({ title: '分类上限', link: '/posts/categories', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })] })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  await service.toc({ bookId: books(db)[0].id })
  const backup = JSON.parse(await service.exportBackup())
  const source = backup.sources.find((entry) => entry.feed === true)
  source.categories = Array.from({ length: 501 }, (_, index) => ({ name: '分类' + index, url: 'https://feed.example/category/' + index }))
  const fresh = await fixture(body)
  await assert.rejects(
    fresh.service.importBackup({ data: backup }),
    (error) => error.code === 'reader/invalid-backup',
  )
})

test('a namespaced RSS root still parses through its local element names', async () => {
  const body = '<rss:rss xmlns:rss="http://purl.org/rss/1.0/" xmlns:content="http://purl.org/rss/1.0/modules/content/" version="2.0">'
    + '<rss:channel><rss:title>前缀源</rss:title>'
    + '<rss:item><rss:title>前缀条目</rss:title><rss:link>https://feed.example/ns/1</rss:link>'
    + '<rss:description><![CDATA[<p>前缀摘要</p>]]></rss:description>'
    + '<rss:pubDate>Thu, 13 Nov 2025 09:00:00 GMT</rss:pubDate></rss:item>'
    + '</rss:channel></rss:rss>'
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const toc = await service.toc({ bookId: books(db)[0].id })
  assert.equal(toc[0].title, '前缀条目')
})

test('a feed backup preserves read state and the follow anchor', async () => {
  const body = feed({
    items: [
      item({ title: '已读条目', link: '/posts/read', description: '摘要', date: 'Fri, 14 Nov 2025 09:00:00 GMT' }),
      item({ title: '未读条目', link: '/posts/unread', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' }),
    ],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  const toc = await service.toc({ bookId: book.id })
  await service.markChapterRead({ bookId: book.id, chapterId: toc[0].id })
  const backup = await service.exportBackup()
  const fresh = await fixture(body)
  const state = await fresh.service.importBackup({ data: backup })
  const restored = state.books.find((entry) => entry.contentType === 'subscription')
  assert.equal(restored.unread, 1)
  assert.equal(restored.subscription.anchorUrl, toc[0].url)
  const restoredToc = await fresh.service.toc({ bookId: restored.id })
  assert.equal(restoredToc[0].url, toc[0].url)
  assert.equal(restoredToc[0].readAt !== undefined, true)
  assert.equal(restoredToc[1].readAt, undefined)
})

test('a version-1 backup without subscription fields imports through the service', async () => {
  const { service } = await fixture('')
  const sourceId = stableId('source', 'https://old.example')
  const state = await service.importBackup({
    data: {
      type: 'modu-reader-backup',
      version: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sources: [{ id: sourceId, name: '旧源', bookSourceUrl: 'https://old.example', rules: {} }],
      books: [{ id: 'b', sourceId, bookUrl: 'https://old.example/book', name: '旧书' }],
      chapters: [{ id: 'c', bookId: 'b', index: 0, title: '第一章', url: 'https://old.example/c', text: '旧正文' }],
      notes: [],
      settings: {},
    },
  })
  assert.equal(state.sources.filter((entry) => entry.name === '旧源').length, 1)
  assert.equal(state.books.length, 1)
  assert.equal(state.books[0].name, '旧书')
  assert.equal(state.books[0].contentType, 'novel')
})

test('a feed backup is restored without Legado rule validation', async () => {
  const body = feed({
    items: [item({ title: '规则无关', link: '/posts/rules', description: '摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })],
  })
  const { service } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const backup = JSON.parse(await service.exportBackup())
  const source = backup.sources.find((entry) => entry.feed === true)
  source.rules = { toc: { chapterList: 123 }, content: '.not-an-object' }
  const fresh = await fixture(body)
  const state = await fresh.service.importBackup({ data: backup })
  const restored = state.sources.find((entry) => entry.feed === true)
  assert.equal(restored.kind, 'rss')
  assert.equal(restored.contentType, 'subscription')
})

test('feed sources and subscription books survive a backup round trip', async () => {
  const body = feed({
    items: [item({ title: '备份条目', link: '/posts/backup', description: '备份摘要', date: 'Thu, 13 Nov 2025 09:00:00 GMT' })],
  })
  const { service, db } = await fixture(body)
  await service.importSource({ url: FEED_URL })
  const book = books(db)[0]
  await service.toc({ bookId: book.id })

  const backup = await service.exportBackup()
  const fresh = await fixture(body)
  const state = await fresh.service.importBackup({ data: backup })
  const source = state.sources.find((entry) => entry.kind === 'rss')
  assert.equal(source.feed, true)
  const restored = state.books.find((entry) => entry.contentType === 'subscription')
  assert.equal(restored.bookUrl, FEED_URL)
  assert.equal(restored.unread, 1)
  assert.equal(restored.latestChapter, '备份条目')
  const toc = await fresh.service.toc({ bookId: restored.id })
  assert.deepEqual(toc.map((entry) => entry.title), ['备份条目'])
  const chapter = await fresh.service.chapter({ bookId: restored.id, chapterId: toc[0].id })
  assert.match(chapter.text, /备份摘要/)
})

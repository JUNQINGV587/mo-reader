import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://samples.example'

function response(text, contentType = 'text/html; charset=utf-8') {
  return { url: '', headers: { 'content-type': contentType }, text }
}

function bookPage(name, chapter, id) {
  return `<h1>${name}</h1><ul><li class="chapter"><a href="/chapter/${id}/1">${chapter}</a></li></ul>`
}

function chapterPage(text) {
  return `<div id="content"><p>${text}</p></div>`
}

const samples = [
  {
    id: 'css', name: 'CSS 书', chapter: 'CSS 章', text: 'CSS 正文',
    search: '<div class="book"><span class="name">CSS 书</span><a href="/book/css">详情</a></div>',
    searchType: 'text/html; charset=utf-8',
    rules: {
      search: { url: '/search/css', bookList: '.book', name: '.name', bookUrl: 'a@href' },
      bookInfo: { name: 'h1' },
      toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
      content: { content: '#content' },
    },
  },
  {
    id: 'json', name: 'JSONPath 书', chapter: 'JSONPath 章', text: 'JSONPath 正文',
    search: JSON.stringify({ data: [{ name: 'JSONPath 书', url: '/book/json' }] }),
    searchType: 'application/json',
    rules: {
      search: { url: '/search/json', bookList: '$.data[*]', name: '$.name', bookUrl: '$.url' },
      bookInfo: { name: 'h1' },
      toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
      content: { content: '#content' },
    },
  },
  {
    id: 'xpath', name: 'XPath 书', chapter: 'XPath 章', text: 'XPath 正文',
    search: '<div class="book"><span class="name">XPath 书</span><a href="/book/xpath">详情</a></div>',
    searchType: 'text/html; charset=utf-8',
    rules: {
      search: { url: '/search/xpath', bookList: '//div[@class="book"]', name: '//span[@class="name"]/text()', bookUrl: '//a/@href' },
      bookInfo: { name: '//h1/text()' },
      toc: { chapterList: '//li[@class="chapter"]', chapterName: '//a/text()', chapterUrl: '//a/@href' },
      content: { content: '@xpath://div[@id="content"]/p/text()' },
    },
  },
  {
    id: 'post', name: 'JSON POST 书', chapter: 'JSON POST 章', text: 'JSON POST 正文',
    search: JSON.stringify({ data: [{ name: 'JSON POST 书', url: '/book/post' }] }),
    searchType: 'application/json',
    rules: {
      search: {
        url: '/search/post', method: 'POST', body: '{"q":"{{key}}"}',
        headers: { 'Content-Type': 'application/json' }, bookList: 'data[*]', name: 'name', bookUrl: 'url',
      },
      bookInfo: { name: 'h1' },
      toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
      content: { content: '#content' },
    },
  },
  {
    id: 'js', name: 'JS 书', chapter: 'JS 章', text: 'JS 正文',
    search: JSON.stringify({ items: [{ title: 'JS 书', id: 'js' }] }),
    searchType: 'application/json',
    rules: {
      search: { url: '/search/js', bookList: '$.items[*]', name: '@js:document.title', bookUrl: '@js:"/book/" + document.id' },
      bookInfo: { name: 'h1' },
      toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
      content: { content: '@js:html.match(/<div id="content">([\\s\\S]*?)<\\/div>/)[1]' },
    },
  },
]

const engine = new SourceEngine({
  fetch: async (url, config = {}) => {
    const path = new URL(url).pathname
    const sample = samples.find(item => path.includes(`/${item.id}`) || path.endsWith(`/${item.id}`))
    if (path.startsWith('/search/')) {
      const found = samples.find(item => path === `/search/${item.id}`)
      assert.ok(found, `unexpected search URL ${url}`)
      if (found.id === 'post') {
        assert.equal(config.method, 'POST')
        assert.deepEqual(JSON.parse(config.body), { q: '样本' })
      }
      const result = response(found.search, found.searchType)
      result.url = url
      return result
    }
    assert.ok(sample, `unexpected URL ${url}`)
    if (path.startsWith('/book/')) {
      const result = response(bookPage(sample.name, sample.chapter, sample.id))
      result.url = url
      return result
    }
    if (path.startsWith('/chapter/')) {
      const result = response(chapterPage(sample.text))
      result.url = url
      return result
    }
    throw new Error(`unexpected URL ${url}`)
  },
})

for (const sample of samples) {
  test(`public service runs the ${sample.id} source sample through search, toc, content and download`, async () => {
    const { service, db } = await serviceFixture(engine)
    const imported = await service.importSource({
      text: JSON.stringify({ bookSourceName: `${sample.id} 样本`, bookSourceUrl: SITE, rules: sample.rules }),
    })
    const sourceId = imported.id
    const found = await service.search({ sourceId, query: '样本' })
    assert.equal(found.items[0].name, sample.name)
    const book = await service.addBook({ sourceId, bookUrl: found.items[0].bookUrl })
    assert.equal(book.name, sample.name)
    const toc = await service.toc({ bookId: book.id })
    assert.equal(toc[0].title, sample.chapter)
    const chapter = await service.chapter({ bookId: book.id, chapterId: toc[0].id })
    assert.equal(chapter.text, sample.text)
    const job = await service.download({ bookId: book.id })
    await service.runningJobs.get(job.id)
    assert.equal(db.chapters.get(toc[0].id).text, sample.text)
    assert.equal((await service.state()).books[0].download.status, 'completed')
  })
}

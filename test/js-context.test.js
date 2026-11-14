import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://ctx.example'

function response(url, text, contentType = 'text/html; charset=utf-8') {
  return { url, headers: { 'content-type': contentType }, text }
}

function siteFetch(requests = []) {
  return async (url) => {
    requests.push(url)
    const target = new URL(url)
    if (target.pathname === '/search') {
      return response(url, '<div class="book"><span class="name">书</span><a href="/book/1">详情</a></div>')
    }
    if (target.pathname === '/book/1') {
      return response(url, '<h1>书</h1><img class="cover" src="/cover-1.jpg"><img class="cover" src="/cover-2.jpg"><ul><li class="chapter"><a href="/chapter/1">第一章</a></li></ul>')
    }
    if (target.pathname === '/chapter/1') {
      return response(url, '<div id="content"><p>第一段</p><p>第二段</p></div>')
    }
    if (target.pathname === '/meta') {
      return response(url, '42')
    }
    throw new Error(`unexpected URL ${url}`)
  }
}

function multiPartChapterFetch() {
  const html = siteFetch()
  return async (url) => {
    if (new URL(url).pathname === '/chapter/1') {
      return response(url, '<div class="part"><p>甲段</p></div><div class="part"><p>乙段</p></div>')
    }
    return html(url)
  }
}

function jsonChapterFetch() {
  const html = siteFetch()
  return async (url) => {
    if (new URL(url).pathname === '/chapter/1') {
      return response(url, JSON.stringify({ sections: [{ text: '甲段' }, { text: '乙段' }] }), 'application/json')
    }
    return html(url)
  }
}

function xpathChapterFetch() {
  const html = siteFetch()
  return async (url) => {
    if (new URL(url).pathname === '/chapter/1') {
      return response(url, '<p>甲段</p><p>乙段</p>')
    }
    return html(url)
  }
}

async function importSource(service, rules) {
  const imported = await service.importSource({ text: JSON.stringify({ bookSourceName: '上下文样本', bookSourceUrl: SITE, rules }) })
  return imported.id
}

async function readChapter(service, sourceId) {
  const found = await service.search({ sourceId, query: '样本' })
  const book = await service.addBook({ sourceId, bookUrl: found.items[0].bookUrl })
  const toc = await service.toc({ bookId: book.id })
  return service.chapter({ bookId: book.id, chapterId: toc[0].id })
}

test('URL templates resolve JS expressions with the current page and keyword', async () => {
  const requests = []
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch(requests) }))
  const sourceId = await importSource(service, {
    search: { url: '/search?q={{key}}&p={{page*2}}', bookList: '.book', name: '.name', bookUrl: 'a@href' },
  })
  const found = await service.search({ sourceId, query: '三 体', page: 2 })
  assert.equal(found.items[0].name, '书')
  assert.deepEqual(requests, [`${SITE}/search?q=%E4%B8%89%20%E4%BD%93&p=4`])
})

test('a JS rule can transform the result of the selector that precedes it', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '#content@html@js:result.replace(/<[^>]+>/g, "|")' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '|第一段||第二段|')
})

test('a selector prefix hands every match to the JS rule, not just the first', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: multiPartChapterFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '.part@html@js:result.replace(/<[^>]+>/g, "|")' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '|甲段|\n|乙段|')
})

test('a text selector prefix joins matches before the JS runs', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: multiPartChapterFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '.part@js:result.replace(/\\n/g, "|")' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '甲段|乙段')
})

test('URL fields keep only the first selector match for JS rules', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1', coverUrl: '.cover@src@js:result + "?x"' },
  })
  const found = await service.search({ sourceId, query: '样本' })
  const book = await service.addBook({ sourceId, bookUrl: found.items[0].bookUrl })
  assert.equal(book.coverUrl, `${SITE}/cover-1.jpg?x`)
})

test('a selector prefix joins JSONPath matches before the JS runs', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: jsonChapterFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '@Json:$.sections[*].text@js:result.replace(/\\n/g, "|")' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '甲段|乙段')
})

test('a selector prefix joins XPath matches before the JS runs', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: xpathChapterFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '//p@js:result.replace(/\\n/g, "|")' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '甲段|乙段')
})

test('a selector prefix with no match runs the JS with an empty result', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '.missing@js:result === "" ? "空结果" : "非空"' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '空结果')
})

test('a bare JS rule receives the whole page as its result', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '@js:result.match(/<p>([\\s\\S]*?)<\\/p>/)[1]' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '第一段')
})

test('JS rules read src, baseUrl, page and source from the rule context', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: '<js>[src === html, baseUrl, page, source.bookSourceUrl].join("|")</js>' },
  })
  const found = await service.search({ sourceId, query: '样本' })
  const book = await service.addBook({ sourceId, bookUrl: found.items[0].bookUrl })
  assert.equal(book.name, `true|${SITE}/book/1|1|${SITE}`)
})

test('a JS rule can run multiple statements and return the last expression', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '@js:const text = result.match(/<p>([\\s\\S]*?)<\\/p>/)[1]; text + "!"' },
  })
  const chapter = await readChapter(service, sourceId)
  assert.equal(chapter.text, '第一段!')
})

test('URL template expressions can await the sandbox fetch', async () => {
  const requests = []
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch(requests) }))
  const sourceId = await importSource(service, {
    search: { url: '/search?p={{fetch("/meta").then(r => r.text).then(t => t.trim())}}', bookList: '.book', name: '.name', bookUrl: 'a@href' },
  })
  const found = await service.search({ sourceId, query: '样本' })
  assert.equal(found.items[0].name, '书')
  assert.deepEqual(requests, [`${SITE}/meta`, `${SITE}/search?p=42`])
})

test('a JS rule that needs an unavailable Legado variable names the variable', async () => {
  const { service } = await serviceFixture(new SourceEngine({ fetch: siteFetch() }))
  const sourceId = await importSource(service, {
    search: { url: '/search', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    bookInfo: { name: '@js:java.ajax("x")' },
  })
  const found = await service.search({ sourceId, query: '样本' })
  await assert.rejects(
    service.addBook({ sourceId, bookUrl: found.items[0].bookUrl }),
    /书源 JS 执行失败：java 未定义/,
  )
})

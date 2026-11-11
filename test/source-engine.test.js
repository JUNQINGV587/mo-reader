import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { extractOne, normalizeSource, responseDocument } from '../lib/rules.js'

const source = {
  id: 'https://example.com', name: 'Example', bookSourceUrl: 'https://example.com', allowHttp: false,
  rules: {
    search: {
      url: 'https://example.com/search', method: 'POST', body: 'q={{key}}&p={{page}}', charset: 'utf-8',
      headers: { Accept: 'text/html' }, bookList: '.result', name: '.title', author: '.author', bookUrl: 'a@href', coverUrl: 'img@src',
    },
    bookInfo: { name: 'h1' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '@css:#content' },
  },
}

test('source engine executes GET/POST form configuration and CSS rules without real network', async () => {
  const calls = []
  const engine = new SourceEngine({
    fetch: async (url, config) => {
      calls.push({ url, config })
      if (url.includes('/search')) return { url, headers: { 'content-type': 'text/html' }, text: '<div class="result"><span class="title">书 A</span><span class="author">作者</span><a href="/book/a">详情</a><img src="/a.jpg"></div>' }
      if (url.includes('/chapter/')) return { url, headers: {}, text: '<main id="content"><p>第一段<br>第二行</p><script>bad()</script></main>' }
      return { url, headers: {}, text: '<div class="chapter"><a href="/chapter/1">第一章</a></div>' }
    },
  })
  const result = await engine.search(source, { query: '三 体', page: 2 })
  assert.equal(calls[0].config.method, 'POST')
  assert.equal(calls[0].config.form, 'q=%E4%B8%89%20%E4%BD%93&p=2')
  assert.equal(calls[0].config.charset, 'utf-8')
  assert.deepEqual(result.items[0], {
    name: '书 A', author: '作者', bookUrl: 'https://example.com/book/a', coverUrl: 'https://example.com/a.jpg', intro: '',
  })
  const book = { id: 'b', bookUrl: 'https://example.com/book/a' }
  const chapters = await engine.toc(source, book)
  assert.equal(chapters[0].title, '第一章')
  const content = await engine.content(source, book, chapters[0])
  assert.equal(content.text, '第一段\n第二行')
  assert.equal(content.text.includes('bad()'), false)
})

test('source engine blocks host escape from JS rules', async () => {
  const engine = new SourceEngine({
    fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<h1>safe</h1>' }),
  })
  const hostile = {
    ...source,
    rules: { ...source.rules, bookInfo: { name: '<js>this.constructor.constructor("return process.env")()</js>' } },
  }
  await assert.rejects(engine.bookInfo(hostile, 'https://example.com/book/a'), /JS|script|generation|沙箱/i)
  const throughFetch = { ...source, rules: { ...source.rules, bookInfo: { name: '<js>fetch.constructor("return process.env")()</js>' } } }
  await assert.rejects(engine.bookInfo(throughFetch, 'https://example.com/book/a'), /JS|script|generation|沙箱/i)
})

test('source engine does not expose the host fetch function through sandbox globals', async () => {
  const engine = new SourceEngine({
    fetch: async url => ({ url, headers: { 'content-type': 'text/html' }, text: '<h1>safe</h1>' }),
  })
  const hostile = { ...source, rules: { ...source.rules, bookInfo: { name: '<js>__request.constructor("return process.env")()</js>' } } }
  await assert.rejects(engine.bookInfo(hostile, 'https://example.com/book/a'), /JS|script|generation|沙箱|not defined/i)
})

test('source engine allows JS field rules to fetch only through the source adapter', async () => {
  const calls = []
  const engine = new SourceEngine({
    fetch: async url => {
      calls.push(url)
      if (url.endsWith('/title.json')) return { url, headers: { 'content-type': 'application/json' }, text: '{"name":"远程书名"}' }
      return { url, headers: { 'content-type': 'text/html' }, text: '<h1>detail</h1>' }
    },
  })
  const remote = {
    ...source,
    rules: { ...source.rules, bookInfo: { name: '<js>fetch("/title.json").then(r => r.json()).then(d => d.name)</js>' } },
  }
  const result = await engine.bookInfo(remote, 'https://example.com/book/a')
  assert.equal(result.name, '远程书名')
  assert.deepEqual(calls, ['https://example.com/book/a', 'https://example.com/title.json'])
})

test('source engine rejects off-origin JS requests and runaway scripts', async () => {
  const calls = []
  const engine = new SourceEngine({
    fetch: async url => {
      calls.push(url)
      return { url, headers: { 'content-type': 'text/html' }, text: '<h1>detail</h1>' }
    },
  })
  const offOrigin = { ...source, rules: { ...source.rules, bookInfo: { name: '<js>fetch("https://evil.example/secret")</js>' } } }
  await assert.rejects(engine.bookInfo(offOrigin, 'https://example.com/book/a'), /origin/)
  assert.deepEqual(calls, ['https://example.com/book/a'])
  const runaway = { ...source, rules: { ...source.rules, bookInfo: { name: '<js>(() => { while (true) {} })()</js>' } } }
  await assert.rejects(engine.bookInfo(runaway, 'https://example.com/book/a'), /超时|timed out/i)
  const asyncRunaway = { ...source, rules: { ...source.rules, bookInfo: { name: '<js>fetch("/data").then(() => { while (true) {} })</js>' } } }
  await assert.rejects(engine.bookInfo(asyncRunaway, 'https://example.com/book/a'), /超时|timed out/i)
})

test('source engine runs safe JS fields in search and content', async () => {
  const engine = new SourceEngine({
    fetch: async url => {
      if (url.includes('/api')) return { url, headers: { 'content-type': 'application/json' }, text: '{"items":[{"title":"JS 书","id":"a"}]}' }
      if (url.includes('/toc')) return { url, headers: { 'content-type': 'application/json' }, text: '{"items":[{"name":"第1章","url":"/chapter/1"}]}' }
      return { url, headers: { 'content-type': 'text/html' }, text: '<article><p>JS 正文</p><script>bad()</script></article>' }
    },
  })
  const jsSource = {
    ...source,
    rules: {
      ...source.rules,
      search: { url: '/api', bookList: '$.items[*]', name: '@js:document.title', bookUrl: ['@js:"/book/" + document.id'] },
      content: { content: '<js>html.match(/<article>[\\s\\S]*<\\/article>/)[0]</js>' },
    },
  }
  const found = await engine.search(jsSource, { query: 'x' })
  assert.equal(found.items[0].name, 'JS 书')
  assert.equal(found.items[0].bookUrl, 'https://example.com/book/a')
  const content = await engine.content(jsSource, { id: 'a', name: 'JS 书', bookUrl: found.items[0].bookUrl }, { id: 'c', title: '第一章', url: 'https://example.com/chapter/1' })
  assert.equal(content.text, 'JS 正文')
  assert.equal(content.text.includes('bad()'), false)
  const scriptedToc = { ...jsSource, rules: { ...jsSource.rules, toc: { url: '/toc', list: '$.items[*]', chapterName: '@js:document.name', chapterUrl: '@js:document.url' } } }
  assert.equal((await engine.toc(scriptedToc, { id: 'a', name: 'JS 书', bookUrl: found.items[0].bookUrl })).length, 1)
})

test('source engine runs a representative XPath source through search, toc and content', async () => {
  const engine = new SourceEngine({
    fetch: async (url) => {
      if (url.includes('/search')) return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<div class="book"><span class="name">XPath 书</span><span class="author">作者</span><a href="/book/x">详情</a></div>',
      }
      if (url.includes('/toc') || url.includes('/book/x')) return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<ul><li class="chapter"><a href="/chapter/x1">第一章</a></li></ul>',
      }
      return {
        url,
        headers: { 'content-type': 'text/html' },
        text: '<div id="content"><p>第一段</p><p>第二段</p><script>bad()</script></div>',
      }
    },
  })
  const xpathSource = {
    ...source,
    rules: {
      search: {
        url: '/search', bookList: '//div[@class="book"]', name: '//span[@class="name"]/text()',
        author: '//span[@class="author"]/text()', bookUrl: '//a/@href',
      },
      bookInfo: {},
      toc: { chapterList: '//li[@class="chapter"]', chapterName: '//a/text()', chapterUrl: '//a/@href' },
      content: { content: '@xpath://div[@id="content"]/p/text()' },
    },
  }
  const found = await engine.search(xpathSource, { query: 'x' })
  assert.equal(found.items[0].name, 'XPath 书')
  assert.equal(found.items[0].bookUrl, 'https://example.com/book/x')
  const book = { id: 'xpath-book', name: 'XPath 书', bookUrl: found.items[0].bookUrl }
  const chapters = await engine.toc(xpathSource, book)
  assert.equal(chapters[0].title, '第一章')
  const content = await engine.content(xpathSource, book, chapters[0])
  assert.equal(content.text, '第一段\n第二段')
  assert.equal(content.text.includes('bad()'), false)

  assert.equal(extractOne(responseDocument('<a id="anchor">x</a>'), '//a/@id'), 'anchor')
  const unsupported = { ...xpathSource, rules: { ...xpathSource.rules, search: { ...xpathSource.rules.search, bookList: '//div/following-sibling::div' } } }
  await assert.rejects(engine.search(unsupported, { query: 'x' }), /XPath|unsupported/)
})

test('source engine sends JSON POST bodies and accepts Legado JSONPath without a leading dollar', async () => {
  const calls = []
  const engine = new SourceEngine({
    fetch: async (url, config) => {
      calls.push({ url, config })
      return { url, headers: { 'content-type': 'application/json' }, text: '{"data":[{"name":"JSON 书","url":"/book/json"}]}' }
    },
  })
  const jsonSource = {
    ...source,
    rules: {
      search: {
        url: '/api/search', method: 'POST', body: '{"q":"{{key}}","page":{{page}}}',
        headers: { 'Content-Type': 'application/json' }, bookList: 'data[*]', name: 'name', bookUrl: 'url',
      },
      bookInfo: {}, toc: {}, content: {},
    },
  }
  const result = await engine.search(jsonSource, { query: 'a"b\\c', page: 2 })
  assert.equal(calls[0].config.method, 'POST')
  assert.equal(calls[0].config.jsonBody, true)
  assert.equal(calls[0].config.headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].config.body), { q: 'a"b\\c', page: 2 })
  assert.equal(result.items[0].bookUrl, 'https://example.com/book/json')
})

test('source engine detects repeated toc and content pagination instead of fetching forever', async () => {
  const engine = new SourceEngine({
    maxTocPages: 3,
    maxContentPages: 3,
    fetch: async (url) => ({
      url,
      headers: { 'content-type': 'text/html' },
      text: url.includes('/chapter')
        ? '<div id="content">同一段正文</div>'
        : '<div class="chapter"><a href="/chapter/1">第一章</a></div>',
    }),
  })
  const loopingToc = {
    ...source,
    rules: {
      ...source.rules,
      toc: { url: '/toc', chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href', nextPage: 'https://example.com/toc' },
    },
  }
  await assert.rejects(engine.toc(loopingToc, { id: 'loop', name: '循环', bookUrl: 'https://example.com/book/loop' }), (error) => error.code === 'reader/pagination-loop')

  const loopingContent = {
    ...source,
    rules: {
      ...source.rules,
      content: { url: '/chapter', content: '#content', nextPage: 'https://example.com/chapter' },
    },
  }
  await assert.rejects(
    engine.content(loopingContent, { id: 'loop', name: '循环', bookUrl: 'https://example.com/book/loop' }, { id: 'c', title: '第一章', url: 'https://example.com/chapter/1' }),
    (error) => error.code === 'reader/pagination-loop',
  )
})

test('normalization marks unsupported login, captcha, payment and WebView capabilities', async () => {
  const normalized = normalizeSource({
    bookSourceName: '需要登录的源', bookSourceUrl: 'https://example.com',
    loginUrl: '<js>login()</js>', captcha: true, payUrl: 'https://example.com/pay',
    rules: { search: { url: '/search', bookList: '.book' } },
  })
  assert.deepEqual(normalized.unsupported, ['captcha', 'login', 'payment'])
  assert.throws(() => normalizeSource({
    bookSourceName: '网页源', bookSourceUrl: 'https://example.com',
    rules: { content: { content: 'webView://chapter' } },
  }), /WebView|webview/)
  const blocked = normalizeSource({
    bookSourceName: '需要登录的源', bookSourceUrl: 'https://example.com', loginUrl: '<js>login()</js>',
    rules: { search: { url: '/search', bookList: '.book' } },
  })
  let calls = 0
  const engine = new SourceEngine({ fetch: async () => { calls += 1; throw new Error('must not fetch') } })
  await assert.rejects(engine.search(blocked, { query: 'x' }), /登录|unsupported/)
  assert.equal(calls, 0)
})

test('source engine supports JSONPath search and empty discovery', async () => {
  const engine = new SourceEngine({
    fetch: async url => ({
      url,
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify({ data: [{ name: 'JSON 书', url: '/json-book' }] }),
    }),
  })
  const jsonSource = {
    ...source,
    rules: {
      search: { url: '/api?q={{key}}', bookList: '@Json:$.data[*]', name: '@Json:$.name', bookUrl: '@Json:$.url' },
      explore: {}, bookInfo: {}, toc: {}, content: {},
    },
  }
  const result = await engine.search(jsonSource, { query: 'x' })
  assert.equal(result.items[0].bookUrl, 'https://example.com/json-book')
  assert.deepEqual(await engine.discover(jsonSource, {}), { items: [], page: 1, exploreIndex: 0, hasMore: false })
})

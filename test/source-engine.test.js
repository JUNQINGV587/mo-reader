import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'

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

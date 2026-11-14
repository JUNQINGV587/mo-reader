import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, parseRemoteUrl } from '../lib/http.js'
import { applyReplacements, applyReplacementsToBlocks, normalizeReplacements } from '../lib/replacements.js'
import { extractOne, mapList, normalizeSource, renderTemplate, responseDocument, selectAll } from '../lib/rules.js'

test('URL templates encode key, page and book values', () => {
  assert.equal(
    renderTemplate('https://example.com/search?q={{key}}&page={{page}}&from={{source}}', { key: '三 体/刘', page: 2, source: 'a&b' }),
    'https://example.com/search?q=%E4%B8%89%20%E4%BD%93%2F%E5%88%98&page=2&from=a%26b',
  )
  assert.throws(() => renderTemplate('https://example.com/{{missing}}', {}), /Missing URL template variable/)
})

test('CSS and @css rules extract book lists and attributes', () => {
  const document = responseDocument(`<ul><li class="book"><a href="/b/1"> 三体 </a><span class="author">刘慈欣</span><img src="cover.jpg"></li><li class="book"><a href="/b/2">球状闪电</a></li></ul>`)
  const books = mapList(document, '@css:li.book', { name: 'a@text', bookUrl: 'a@href', author: '.author', coverUrl: 'img@src' })
  assert.deepEqual(books, [
    { name: '三体', bookUrl: '/b/1', author: '刘慈欣', coverUrl: 'cover.jpg' },
    { name: '球状闪电', bookUrl: '/b/2' },
  ])
})

test('@Json and JSONPath rules extract nested search results', () => {
  const document = responseDocument(JSON.stringify({ data: { rows: [{ title: 'Book A', link: '/a' }, { title: 'Book B', link: '/b' }] } }), 'application/json')
  const books = mapList(document, '@Json:$.data.rows[*]', { name: '@Json:$.title', bookUrl: '@Json:$.link' })
  assert.deepEqual(books, [{ name: 'Book A', bookUrl: '/a' }, { name: 'Book B', bookUrl: '/b' }])
})

test('basic source normalization accepts XPath and rejects unsupported syntax and secrets clearly', () => {
  const base = { bookSourceName: 'test', bookSourceUrl: 'https://example.com', ruleSearch: { url: '/search', bookList: '.book' } }
  const normalized = normalizeSource(base)
  assert.match(normalized.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(normalizeSource(base).id, normalized.id)
  assert.equal(normalized.bookSourceUrl, 'https://example.com')
  assert.doesNotThrow(() => normalizeSource({ ...base, ruleContent: { content: '<js>document.body</js>' } }))
  assert.doesNotThrow(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, bookList: '@xpath://div' } }))
  assert.throws(() => selectAll(responseDocument('<div/>'), '@xpath://div/following-sibling::div'), /XPath|unsupported/)
  assert.throws(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, headers: { Cookie: 'secret' } } }), /not allowed|must not contain secrets/)
  assert.throws(() => normalizeSource({ ...base, token: 'secret' }), /must not contain secrets/)
  assert.equal(normalizeSource({ ...base, bookSourceType: 4 }).contentType, 'video')
  assert.deepEqual(normalizeSource({ ...base, headers: { 'User-Agent': 'ModuReader/1.0', 'Accept-Language': 'zh-CN' } }).headers, { 'user-agent': 'ModuReader/1.0', 'accept-language': 'zh-CN' })
  assert.equal(normalizeSource({ ...base, headers: '{"User-Agent":"ModuReader/1.0"}' }).headers['user-agent'], 'ModuReader/1.0')
  assert.throws(() => normalizeSource({ ...base, headers: { Cookie: 'secret' } }), /not allowed|must not contain secrets/)
  assert.throws(() => normalizeSource({ ...base, bookSourceType: 3 }), /类型 3|网络文件/)
  assert.throws(() => normalizeSource({ sourceName: '采集源', sourceUrl: 'https://example.com' }), /采集源|bookSourceUrl/)
  assert.throws(
    () => normalizeSource({ sourceName: '69仓库', sourceUrl: 'https://example.com#', type: 0, ruleArticles: '.item', ruleContent: '<js>result</js>' }),
    error => error.code === 'reader/unsupported-source' && /Legado 订阅源（RSS）/.test(error.message),
  )
  assert.throws(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, headers: { 'X-Api-Key': 'secret' } } }), /not allowed|must not contain secrets/)
  assert.throws(
    () => normalizeSource({ ...base, ruleToc: { chapterList: 0 } }),
    error => error.code === 'reader/unsupported-rule' && /chapterList/.test(error.message),
  )
})

test('HTTP and local/private SSRF targets are refused without network access', () => {
  assert.equal(parseRemoteUrl('https://example.com/path').hostname, 'example.com')
  assert.equal(parseRemoteUrl('http://example.com', { allowHttp: true }).protocol, 'http:')
  for (const url of ['http://example.com', 'http://127.0.0.1', 'https://localhost', 'https://10.0.0.1', 'https://[::1]', 'https://[::ffff:7f00:1]', 'https://user:pass@example.com', 'https://example.com/?token=x']) {
    assert.throws(() => parseRemoteUrl(url), /HTTPS|blocked|credentials|credential/)
  }
  assert.equal(isPrivateAddress('172.16.1.2'), true)
  assert.equal(isPrivateAddress('8.8.8.8'), false)
})

test('global text and regex replacements apply only to returned content', () => {
  const rules = normalizeReplacements([
    { type: 'text', pattern: '垃圾', replacement: '' },
    { type: 'regex', pattern: '广告\\s*\\d+', replacement: '[removed]', flags: 'gi' },
    { type: 'text', pattern: 'disabled', replacement: 'no', enabled: false },
  ])
  assert.equal(applyReplacements('垃圾正文 广告 12 disabled', rules), '正文 [removed] disabled')
  assert.throws(() => normalizeReplacements([{ type: 'regex', pattern: '[' }]), /合法正则/)
})

test('block replacements touch text and list items but keep code indentation', () => {
  const rules = [{ type: 'text', pattern: '垃圾', replacement: '' }]
  const blocks = [
    { type: 'paragraph', text: ' 垃圾正文 ' },
    { type: 'list', ordered: true, items: ['垃圾一', '二'] },
    { type: 'code', text: '  const value = 1\n' },
    { type: 'image', url: 'https://example.com/a.png' },
  ]
  assert.deepEqual(applyReplacementsToBlocks(blocks, rules), [
    { type: 'paragraph', text: '正文' },
    { type: 'list', ordered: true, items: ['一', '二'] },
    { type: 'code', text: '  const value = 1\n' },
    { type: 'image', url: 'https://example.com/a.png' },
  ])
})

test('URL templates keep `{{!name}}` verbatim for whole-URL variables', () => {
  assert.equal(
    renderTemplate('{{!bookUrl}}', { bookUrl: 'https://example.com/book/1.html' }),
    'https://example.com/book/1.html',
  )
  assert.equal(
    renderTemplate('https://example.com/a?u={{bookUrl}}', { bookUrl: 'https://b/1' }),
    'https://example.com/a?u=https%3A%2F%2Fb%2F1',
  )
})

test('field rules reshape text with ##pattern and ###replacement', () => {
  const document = responseDocument('<ul><li><a href="//www.example.com/book/123.html">示例</a></li></ul>')
  const listRule = '@css:li'
  assert.deepEqual(
    mapList(document, listRule, { bookUrl: 'a@href##/book/(\\d+)\\.html###/list/$1.html' }),
    [{ bookUrl: '//www.example.com/list/123.html' }],
  )
  assert.deepEqual(
    mapList(document, listRule, { id: 'a@href##(\\d+)' }),
    [{ id: '123' }],
  )
})

test('chapter list items can read their own attributes with @text/@href', () => {
  const document = responseDocument('<dl class="Volume"><dd><a href="/c/1">第一章</a></dd><dd><a href="/c/2">第二章</a></dd></dl>')
  assert.deepEqual(
    mapList(document, 'dl.Volume dd a', { title: '@text', url: '@href' }),
    [{ title: '第一章', url: '/c/1' }, { title: '第二章', url: '/c/2' }],
  )
})

test('field templates render from extracted fields without URL encoding', () => {
  const document = responseDocument('<ul><li><a title="三國演義" href="/wiki/三國演義">三國演義</a></li></ul>')
  assert.deepEqual(
    mapList(document, 'li', { name: 'a@title', bookUrl: 'https://zh.wikisource.org/wiki/{{name}}' }),
    [{ name: '三國演義', bookUrl: 'https://zh.wikisource.org/wiki/三國演義' }],
  )
})

test('Legado index and html actions pick the right node', () => {
  const document = responseDocument(
    '<div id="article"><p>第一段</p><p>第二段</p><p>第三段</p></div>',
    'text/html',
  )
  assert.equal(extractOne(document, '#article p!0@text'), '第一段')
  assert.equal(extractOne(document, '#article p!-1@text'), '第三段')
  assert.equal(extractOne(document, '#article p!-1@html'), '<p>第三段</p>'.replace(/^<p>|<\/p>$/g, '') || '第三段')
})

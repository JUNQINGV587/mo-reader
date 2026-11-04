import test from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateAddress, parseRemoteUrl } from '../lib/http.js'
import { applyReplacements, normalizeReplacements } from '../lib/replacements.js'
import { mapList, normalizeSource, renderTemplate, responseDocument } from '../lib/rules.js'

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

test('basic source normalization rejects JS, XPath and secrets clearly', () => {
  const base = { bookSourceName: 'test', bookSourceUrl: 'https://example.com', ruleSearch: { url: '/search', bookList: '.book' } }
  const normalized = normalizeSource(base)
  assert.match(normalized.id, /^[a-zA-Z0-9_-]+$/)
  assert.equal(normalizeSource(base).id, normalized.id)
  assert.equal(normalized.bookSourceUrl, 'https://example.com')
  assert.throws(() => normalizeSource({ ...base, ruleContent: { content: '<js>document.body</js>' } }), /需第二期高兼容引擎/)
  assert.throws(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, bookList: '@xpath://div' } }), /XPath/)
  assert.throws(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, headers: { Cookie: 'secret' } } }), /not allowed|must not contain secrets/)
  assert.throws(() => normalizeSource({ ...base, token: 'secret' }), /must not contain secrets/)
  assert.throws(() => normalizeSource({ ...base, ruleSearch: { ...base.ruleSearch, headers: { 'X-Api-Key': 'secret' } } }), /not allowed|must not contain secrets/)
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

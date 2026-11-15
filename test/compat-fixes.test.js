import test from 'node:test'
import assert from 'node:assert/strict'
import { AnalyzeRule } from '../dist/core/rules/analyze-rule.js'
import { buildSearchRequest } from '../dist/core/source/url.js'

test('JSONPath 选中数组时展开为元素（书源 bookList: $.data）', () => {
  const json = JSON.stringify({ code: 200, data: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })
  const rule = new AnalyzeRule(json, { baseUrl: 'https://example.test' })
  const elements = rule.getElements('$.data')
  assert.equal(elements.length, 3)
  const first = new AnalyzeRule(elements[0], { baseUrl: 'https://example.test' })
  assert.equal(first.getString('$.title'), 'A')
})

test('单引号选项后缀解析为 POST 与 body', () => {
  const source = {
    bookSourceUrl: 'https://example.test',
    bookSourceName: '示例',
    searchUrl: "/modules/article/search.php,{'charset':'gbk','method':'POST','body':'searchkey={{key}}'}",
  }
  const request = buildSearchRequest(source, '剑来', 1)
  assert.ok(request)
  assert.equal(request.url, 'https://example.test/modules/article/search.php')
  assert.equal(request.method, 'POST')
  assert.equal(request.body, `searchkey=${encodeURIComponent('剑来')}`)
})

test('java 对象上可直接调用 ajax / put / longToast 等 JsExtensions 函数', async () => {
  const { evalJs } = await import('../dist/core/rules/js.js')
  const variables = {}
  const value = evalJs(
    "java.put('k', 'v'); java.longToast('x'); return java.getVariable('k')",
    { variables },
  )
  assert.equal(value, 'v')
  assert.equal(variables.k, 'v')
})

test('URL 尾部内联选项（percent-encode）解析为 POST/body/headers', async () => {
  const { splitUrlOptions } = await import('../dist/core/source/url.js')
  const raw =
    'https://novel.html5.qq.com/be-api/content/ads-read,%7B%22method%22%3A%20%22POST%22%2C%22body%22%3A%20%7B%22a%22%3A1%7D%2C%22headers%22%3A%20%7B%22Q-GUID%22%3A%22g%22%7D%7D'
  const parsed = splitUrlOptions(raw)
  assert.equal(parsed.url, 'https://novel.html5.qq.com/be-api/content/ads-read')
  assert.equal(parsed.method, 'POST')
  assert.equal(parsed.body, '{"a":1}')
  assert.equal(parsed.headers?.['Q-GUID'], 'g')
  assert.equal(parsed.headers?.['Content-Type'], 'application/json')
})

test('JSON 文本内容按结构化解析（<p>{{$.data...}}</p>）', () => {
  const rule = new AnalyzeRule('{"data":{"Content":[{"Content":"正文内容"}]}}')
  assert.equal(rule.getString('<p>{{$.data.Content[0].Content}}</p>'), '<p>正文内容</p>')
})

test('java.timeFormat 输出 yyyy/MM/dd HH:mm', async () => {
  const { evalJs } = await import('../dist/core/rules/js.js')
  const value = evalJs('java.timeFormat(0)', {})
  assert.match(String(value), /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
})

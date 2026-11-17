import assert from 'node:assert/strict'
import test from 'node:test'

const HTML = `<!doctype html><html><body>
  <div class="book-list">
    <li class="item"><a href="/b/1">三体</a><span class="author">刘慈欣</span></li>
    <li class="item"><a href="/b/2">球状闪电</a><span class="author">刘慈欣</span></li>
  </div>
  <div class="note">&amp;lt;b&amp;gt;</div>
</body></html>`

test('splitTopLevel：顶层切分与括号/引号保护', async () => {
  const { splitTopLevel } = await import('../dist/core/rules/split.js')

  assert.deepEqual(splitTopLevel('a && b', ['&&']), { parts: ['a', 'b'], type: '&&' })
  assert.deepEqual(splitTopLevel('a || b || c', ['||']), { parts: ['a', 'b', 'c'], type: '||' })
  assert.deepEqual(splitTopLevel('a %% b', ['%%']).type, '%%')
  assert.deepEqual(splitTopLevel('a(b&&c) && d', ['&&']).parts, ['a(b&&c)', 'd'])
  assert.deepEqual(splitTopLevel('a["x&&y"] && b', ['&&']).parts, ['a["x&&y"]', 'b'])
  assert.deepEqual(splitTopLevel('a\\&&b && c', ['&&']).parts, ['a\\&&b', 'c'])
})

test('SourceRule：模式识别、@put、## 替换与参数', async () => {
  const { SourceRule } = await import('../dist/core/rules/source-rule.js')

  const env = {
    getStringByRule: () => '',
    evalJs: () => 'js',
    getVariable: (key) => ({ k: 'v' }[key] ?? ''),
  }

  assert.equal(new SourceRule('@CSS:div').mode, 'Default')
  assert.equal(new SourceRule('@@div').mode, 'Default')
  assert.equal(new SourceRule('@@div').makeUpRule('', env).rule, 'div')
  assert.equal(new SourceRule('@XPath://div').mode, 'XPath')
  assert.equal(new SourceRule('@Json:$.a').mode, 'Json')
  assert.equal(new SourceRule('$.a').mode, 'Json')
  assert.equal(new SourceRule('/html/body').mode, 'XPath')
  assert.equal(new SourceRule('tag.div').mode, 'Default')
  const put = new SourceRule('@put:{"k":"v"}@get:{k}')
  assert.deepEqual(put.putMap, { k: 'v' })
  const resolved = put.makeUpRule('', env)
  assert.equal(resolved.rule, 'v')

  const withReplace = new SourceRule('tag.a@text##三体##三体·修订')
  const replaced = withReplace.makeUpRule('', env)
  assert.equal(replaced.rule, 'tag.a@text')
  assert.equal(replaced.replaceRegex, '三体')
  assert.equal(replaced.replacement, '三体·修订')
  assert.equal(replaced.replaceFirst, false)

  const firstOnly = new SourceRule('tag.a@text##三体##三体·修订##').makeUpRule('', env)
  assert.equal(firstOnly.replaceFirst, true)
})

test('JsoupAnalyzer：链式规则、索引、@CSS 与属性', async () => {
  const { JsoupAnalyzer, HtmlNode } = await import('../dist/core/rules/jsoup.js')

  const jsoup = new JsoupAnalyzer(HTML)
  assert.equal(jsoup.getString('class.book-list@tag.li@a@text'), '三体\n球状闪电')
  assert.deepEqual(jsoup.getStringList('class.book-list@tag.li@a@text'), ['三体', '球状闪电'])
  assert.deepEqual(jsoup.getStringList('class.book-list@tag.li.0@a@text'), ['三体'])
  assert.deepEqual(jsoup.getStringList('class.book-list@tag.li[0,1]@a@text'), ['三体', '球状闪电'])
  assert.deepEqual(jsoup.getStringList('class.book-list@tag.li[!0]@a@text'), ['球状闪电'])
  assert.equal(jsoup.getString('class.book-list@tag.li@a@href'), '/b/1\n/b/2')
  assert.equal(jsoup.getString('@CSS:.book-list li a@text'), '三体\n球状闪电')
  assert.equal(jsoup.getString('@CSS:.book-list li a@text && .note@text'), '三体\n球状闪电\n&lt;b&gt;')

  const items = jsoup.getElements('class.book-list@tag.li')
  assert.equal(items.length, 2)
  assert.ok(items[0] instanceof HtmlNode)
  assert.equal(items[0].text.trim(), '三体刘慈欣')
})

test('AnalyzeRule：HTML 取值、列表、元素、URL、反转义与替换', async () => {
  const { AnalyzeRule } = await import('../dist/core/rules/analyze-rule.js')

  const rule = new AnalyzeRule(HTML, { baseUrl: 'https://example.com/book/1' })
  assert.equal(rule.getString('class.book-list@tag.li@a@text'), '三体\n球状闪电')
  assert.deepEqual(rule.getStringList('class.book-list@tag.li@a@text'), ['三体', '球状闪电'])
  assert.equal(rule.getString('class.note@text'), '<b>')
  assert.equal(
    rule.getString('class.book-list@tag.li@a@text##三体##三体·修订'),
    '三体·修订\n球状闪电',
  )

  const items = rule.getElements('class.book-list@tag.li')
  assert.equal(items.length, 2)
  const first = new AnalyzeRule(items[0], { baseUrl: 'https://example.com/book/1' })
  assert.equal(first.getString('a@text'), '三体')
  assert.equal(first.getString('a@href'), '/b/1')
  assert.equal(first.getString('a@href', undefined, true), 'https://example.com/b/1')

  assert.equal(rule.getString('@js:result.length > 0 ? "ok" : "no"'), 'ok')
})

test('AnalyzeRule：JSONPath、&& 与 {$...} 内嵌规则', async () => {
  const { AnalyzeRule } = await import('../dist/core/rules/analyze-rule.js')

  const data = { key: 'name', data: { name: '三体', list: [{ name: '三体' }, { name: '球状闪电' }], total: 2 } }
  const rule = new AnalyzeRule(data)
  assert.equal(rule.getString('$.data.list[*].name'), '三体\n球状闪电')
  assert.deepEqual(rule.getStringList('$.data.list[*].name'), ['三体', '球状闪电'])
  assert.equal(rule.getString('$.data.list[*].name && $.data.total'), '三体\n球状闪电\n2')
  assert.equal(rule.getString('$.data.{$.key}'), '三体')

  const elements = rule.getElements('$.data.list[*]')
  assert.equal(elements.length, 2)
  assert.equal(new AnalyzeRule(elements[0]).getString('$.name'), '三体')
})

test('AnalyzeRule：{{}} 与 @get 变量', async () => {
  const { AnalyzeRule } = await import('../dist/core/rules/analyze-rule.js')

  const rule = new AnalyzeRule({ name: '三体' })
  assert.equal(rule.getString('{{result.name}}'), '三体')
  assert.equal(rule.getString('@put:{"k":"v"}@get:{k}'), 'v')
})

test('RegexAnalyzer 与 XPathAnalyzer 基础语义', async () => {
  const { RegexAnalyzer } = await import('../dist/core/rules/regex.js')
  const { XPathAnalyzer } = await import('../dist/core/rules/xpath.js')

  const regex = new RegexAnalyzer('abc123def456')
  assert.deepEqual(regex.getElements('(\\d+)'), ['123', '456'])
  assert.equal(regex.getString('(\\d+)'), '123\n456')

  const xpath = new XPathAnalyzer('<div class="a">x</div><div class="b">y</div>')
  assert.deepEqual(xpath.getStringList('//div[@class="a"]/text()'), ['x'])
  assert.deepEqual(xpath.getStringList('//div[contains(@class,"b")]/text()'), ['y'])
  assert.deepEqual(xpath.getStringList('/html/body/div[1]/text()'), ['x'])
  assert.deepEqual(xpath.getStringList('//div[@data-x]/text()'), [])
})

test('AnalyzeRule：java.getString 回查当前内容', async () => {
  const { AnalyzeRule } = await import('../dist/core/rules/analyze-rule.js')

  const rule = new AnalyzeRule('<div class="a">hi</div><a href="/x">link</a>', {
    baseUrl: 'https://example.com/',
  })
  assert.equal(rule.getString('@js: java.getString("class.a@text")'), 'hi')
  assert.equal(rule.getString('@js: java.getString("a@href")'), '/x')
})

test('书源 JS：多语句脚本取最后一条表达式（阅读的完成值语义）', async () => {
  const { evalJs } = await import('../dist/core/rules/js.js')

  const value = evalJs('var a = 1;\nvar b = 2;\na + b', {})
  assert.equal(value, 3)
})

test('XPath：开头的 (//x)[n] 与 //x[n] 等价', async () => {
  const { XPathAnalyzer } = await import('../dist/core/rules/xpath.js')
  const html = `<div class="list"><div class="item"><a href="/1">A</a></div><div class="item"><a href="/2">B</a></div></div>`
  const analyzer = new XPathAnalyzer(html)
  const a = analyzer.getString('(//div[@class="item"])[2]//a')
  const b = analyzer.getString('//div[@class="item"][2]//a')
  assert.equal(a, b)
})

import assert from 'node:assert/strict'
import test from 'node:test'

const SOURCE = {
  bookSourceUrl: 'https://example.com',
  bookSourceName: '示例源',
  searchUrl: 'https://example.com/search?q={{key}}&page={{page}}',
  ruleSearch: {
    bookList: 'class.result',
    name: 'h3@a@text',
    bookUrl: 'h3@a@href',
    author: 'class.author@text',
    kind: 'class.kind@text',
    intro: 'class.intro@text',
  },
  ruleBookInfo: {
    name: 'h1@text',
    author: 'class.author@text',
    kind: 'class.kind@text',
    intro: 'class.intro@text',
    coverUrl: 'class.cover@src',
    tocUrl: 'class.toc@href',
  },
  ruleToc: {
    chapterList: 'class.toc@tag.li',
    chapterName: 'a@text||text',
    chapterUrl: 'a@href',
  },
  ruleContent: {
    content: 'id.content@text',
  },
}

const SEARCH_HTML = `
  <div class="result">
    <h3><a href="/book/1">三体</a></h3>
    <span class="author">刘慈欣</span>
    <span class="kind">科幻</span>
    <p class="intro">地球往事三部曲。</p>
  </div>
  <div class="result">
    <h3><a href="/book/2">球状闪电</a></h3>
    <span class="author">刘慈欣</span>
    <span class="kind">科幻</span>
    <p class="intro">雷电的故事。</p>
  </div>
`

const INFO_HTML = `
  <div id="info">
    <h1>三体</h1>
    <a class="author" href="/author/1">刘慈欣</a>
    <span class="kind">科幻</span>
    <img class="cover" src="/cover/1.jpg">
    <a class="toc" href="/toc/1">目录</a>
  </div>
`

const TOC_HTML = `
  <ul class="toc">
    <li>第一卷</li>
    <li><a href="/chapter/1">第1章</a></li>
    <li><a href="/chapter/2">第2章</a></li>
  </ul>
`

const CONTENT_HTML = '<div id="content"><p>第一段</p><p>第二段</p><p>第三段</p></div>'

test('BookSource：字段解析与数组导入', async () => {
  const { parseSource, parseSources } = await import('../dist/core/model/source.js')

  const source = parseSource(SOURCE)
  assert.equal(source.bookSourceName, '示例源')
  assert.equal(source.ruleSearch.bookList, 'class.result')
  assert.equal(source.ruleToc.chapterName, 'a@text||text')

  const list = parseSources([SOURCE, { ...SOURCE, bookSourceUrl: 'https://b.example.com' }])
  assert.equal(list.length, 2)
})

test('URL 规则：{{key}}/{{page}}、POST 选项、相对地址与 JS', async () => {
  const { buildRequest, buildSearchRequest, parseHeaders } = await import('../dist/core/source/url.js')
  const { parseSource } = await import('../dist/core/model/source.js')
  const source = parseSource(SOURCE)

  const search = buildSearchRequest(source, '三体', 2)
  assert.ok(search)
  assert.equal(
    search.url,
    'https://example.com/search?q=%E4%B8%89%E4%BD%93&page=2',
  )
  assert.equal(search.method, 'GET')

  const post = buildRequest(
    'https://example.com/s,{"method":"POST","body":"key={{key}}"}',
    { key: '三体', baseUrl: 'https://example.com' },
  )
  assert.ok(post)
  assert.equal(post.method, 'POST')
  assert.equal(post.body, 'key=%E4%B8%89%E4%BD%93')

  const relative = buildRequest('search?q={{key}}', {
    key: 'a',
    baseUrl: 'https://example.com',
  })
  assert.equal(relative.url, 'https://example.com/search?q=a')

  const js = buildRequest('@js:return "https://example.com/x?k=" + encodeURIComponent(key)', {
    key: '三体',
    baseUrl: 'https://example.com',
  })
  assert.equal(js.url, 'https://example.com/x?k=%E4%B8%89%E4%BD%93')

  assert.deepEqual(parseHeaders('{"A":"1"}'), { A: '1' })
  assert.deepEqual(parseHeaders('not json'), {})
})

test('搜索解析：字段、相对 URL 与去重入口', async () => {
  const { analyzeSearch } = await import('../dist/core/source/analyze.js')
  const { parseSource } = await import('../dist/core/model/source.js')
  const source = parseSource(SOURCE)

  const results = analyzeSearch(SEARCH_HTML, source)
  assert.equal(results.length, 2)
  assert.equal(results[0].name, '三体')
  assert.equal(results[0].author, '刘慈欣')
  assert.equal(results[0].kind, '科幻')
  assert.equal(results[0].bookUrl, 'https://example.com/book/1')
  assert.equal(results[0].origin, 'https://example.com')
  assert.equal(results[0].type, 0)
})

test('详情与目录解析：tocUrl、卷与章节 URL', async () => {
  const { analyzeBookInfo, analyzeToc } = await import('../dist/core/source/analyze.js')
  const { parseSource } = await import('../dist/core/model/source.js')
  const source = parseSource(SOURCE)

  const info = analyzeBookInfo(INFO_HTML, source, 'https://example.com/book/1', 'https://example.com/book/1')
  assert.equal(info.name, '三体')
  assert.equal(info.author, '刘慈欣')
  assert.equal(info.coverUrl, 'https://example.com/cover/1.jpg')
  assert.equal(info.tocUrl, 'https://example.com/toc/1')

  const chapters = analyzeToc(TOC_HTML, source)
  assert.equal(chapters.length, 3)
  assert.deepEqual(chapters[0], { title: '第一卷', url: '', isVolume: true })
  assert.deepEqual(chapters[1], {
    title: '第1章',
    url: 'https://example.com/chapter/1',
    isVolume: false,
  })
})

test('正文解析：保留段落文本', async () => {
  const { analyzeContent } = await import('../dist/core/source/analyze.js')
  const { parseSource } = await import('../dist/core/model/source.js')
  const source = parseSource(SOURCE)

  const text = analyzeContent(CONTENT_HTML, source)
  assert.ok(text.includes('第一段'))
  assert.ok(text.includes('第三段'))
})

test('正文 HTML 片段转纯文本', async () => {
  const { analyzeContent } = await import('../dist/core/source/analyze.js')
  const { parseSource } = await import('../dist/core/model/source.js')
  const source = parseSource({
    bookSourceUrl: 'https://example.com',
    bookSourceName: '示例源',
    ruleContent: { content: '<js>"<p>第一段</p><p>第二段</p>"</js>' },
  })
  const text = analyzeContent({}, source)
  assert.equal(text, '第一段\n第二段')
})

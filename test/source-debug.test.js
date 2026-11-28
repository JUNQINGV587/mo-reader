/**
 * 书源调试面板（#147）：服务层输出结构。
 * 覆盖搜索、发现、失败三条主链路，断言 kind/label/count/elapsedMs/request/result/raw/error 齐全。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const ORIGIN = 'https://debug.example.com'

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

async function makeService(source) {
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  sources.map.set(source.bookSourceUrl, source)
  const service = Object.create(ReaderService.prototype)
  service.db = { sources }
  return service
}

function searchSource(extra = {}) {
  return {
    bookSourceUrl: ORIGIN,
    bookSourceName: '调试源',
    searchUrl: '/search,{' + '"method":"POST","body":"q={{key}}"' + '}',
    ruleSearch: {
      bookList: 'class.result',
      name: "@js:java.log('解析书名'); '三体'",
      bookUrl: 'h3@a@href',
      author: 'class.author@text',
    },
    ...extra,
  }
}

const SEARCH_HTML =
  '<div class="result"><h3><a href="/book/1">三体</a></h3><span class="author">刘慈欣</span></div>'

test('调试搜索：结构齐全、命中数、POST body、@js 日志与 raw 截断', async () => {
  const service = await makeService(searchSource())
  const text = SEARCH_HTML + 'x'.repeat(210000)
  service.fetch = async () => ({ status: 200, text, url: ORIGIN + '/search' })

  const report = await service.debugSource({ sourceUrl: ORIGIN, type: 'search', key: '三体' })

  assert.equal(report.type, 'search')
  assert.equal(report.kind, 'search')
  assert.equal(report.label, '搜索')
  assert.equal(report.count, 1)
  assert.equal(typeof report.elapsedMs, 'number')
  assert.ok(report.elapsedMs >= 0)
  assert.equal(report.request.method, 'POST')
  assert.equal(report.request.url, ORIGIN + '/search')
  assert.equal(report.request.body, 'q=%E4%B8%89%E4%BD%93')
  assert.equal(report.status, 200)
  assert.equal(report.result.length, 1)
  assert.equal(report.result[0].name, '三体')
  assert.equal(report.result[0].author, '刘慈欣')
  assert.equal(report.result[0].bookUrl, ORIGIN + '/book/1')
  assert.equal(report.rawLength, text.length)
  assert.equal(report.raw.length, 200000)
  assert.equal(report.rawTruncated, true)
  assert.ok(report.logs.includes('解析书名'), JSON.stringify(report.logs))
  assert.equal(report.error, null)
  for (const key of ['kind', 'count', 'elapsedMs', 'request', 'result', 'raw', 'error']) {
    assert.ok(key in report, key)
  }
})

test('调试发现：未填地址取首个分类，解析与发现页同形状', async () => {
  const service = await makeService({
    bookSourceUrl: ORIGIN,
    bookSourceName: '调试源',
    exploreUrl: '玄幻::/explore/x?page={{page}}\n都市::/explore/d',
    ruleExplore: {
      bookList: 'class.item',
      name: 'a.name@text',
      bookUrl: 'a.name@href',
      author: 'class.author@text',
    },
  })
  service.fetch = async (request) => ({
    status: 200,
    text: '<div class="item"><a class="name" href="/book/9">诡秘之主</a><span class="author">爱潜水的乌贼</span></div>',
    url: request.url,
  })

  const first = await service.debugSource({ sourceUrl: ORIGIN, type: 'explore' })
  assert.equal(first.kind, 'explore')
  assert.equal(first.label, '发现')
  assert.equal(first.count, 1)
  assert.equal(first.request.method, 'GET')
  assert.equal(first.request.url, ORIGIN + '/explore/x?page=1')
  assert.equal(first.result[0].name, '诡秘之主')
  assert.equal(first.result[0].bookUrl, ORIGIN + '/book/9')
  assert.equal(first.error, null)

  const explicit = await service.debugSource({ sourceUrl: ORIGIN, type: 'explore', url: '/explore/d' })
  assert.equal(explicit.request.url, ORIGIN + '/explore/d')
  assert.equal(explicit.count, 1)
})

test('调试失败：保留环节、请求摘要、错误消息与 stack', async () => {
  const service = await makeService(searchSource())
  service.fetch = async () => {
    throw new Error('连接被拒绝')
  }

  const report = await service.debugSource({ sourceUrl: ORIGIN, type: 'search', key: '三体' })

  assert.equal(report.kind, 'search')
  assert.equal(report.label, '搜索')
  assert.equal(report.count, 0)
  assert.equal(report.result, null)
  assert.equal(report.raw, '')
  assert.equal(report.status, null)
  assert.ok(report.request && report.request.url.startsWith(ORIGIN + '/search'))
  assert.equal(report.error.message, '连接被拒绝')
  assert.match(report.error.stack, /连接被拒绝/)
  assert.match(report.error.stack, /Error/)
})

test('调试非 2xx：标为失败并给出 HTTP 状态，仍保留请求与原始返回', async () => {
  const service = await makeService(searchSource())
  service.fetch = async (request) => ({ status: 404, text: '<html>not found</html>', url: request.url })

  const report = await service.debugSource({ sourceUrl: ORIGIN, type: 'search', key: '三体' })

  assert.equal(report.kind, 'search')
  assert.equal(report.status, 404)
  assert.equal(report.count, 0)
  assert.equal(report.error.message, 'HTTP 404')
  assert.ok(report.request && report.request.url.startsWith(ORIGIN + '/search'))
  assert.match(report.raw, /not found/)
})

test('调试失败：缺页面地址与未知书源也返回结构化报告', async () => {
  const service = await makeService(searchSource())
  service.fetch = async () => ({ status: 200, text: '', url: ORIGIN })

  const missing = await service.debugSource({ sourceUrl: ORIGIN, type: 'content' })
  assert.equal(missing.kind, 'content')
  assert.equal(missing.label, '正文')
  assert.equal(missing.error.message, '缺少页面 URL')
  assert.match(missing.error.stack, /缺少页面 URL/)

  const unknown = await service.debugSource({ sourceUrl: 'https://none.example.com', type: 'search' })
  assert.equal(unknown.kind, 'search')
  assert.match(unknown.error.message, /书源不存在/)
  assert.equal(unknown.request, null)
})

test('调试正文：解析结果与线上 analyzeContent 一致', async () => {
  const service = await makeService(searchSource({ ruleContent: { content: 'id.content@text' } }))
  service.fetch = async () => ({
    status: 200,
    text: '<div id="content"><p>第一段</p><p>第二段</p></div>',
    url: ORIGIN + '/chapter/1',
  })

  const report = await service.debugSource({
    sourceUrl: ORIGIN,
    type: 'content',
    url: ORIGIN + '/chapter/1',
  })
  assert.equal(report.count, 1)
  assert.equal(report.result, '第一段第二段')
  assert.equal(report.rawTruncated, false)
})
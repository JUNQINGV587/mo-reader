import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources,
    books: fakeTable(),
    chapters: fakeTable(),
    readRecords: fakeTable(),
    notes: fakeTable(),
    bookmarks: fakeTable(),
    dictRules: fakeTable(),
  }
  return { service, sources: sources.map }
}

const SOURCE_A = {
  bookSourceUrl: 'https://a.example.com',
  bookSourceName: '甲源',
  bookSourceGroup: '科幻',
  bookSourceType: 0,
  enabled: true,
  enabledExplore: true,
  exploreUrl: '分类::/explore?page={{page}}',
  loginUrl: 'https://a.example.com/login',
  searchUrl: 'https://a.example.com/search?q={{key}}&page={{page}}',
  header: '{"Referer":"https://a.example.com/"}',
  customOrder: 2,
  ruleSearch: {
    bookList: 'class.result',
    name: 'h3@a@text',
    bookUrl: 'h3@a@href',
    author: 'class.author@text',
  },
  ruleToc: { chapterList: 'class.toc@tag.li', chapterName: 'a@text', chapterUrl: 'a@href' },
  ruleContent: { content: 'id.content@text' },
  vendorExtra: { note: '未知字段原样保留' },
}

const SOURCE_B = {
  bookSourceUrl: 'https://b.example.com',
  bookSourceName: '乙源',
  bookSourceGroup: '都市',
  enabled: false,
  searchUrl: 'https://b.example.com/search?q={{key}}',
  ruleSearch: { bookList: 'class.item', name: 'a@text', bookUrl: 'a@href' },
}

test('书源导出：单源与多源导出为 Legado JSON，可被导入流程回导', async () => {
  const { service } = await makeService()
  const imported = await service.importSources({ payload: JSON.stringify([SOURCE_A, SOURCE_B]) })
  assert.equal(imported.added, 2)

  const list = await service.listSources()
  const a = list.sources.find((item) => item.bookSourceUrl === SOURCE_A.bookSourceUrl)
  const b = list.sources.find((item) => item.bookSourceUrl === SOURCE_B.bookSourceUrl)
  assert.ok(a?.id)
  assert.ok(b?.id)

  const single = await service.exportSources({ ids: [a.id] })
  assert.equal(single.count, 1)
  const singleList = JSON.parse(single.json)
  assert.ok(Array.isArray(singleList))
  assert.equal(singleList.length, 1)
  assert.equal(singleList[0].bookSourceUrl, SOURCE_A.bookSourceUrl)
  assert.equal(singleList[0].bookSourceName, SOURCE_A.bookSourceName)
  assert.equal(singleList[0].searchUrl, SOURCE_A.searchUrl)
  assert.deepEqual(singleList[0].ruleSearch, SOURCE_A.ruleSearch)
  assert.deepEqual(singleList[0].vendorExtra, SOURCE_A.vendorExtra)
  // 存储 key 是内部字段，不能混进 Legado JSON。
  assert.equal('id' in singleList[0], false)

  const batch = await service.exportSources({ ids: [a.id, b.id] })
  assert.equal(batch.count, 2)
  assert.deepEqual(
    JSON.parse(batch.json).map((item) => item.bookSourceUrl),
    [SOURCE_A.bookSourceUrl, SOURCE_B.bookSourceUrl],
  )

  // 导出的 JSON 必须能被现有导入流程原样回导（导入到全新服务）。
  const fresh = await makeService()
  const reimported = await fresh.service.importSources({ payload: batch.json })
  assert.equal(reimported.added, 2)
  assert.equal(reimported.updated, 0)
  assert.equal(reimported.errors.length, 0)
  const reimportedList = await fresh.service.listSources()
  const reimportedA = reimportedList.sources.find((item) => item.bookSourceUrl === SOURCE_A.bookSourceUrl)
  assert.equal(reimportedA.bookSourceName, SOURCE_A.bookSourceName)
  assert.equal(reimportedA.bookSourceGroup, SOURCE_A.bookSourceGroup)
  assert.equal(reimportedA.enabled, SOURCE_A.enabled)
  assert.equal(reimportedA.enabledExplore, SOURCE_A.enabledExplore)
  assert.equal(reimportedA.exploreUrl, SOURCE_A.exploreUrl)
  assert.equal(reimportedA.loginUrl, SOURCE_A.loginUrl)
  assert.equal(reimportedA.searchUrl, SOURCE_A.searchUrl)
  assert.equal(reimportedA.header, SOURCE_A.header)
  assert.equal(reimportedA.customOrder, SOURCE_A.customOrder)
  assert.deepEqual(reimportedA.ruleToc, SOURCE_A.ruleToc)
  assert.deepEqual(reimportedA.ruleContent, SOURCE_A.ruleContent)

  await assert.rejects(() => service.exportSources({ ids: [] }), /缺少参数 ids/)
})

test('书源筛选：登录要求与有发现可与分组、域名、搜索叠加', async () => {
  const { filterSources, hasExplore, needsLogin, sourceHost } = await import(
    '../dist/core/source/filter.js'
  )
  const list = [
    {
      bookSourceUrl: 'https://a.example.com',
      bookSourceName: '甲源',
      bookSourceGroup: '科幻',
      loginUrl: 'https://a.example.com/login',
      enabledExplore: true,
      exploreUrl: '分类::/explore',
    },
    {
      bookSourceUrl: 'http://b.example.com:8080',
      bookSourceName: '乙源',
      bookSourceGroup: '科幻',
      enabledExplore: false,
      exploreUrl: '/explore',
    },
    {
      bookSourceUrl: 'https://c.example.com',
      bookSourceName: '丙源',
      bookSourceGroup: '都市',
      loginUi: '登录界面',
      enabledExplore: true,
      exploreUrl: '',
    },
    {
      bookSourceUrl: 'https://d.example.com',
      bookSourceName: '丁源',
      bookSourceGroup: '都市',
      enabledExplore: true,
    },
    {
      bookSourceUrl: 'https://e.example.com',
      bookSourceName: '戊源',
      bookSourceGroup: '科幻',
      loginCheckJs: 'if (needLogin) {}',
      enabledExplore: true,
      exploreUrl: '分类::/x',
    },
  ]
  const urls = (items) => items.map((item) => item.bookSourceUrl)

  assert.deepEqual(urls(filterSources(list)), urls(list))
  assert.deepEqual(urls(filterSources(list, { login: 'all' })), urls(list))
  assert.deepEqual(urls(filterSources(list, { login: 'required' })), [
    'https://a.example.com',
    'https://c.example.com',
    'https://e.example.com',
  ])
  assert.deepEqual(urls(filterSources(list, { login: 'none' })), [
    'http://b.example.com:8080',
    'https://d.example.com',
  ])

  assert.deepEqual(urls(filterSources(list, { exploreOnly: true })), [
    'https://a.example.com',
    'https://e.example.com',
  ])
  // 叠加：分组 + 需登录；分组 + 有发现；分组 + 免登录；登录 + 有发现。
  assert.deepEqual(urls(filterSources(list, { group: '科幻', login: 'required' })), [
    'https://a.example.com',
    'https://e.example.com',
  ])
  assert.deepEqual(urls(filterSources(list, { group: '科幻', exploreOnly: true })), [
    'https://a.example.com',
    'https://e.example.com',
  ])
  assert.deepEqual(urls(filterSources(list, { group: '都市', login: 'none' })), [
    'https://d.example.com',
  ])
  assert.deepEqual(urls(filterSources(list, { login: 'required', exploreOnly: true })), [
    'https://a.example.com',
    'https://e.example.com',
  ])
  // 域名与搜索沿用原语义。
  assert.deepEqual(urls(filterSources(list, { domain: 'b.example.com:8080' })), [
    'http://b.example.com:8080',
  ])
  assert.deepEqual(urls(filterSources(list, { key: '丙' })), ['https://c.example.com'])
  assert.deepEqual(urls(filterSources(list, { key: 'B.EXAMPLE' })), ['http://b.example.com:8080'])
  assert.deepEqual(urls(filterSources(list, { group: '都市', domain: 'c.example.com', login: 'none' })), [])

  assert.equal(needsLogin({ loginUrl: 'https://x/login' }), true)
  assert.equal(needsLogin({ loginUi: '登录框' }), true)
  assert.equal(needsLogin({ loginCheckJs: 'return 1' }), true)
  assert.equal(needsLogin({ loginUrl: '  ' }), false)
  assert.equal(needsLogin({}), false)

  assert.equal(hasExplore({ enabledExplore: true, exploreUrl: '分类::/x' }), true)
  assert.equal(hasExplore({ enabledExplore: true, exploreUrl: '  ' }), false)
  assert.equal(hasExplore({ enabledExplore: true }), false)
  assert.equal(hasExplore({ enabledExplore: false, exploreUrl: '/x' }), false)
  assert.equal(hasExplore({ exploreUrl: '/x' }), false)

  assert.equal(sourceHost('https://a.example.com/path?q=1'), 'a.example.com')
  assert.equal(sourceHost('not a url'), '')
  assert.equal(sourceHost(undefined), '')
})

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${server.address().port}`
}

test('在线检查：成功、失败状态码与超时按输入顺序返回', async (t) => {
  const timers = new Set()
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><body>ok</body></html>')
      return
    }
    if (req.url === '/moved') {
      res.writeHead(302, { Location: '/ok' })
      res.end()
      return
    }
    if (req.url === '/missing') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('not found')
      return
    }
    if (req.url === '/slow') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('late')
      }, 2000)
      timer.unref()
      timers.add(timer)
      return
    }
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('boom')
  })
  const origin = await listen(server)
  t.after(() => {
    for (const timer of timers) clearTimeout(timer)
    server.close()
  })

  process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'
  try {
    const { service } = await makeService()
    const urls = [`${origin}/ok`, `${origin}/moved`, `${origin}/missing`, `${origin}/slow`]
    const started = Date.now()
    const { results } = await service.checkSources({ urls, timeoutMs: 500 })
    const elapsed = Date.now() - started

    assert.deepEqual(
      results.map((result) => result.url),
      urls,
    )
    assert.equal(results[0].ok, true)
    assert.equal(results[0].status, 200)
    assert.equal(results[0].error, '')
    assert.ok(results[0].elapsedMs >= 0)

    // 3xx 重定向被跟随，最终状态 2xx：可达。
    assert.equal(results[1].ok, true)
    assert.equal(results[1].status, 200)

    assert.equal(results[2].ok, false)
    assert.equal(results[2].status, 404)
    assert.equal(results[2].error, 'HTTP 404')

    // 超时只影响这一条，整通调用照常返回；timeoutMs=500 被 clamp 到最小 500。
    assert.equal(results[3].ok, false)
    assert.equal(results[3].status, null)
    assert.match(results[3].error, /超时/)
    assert.ok(results[3].elapsedMs >= 450, `超时耗时 ${results[3].elapsedMs}ms`)
    assert.ok(elapsed < 1800, `整通调用不应等待慢请求 2000ms，实际 ${elapsed}ms`)
  } finally {
    delete process.env.MO_READER_INSECURE_ALLOW_PRIVATE
  }
})

test('在线检查：私网与非法地址直接失败且不发起请求', async (t) => {
  delete process.env.MO_READER_INSECURE_ALLOW_PRIVATE
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(req.url)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('hit')
  })
  const origin = await listen(server)
  t.after(() => server.close())
  const { port } = server.address()

  const { service } = await makeService()
  const urls = [
    `${origin}/hit`,
    `http://localhost:${port}/hit`,
    'http://10.0.0.1/secret',
    'file:///etc/passwd',
    'not-a-url',
  ]
  const { results } = await service.checkSources({ urls })

  assert.deepEqual(
    results.map((result) => result.url),
    urls,
  )
  for (const result of results) {
    assert.equal(result.ok, false)
    assert.equal(result.status, null)
    assert.ok(result.error)
    assert.ok(result.elapsedMs >= 0)
  }
  assert.match(results[0].error, /本机|内网/)
  assert.match(results[1].error, /本机|内网/)
  assert.match(results[2].error, /本机|内网/)
  assert.match(results[3].error, /http\/https/)
  assert.match(results[4].error, /非法 URL/)
  // 守卫必须在发请求之前拦下：本地服务器一次都没被打到。
  assert.equal(hits.length, 0)
})

test('在线检查：并发上限 8 且按输入顺序返回', async (t) => {
  process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'
  const timers = new Set()
  let inFlight = 0
  let maxInFlight = 0
  const server = http.createServer((req, res) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    const timer = setTimeout(() => {
      inFlight -= 1
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    }, 120)
    timer.unref()
    timers.add(timer)
  })
  const origin = await listen(server)
  t.after(() => {
    for (const timer of timers) clearTimeout(timer)
    delete process.env.MO_READER_INSECURE_ALLOW_PRIVATE
    server.close()
  })

  const { service } = await makeService()
  const urls = Array.from({ length: 12 }, (_, index) => `${origin}/check?i=${index}`)
  const started = Date.now()
  const { results } = await service.checkSources({ urls })
  const elapsed = Date.now() - started

  // 先完成的请求不能插到前面：结果顺序等于输入顺序。
  assert.deepEqual(
    results.map((result) => result.url),
    urls,
  )
  assert.ok(results.every((result) => result.ok && result.status === 200))
  assert.equal(maxInFlight, 8)
  // 12 个请求各 120ms：串行约 1440ms；上限 8 时两批约 240ms。
  assert.ok(elapsed >= 180, `总耗时 ${elapsed}ms 应有第二批`)
  assert.ok(elapsed < 1000, `总耗时 ${elapsed}ms 应远小于串行`)
})

test('在线检查：重定向到私网时逐跳复检，第二跳不发起请求', async () => {
  delete process.env.MO_READER_INSECURE_ALLOW_PRIVATE
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/secret' } })
  }
  try {
    const { fetchText } = await import('../dist/core/net/http.js')
    const { UnsafeUrlError } = await import('../dist/core/net/guard.js')
    await assert.rejects(
      fetchText('http://[2606:4700:4700::1111]/'),
      (error) => error instanceof UnsafeUrlError && /禁止访问本机\/内网地址/.test(error.message),
    )
    // 首跳公网地址发出一次请求；第二跳在发请求前被守卫拦下。
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

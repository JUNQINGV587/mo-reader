import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

function fakeTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => {
      map.set(key, value)
    },
    deleteMany: async (keys) => {
      for (const key of keys) map.delete(key)
    },
    map,
  }
}

function searchHtml(items) {
  return `<!doctype html><html><body>${items
    .map(
      (item) => `<div class="result">
        <h3><a href="${item.bookUrl}">${item.name}</a></h3>
        <span class="author">${item.author}</span>
        <span class="kind">${item.kind || '玄幻'}</span>
        <span class="last">${item.lastChapter || ''}</span>
        <span class="intro">${item.intro || ''}</span>
      </div>`,
    )
    .join('')}</body></html>`
}

const ruleSearch = {
  bookList: 'class.result',
  name: 'h3@a@text',
  bookUrl: 'h3@a@href',
  author: 'class.author@text',
  kind: 'class.kind@text',
  lastChapter: 'class.last@text',
  intro: 'class.intro@text',
}

/** 书源搜索服务：记录被请求过的路径；hold=true 时压住响应，便于验证在途取消真的中断了请求。 */
async function startSearchServer({ items, hold = false }) {
  const hits = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    if (hold) return // 永不响应：只有客户端中止才会结束，等 server.close 收尾。
    const name = url.pathname.split('/')[1]
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(searchHtml(items(name, url.pathname)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, hits }
}

async function createService(origin, count) {
  const { ReaderService } = await import('../dist/server/service.js')
  const service = Object.create(ReaderService.prototype)
  // Object.create 不跑构造函数，取消表要手工补上。
  service.searchCancellations = new Map()
  service.cancelledSearchTokens = new Map()
  service.db = {
    sources: fakeTable(),
    books: fakeTable(),
    chapters: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    settings: { get: () => undefined, set: async () => undefined },
  }
  const sources = Array.from({ length: count }, (_, index) => ({
    bookSourceUrl: `${origin}/s${index}`,
    bookSourceName: `源${index}`,
    enabled: true,
    searchUrl: `${origin}/s${index}/search?q={{key}}`,
    ruleSearch,
  }))
  const imported = await service.importSources({ payload: JSON.stringify(sources) })
  assert.equal(imported.added, count)
  return service
}

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return predicate()
}

test('searchBooks 默认按书名+作者合并，保留来源数，且无 token 时返回结构不变', async () => {
  const { server, origin } = await startSearchServer({
    items: (name, path) => {
      if (path === '/s0/search') return [{ name: '完美世界', author: '辰东', bookUrl: '/s0/book/1' }]
      if (path === '/s1/search') {
        return [
          { name: '完美世界', author: '辰东', bookUrl: '/s1/book/9', intro: '一粒尘可填海' },
          { name: '完美世界', author: '辰东（续写）', bookUrl: '/s1/book/other' },
        ]
      }
      return [{ name: '完美世界', author: '辰东', bookUrl: '/s2/book/3' }]
    },
  })
  const service = await createService(origin, 3)
  try {
    const result = await service.searchBooks({ key: '完美世界' })
    assert.deepEqual(Object.keys(result).sort(), ['books', 'errors'])
    assert.equal(result.errors.length, 0)
    assert.equal(result.books.length, 2, '同书三源合并成一条，不同作者单独一条')
    const merged = result.books.find((book) => book.author === '辰东')
    assert.equal(merged.sourceCount, 3)
    assert.equal(merged.sources.length, 3)
    assert.equal(merged.intro, '一粒尘可填海', '主记录缺失字段由后续来源补齐')
    assert.equal(merged.origin, `${origin}/s0`, '主记录保留首个来源')
  } finally {
    server.close()
  }
})

test('dedupe:false 保留每个来源的候选（换源用）', async () => {
  const { server, origin } = await startSearchServer({
    items: (name, path) => [{ name: '完美世界', author: '辰东', bookUrl: `${path}/book/1` }],
  })
  const service = await createService(origin, 2)
  try {
    const result = await service.searchBooks({ key: '完美世界', dedupe: false })
    assert.equal(result.books.length, 2)
    assert.equal(result.books[0].sourceCount, undefined)
  } finally {
    server.close()
  }
})

test('带 token 的搜索未取消时返回 cancelled:false，并清理取消表', async () => {
  const { server, origin } = await startSearchServer({
    items: (name, path) => [{ name: '完美世界', author: '辰东', bookUrl: `${path}/book/1` }],
  })
  const service = await createService(origin, 2)
  try {
    const result = await service.searchBooks({ key: '完美世界', token: 'token-ok' })
    assert.equal(result.cancelled, false)
    assert.equal(result.books.length, 1)
    assert.equal(service.searchCancellations.size, 0, '作业结束要清理 token，避免泄漏')
    assert.equal(service.cancelledSearchTokens.size, 0)
  } finally {
    server.close()
  }
})

test('取消搜索：未开始的书源不再请求、在途请求中断、结果不再增长', async () => {
  const { server, origin, hits } = await startSearchServer({
    hold: true,
    items: () => [],
  })
  const service = await createService(origin, 10)
  try {
    const token = 'token-cancel'
    const pending = service.searchBooks({ key: '完美世界', token })
    // 并发上限 8：等前 8 个书源都真正发出请求后再取消。
    assert.ok(await waitFor(() => hits.size >= 8), '前 8 个书源应当已开始请求')
    const cancelled = await service.cancelSearch({ token })
    assert.deepEqual(cancelled, { cancelled: true })
    const result = await pending
    assert.equal(result.cancelled, true)
    assert.equal(result.errors.length, 0, '取消导致的中断不算书源错误')
    assert.equal(result.books.length, 0, '结果不应继续增长')
    assert.equal(hits.size, 8, '排队中的 2 个书源不应当被请求')
    assert.equal(service.searchCancellations.size, 0)
    assert.equal(service.cancelledSearchTokens.size, 0)
  } finally {
    server.close()
  }
})

test('取消先于开始：先到的取消标记让搜索直接处于已取消态', async () => {
  const { server, origin, hits } = await startSearchServer({
    items: (name, path) => [{ name: '完美世界', author: '辰东', bookUrl: `${path}/book/1` }],
  })
  const service = await createService(origin, 2)
  try {
    await service.cancelSearch({ token: 'token-early' })
    const result = await service.searchBooks({ key: '完美世界', token: 'token-early' })
    assert.equal(result.cancelled, true)
    assert.equal(hits.size, 0, '取消已生效时不应当再发请求')
    assert.equal(service.cancelledSearchTokens.size, 0)
  } finally {
    server.close()
  }
})

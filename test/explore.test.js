import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

const BASE = 'http://127.0.0.1:9000'

test('探索解析：名称::地址、裸地址、相对地址，忽略空行', async () => {
  const { parseExploreCategories } = await import('../dist/core/source/explore.js')
  const raw = [
    '',
    '玄幻::/explore/xuanhuan',
    'https://other.example/cat',
    '   ',
    '都市::/dushi?page={{page}}',
    '',
  ].join('\n')
  const categories = parseExploreCategories(raw, BASE)
  assert.deepEqual(categories, [
    { name: '玄幻', url: `${BASE}/explore/xuanhuan` },
    { name: 'https://other.example/cat', url: 'https://other.example/cat' },
    { name: '都市', url: `${BASE}/dushi?page={{page}}` },
  ])
})

test('探索解析：单行损坏只跳过该行，不影响其他分类', async () => {
  const { parseExploreCategories } = await import('../dist/core/source/explore.js')
  const raw = ['坏行::http://[::1', '空的::', '好的::/ok'].join('\n')
  assert.deepEqual(parseExploreCategories(raw, BASE), [
    { name: '好的', url: `${BASE}/ok` },
  ])
})

test('探索解析：@js 返回数组（字符串与 {name,url}）', async () => {
  const { parseExploreCategories } = await import('../dist/core/source/explore.js')
  const raw = '@js: [{ name: "玄幻", url: "/x" }, "都市::/d"]'
  assert.deepEqual(parseExploreCategories(raw, BASE), [
    { name: '玄幻', url: `${BASE}/x` },
    { name: '都市', url: `${BASE}/d` },
  ])
})

test('探索解析：@js 返回换行分隔字符串', async () => {
  const { parseExploreCategories } = await import('../dist/core/source/explore.js')
  const raw = '@js:"玄幻::/x\\n都市::/d"'
  assert.deepEqual(parseExploreCategories(raw, BASE), [
    { name: '玄幻', url: `${BASE}/x` },
    { name: '都市', url: `${BASE}/d` },
  ])
})

test('探索解析：@js 抛错或返回空时不产生分类', async () => {
  const { parseExploreCategories } = await import('../dist/core/source/explore.js')
  assert.deepEqual(parseExploreCategories('@js:throw new Error("boom")', BASE), [])
  assert.deepEqual(parseExploreCategories('@js:null', BASE), [])
  assert.deepEqual(parseExploreCategories('', BASE), [])
})

/* ---------- 服务层：发现分类 / 分页 / 书目 ---------- */

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
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

function pageHtml(items) {
  return items
    .map(
      (item) =>
        `<div class="item"><h3><a href="${item.href}">${item.name}</a></h3>` +
        `<span class="author">${item.author}</span><span class="kind">${item.kind}</span>` +
        `<span class="latest">${item.latest}</span><div class="intro">${item.intro}</div>` +
        `<img src="${item.cover}"></div>`,
    )
    .join('')
}

const ITEM_1 = {
  name: '星海旅人',
  href: '/book/1',
  author: '作者甲',
  kind: '科幻',
  latest: '第3章 归途',
  intro: '<p>简介第一段</p><p>第二段</p>',
  cover: '/cover/1.jpg',
}
const ITEM_2 = { ...ITEM_1, name: '荒野之歌', href: '/book/2', author: '作者乙', kind: '都市', latest: '第2章 出发', cover: '/cover/2.jpg' }
const ITEM_3 = { ...ITEM_1, name: '长夜行', href: '/book/3', author: '作者丙', kind: '玄幻', latest: '第1章 启程' }

async function startExploreServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const page = Number(url.searchParams.get('page') ?? '1')
    if (url.pathname === '/b/cat') {
      response.writeHead(500)
      response.end('boom')
      return
    }
    let body = ''
    if (url.pathname === '/cat/xuanhuan') body = page === 1 ? pageHtml([ITEM_1, ITEM_2]) : page === 2 ? pageHtml([ITEM_3]) : ''
    else if (url.pathname === '/cat/dushi') body = page === 1 ? pageHtml([ITEM_2]) : ''
    else {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

function exploreRule() {
  return {
    bookList: 'class.item',
    name: 'h3@a@text',
    author: 'class.author@text',
    kind: 'class.kind@text',
    lastChapter: 'class.latest@text',
    intro: 'class.intro@text',
    coverUrl: 'img@src',
    bookUrl: 'h3@a@href',
  }
}

async function createService(origin) {
  const { ReaderService } = await import('../dist/server/service.js')
  const service = Object.create(ReaderService.prototype)
  let settingsValue = { theme: 'system', fontSize: 24, lineSpacing: 0.5 }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  service.db = { sources: fakeTable(), books: fakeTable(), readRecords: fakeTable(), settings }

  const sources = [
    {
      bookSourceUrl: origin,
      bookSourceName: '甲源',
      enabled: true,
      enabledExplore: true,
      exploreUrl: '玄幻::/cat/xuanhuan?page={{page}}\n都市::/cat/dushi?page={{page}}',
      ruleExplore: exploreRule(),
    },
    {
      bookSourceUrl: `${origin}/b`,
      bookSourceName: '乙源',
      enabled: true,
      enabledExplore: true,
      exploreUrl: '故障::/b/cat?page={{page}}',
      ruleExplore: exploreRule(),
    },
    {
      bookSourceUrl: `${origin}/c`,
      bookSourceName: '停用源',
      enabled: false,
      enabledExplore: true,
      exploreUrl: '甲::/cat/xuanhuan',
      ruleExplore: exploreRule(),
    },
    {
      bookSourceUrl: `${origin}/d`,
      bookSourceName: '未开发现',
      enabled: true,
      enabledExplore: false,
      exploreUrl: '甲::/cat/xuanhuan',
      ruleExplore: exploreRule(),
    },
    {
      bookSourceUrl: `${origin}/e`,
      bookSourceName: '空发现',
      enabled: true,
      enabledExplore: true,
      exploreUrl: '',
      ruleExplore: exploreRule(),
    },
    {
      bookSourceUrl: `${origin}/f`,
      bookSourceName: '解析失败',
      enabled: true,
      enabledExplore: true,
      exploreUrl: '@js:throw new Error("boom")',
      ruleExplore: exploreRule(),
    },
  ]
  const imported = await service.importSources({ payload: JSON.stringify(sources) })
  assert.equal(imported.added, sources.length)
  return service
}

test('发现服务：只列出启用且开启发现且有地址的书源', async (t) => {
  const { server, origin } = await startExploreServer()
  t.after(() => server.close())
  const service = await createService(origin)

  const { sources } = await service.listExploreSources()
  assert.deepEqual(
    sources.map((source) => source.bookSourceName),
    ['甲源', '解析失败', '乙源'],
  )
  const first = sources[0]
  assert.equal(first.bookSourceUrl, origin)
  assert.equal(first.bookSourceGroup, '')
  assert.equal(first.bookSourceType, 0)
})

test('发现服务：分类解析、保留 {{page}}，停用/未开启/空地址给出可读错误', async (t) => {
  const { server, origin } = await startExploreServer()
  t.after(() => server.close())
  const service = await createService(origin)

  const { categories } = await service.getExploreCategories({ sourceUrl: origin })
  assert.deepEqual(categories, [
    { name: '玄幻', url: `${origin}/cat/xuanhuan?page={{page}}` },
    { name: '都市', url: `${origin}/cat/dushi?page={{page}}` },
  ])

  await assert.rejects(() => service.getExploreCategories({ sourceUrl: `${origin}/c` }), /书源已停用/)
  await assert.rejects(() => service.getExploreCategories({ sourceUrl: `${origin}/d` }), /未开启发现/)
  await assert.rejects(() => service.getExploreCategories({ sourceUrl: `${origin}/e` }), /没有发现分类/)
  await assert.rejects(() => service.getExploreCategories({ sourceUrl: `${origin}/f` }), /未解析到发现分类/)
  await assert.rejects(() => service.getExploreCategories({ sourceUrl: `${origin}/missing` }), /书源不存在/)
})

test('发现服务：分页加载、绝对地址、origin 与空页 hasMore=false', async (t) => {
  const { server, origin } = await startExploreServer()
  t.after(() => server.close())
  const service = await createService(origin)

  const first = await service.exploreBooks({
    sourceUrl: origin,
    categoryUrl: `${origin}/cat/xuanhuan?page={{page}}`,
    page: 1,
  })
  assert.equal(first.page, 1)
  assert.equal(first.hasMore, true)
  assert.equal(first.url, `${origin}/cat/xuanhuan?page=1`)
  assert.equal(first.books.length, 2)
  assert.deepEqual(first.books[0], {
    name: '星海旅人',
    author: '作者甲',
    kind: '科幻',
    wordCount: '',
    lastChapter: '第3章 归途',
    intro: '简介第一段第二段',
    coverUrl: `${origin}/cover/1.jpg`,
    bookUrl: `${origin}/book/1`,
    origin,
    originName: '甲源',
    type: 0,
  })

  const second = await service.exploreBooks({
    sourceUrl: origin,
    categoryUrl: `${origin}/cat/xuanhuan?page={{page}}`,
    page: 2,
  })
  assert.equal(second.page, 2)
  assert.equal(second.books.length, 1)
  assert.equal(second.books[0].name, '长夜行')
  assert.equal(second.books[0].bookUrl, `${origin}/book/3`)

  const empty = await service.exploreBooks({
    sourceUrl: origin,
    categoryUrl: `${origin}/cat/xuanhuan?page={{page}}`,
    page: 3,
  })
  assert.equal(empty.page, 3)
  assert.equal(empty.hasMore, false)
  assert.deepEqual(empty.books, [])
})

test('发现服务：单源故障只影响该源', async (t) => {
  const { server, origin } = await startExploreServer()
  t.after(() => server.close())
  const service = await createService(origin)

  const ok = await service.exploreBooks({
    sourceUrl: origin,
    categoryUrl: `${origin}/cat/dushi?page={{page}}`,
    page: 1,
  })
  assert.equal(ok.books.length, 1)
  await assert.rejects(
    () => service.exploreBooks({ sourceUrl: `${origin}/b`, categoryUrl: `${origin}/b/cat?page={{page}}`, page: 1 }),
    /500/,
  )

  const { sources } = await service.listExploreSources()
  assert.deepEqual(sources.map((source) => source.bookSourceName), ['甲源', '解析失败', '乙源'])
})

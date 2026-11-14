import test from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers.js'
import { readFileSync } from 'node:fs'

const CATEGORY_COUNT = 30

function categoryLine(index) {
  const name = `分类${String(index).padStart(2, '0')}`
  const path = index <= 5
    ? `/list/${index}/page/{{page}}.html`
    : `/search/page/{{page}}/wd/${encodeURIComponent(name)}.html`
  return `${name}::${path}`
}

function rssSample() {
  return {
    sourceName: '示例订阅',
    sourceUrl: 'https://rss.example#',
    type: 0,
    articleStyle: 0,
    enabled: true,
    enabledCookieJar: true,
    header: JSON.stringify({ 'User-Agent': 'Legado/3.0', Cookie: '_slide_passed=1' }),
    loginUrl: 'https://rss.example/login',
    injectJs: 'document.body.dataset.injected = "1"',
    sortUrl: Array.from({ length: CATEGORY_COUNT }, (_, index) => categoryLine(index + 1)).join('\n'),
    ruleArticles: '.item',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    ruleContent: '<js>result</js>',
  }
}

const bookSample = {
  bookSourceName: '普通书源',
  bookSourceUrl: 'https://books.example',
  ruleSearch: { bookList: '.book', name: '.name', bookUrl: 'a@href' },
}

test('imports a Legado RSS source with its categories and drops unsupported capabilities', async () => {
  const { service, db } = await serviceFixture()
  const result = await service.importSource({ text: JSON.stringify(rssSample()) })

  assert.equal(result.kind, 'rss')
  assert.equal(result.imported, 0)
  assert.deepEqual(result.names, [])
  assert.equal(result.name, '示例订阅')
  assert.equal(result.categories.length, CATEGORY_COUNT)
  assert.deepEqual(result.categories[0], { name: '分类01', url: 'https://rss.example/list/1/page/{{page}}.html' })
  assert.equal(result.categories.at(-1).name, '分类30')
  assert.deepEqual([...result.unsupported].sort(), ['cookie', 'inject-js', 'login'])

  const sources = [...db.sources.entries()]
  assert.equal(sources.length, 1)
  const source = sources[0][1]
  assert.equal(source.kind, 'rss')
  assert.equal(source.contentType, 'subscription')
  assert.equal(source.bookSourceUrl, 'https://rss.example')
  assert.equal(source.bookSourceName, undefined)
  for (const key of ['header', 'loginUrl', 'injectJs', 'enabledCookieJar']) {
    assert.equal(key in source, false, `落库的订阅源不能包含 ${key}`)
  }
  assert.equal(source.headers['user-agent'], 'Legado/3.0')
  assert.equal('cookie' in source.headers, false)
  // 只落用户声明的头，不把 cleanHeaders 补的默认 Accept 带进媒体请求。
  assert.equal('accept' in source.headers, false)
})

test('credentials in RSS headers are reported as dropped and never stored', async () => {
  const { service } = await serviceFixture()
  const sample = {
    ...rssSample(),
    header: JSON.stringify({ Authorization: 'Bearer secret', 'X-Api-Key': 'key-1' }),
    enabledCookieJar: false,
    loginUrl: '',
    injectJs: '',
  }
  const result = await service.importSource({ text: JSON.stringify(sample) })
  assert.deepEqual([...result.unsupported].sort(), ['credentials'])
  const source = (await service.state()).sources.find((item) => item.id === result.sourceId)
  assert.deepEqual(source.headers, {})
})

test('importing the same RSS source twice keeps one source record', async () => {
  const { service, db } = await serviceFixture()
  const first = await service.importSource({ text: JSON.stringify(rssSample()) })
  const second = await service.importSource({ text: JSON.stringify(rssSample()) })
  assert.equal(second.sourceId, first.sourceId)
  assert.equal(second.categories.length, CATEGORY_COUNT)
  assert.equal(db.sources.size, 1)
})

test('addSubscriptions creates one subscription book per selected category', async () => {
  const { service } = await serviceFixture()
  const imported = await service.importSource({ text: JSON.stringify(rssSample()) })
  const selected = [imported.categories[1].url, imported.categories[6].url]

  const result = await service.addSubscriptions({ sourceId: imported.sourceId, categories: selected })
  assert.equal(result.added, 2)

  const state = await service.state()
  const books = state.books.filter((book) => book.contentType === 'subscription')
  assert.deepEqual(books.map((book) => book.name).sort(), ['分类02', '分类07'])
  const second = books.find((book) => book.name === '分类02')
  assert.equal(typeof second.addedAt, 'string')
  assert.equal(second.subscription.categoryName, '分类02')
  assert.equal(second.subscription.sourceName, '示例订阅')
  assert.equal(second.subscription.sortUrl, 'https://rss.example/list/2/page/{{page}}.html')
  assert.equal(second.subscription.sourceId, imported.sourceId)
  assert.equal(second.bookUrl, 'https://rss.example/list/2/page/1.html')
  assert.equal(second.unread, 0)

  const again = await service.addSubscriptions({ sourceId: imported.sourceId, categories: selected })
  assert.equal(again.added, 0)
  assert.equal(again.updated, 2)
  assert.equal(again.missing.length, 0)
})

test('hourly updates use the subscription toc path instead of the book toc path', async () => {
  let subscriptionTocs = 0
  const { service } = await serviceFixture({
    toc: async () => { throw new Error('subscription books must not use the book toc path') },
    subscriptionToc: async () => { subscriptionTocs += 1; return [] },
  })
  const imported = await service.importSource({ text: JSON.stringify(rssSample()) })
  await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })

  const result = await service.checkUpdates()
  assert.equal(subscriptionTocs, 1)
  assert.equal(result.checked, 1)
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.errors, [])
})


test('an RSS source never overwrites a book source that shares its URL', async () => {
  const { service, db } = await serviceFixture()
  const book = { ...bookSample, bookSourceName: '同域书源', bookSourceUrl: 'https://rss.example' }
  await service.importSource({ text: JSON.stringify(book) })
  await service.importSource({ text: JSON.stringify(rssSample()) })

  assert.equal(db.sources.size, 2)
  assert.deepEqual([...db.sources.entries()].map(([, item]) => item.kind === 'rss').sort(), [false, true])
})

test('an RSS source imported first survives a book source import on the same URL', async () => {
  const { service, db } = await serviceFixture()
  await service.importSource({ text: JSON.stringify(rssSample()) })
  await service.importSource({ text: JSON.stringify({ ...bookSample, bookSourceName: '同域书源', bookSourceUrl: 'https://rss.example' }) })

  assert.equal(db.sources.size, 2)
  assert.deepEqual([...db.sources.entries()].map(([, item]) => item.kind === 'rss').sort(), [false, true])
})

test('category URLs must pass the same URL policy as a source URL', async () => {
  const { service } = await serviceFixture()
  const cases = [
    ['http://rss.example/feed', 'reader/insecure-url'],
    ['https://127.0.0.1/feed', 'reader/ssrf-blocked'],
    ['https://user:pass@rss.example/feed', 'reader/credentials-forbidden'],
    ['https://rss.example/feed?access_token=abc', 'reader/credentials-forbidden'],
  ]
  for (const [url, code] of cases) {
    await assert.rejects(
      service.importSource({ text: JSON.stringify({ ...rssSample(), sortUrl: `测试::${url}` }) }),
      (error) => error.code === code,
      url,
    )
  }
})

test('empty capability fields are not reported as unsupported', async () => {
  const { service } = await serviceFixture()
  const result = await service.importSource({ text: JSON.stringify({
    ...rssSample(),
    enabledCookieJar: false,
    header: { Cookie: '  ' },
    loginUrl: '',
    loginUi: {},
    injectJs: '',
    preloadJs: null,
  }) })
  assert.deepEqual(result.unsupported, [])
})

test('addSubscriptions reports categories that are no longer in the source', async () => {
  const { service } = await serviceFixture()
  const imported = await service.importSource({ text: JSON.stringify(rssSample()) })
  const gone = 'https://rss.example/gone'
  const result = await service.addSubscriptions({ sourceId: imported.sourceId, categories: [gone] })
  assert.equal(result.added, 0)
  assert.equal(result.requested, 1)
  assert.deepEqual(result.missing, [gone])
})


test('every client remote call is declared in REMOTE_METHODS', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const block = client.match(/const REMOTE_METHODS = \[([\s\S]*?)\];/)
  assert.ok(block, 'client.js must declare REMOTE_METHODS')
  const declared = new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]))
  const called = new Set([...client.matchAll(/call\(ctx,\s*'([^']+)'/g)].map(match => match[1]))
  assert.deepEqual([...called].filter(name => !declared.has(name)), [])
})

test('backups keep RSS sources and subscription books across a restore', async () => {
  const { service } = await serviceFixture()
  const imported = await service.importSource({ text: JSON.stringify(rssSample()) })
  await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[2].url] })

  const backup = await service.exportBackup()
  assert.equal(JSON.parse(backup).version, 2)
  const fresh = await serviceFixture()
  const state = await fresh.service.importBackup({ data: backup })
  const source = state.sources.find(item => item.kind === 'rss')
  assert.equal(source.categories.length, CATEGORY_COUNT)
  const book = state.books.find(item => item.contentType === 'subscription')
  assert.equal(book.subscription.sourceName, '示例订阅')
  assert.equal(book.subscription.categoryName, '分类03')
})

test('subscriptions do not offer download jobs before entries exist', async () => {
  const { service } = await serviceFixture()
  const imported = await service.importSource({ text: JSON.stringify(rssSample()) })
  await service.addSubscriptions({ sourceId: imported.sourceId, categories: [imported.categories[0].url] })
  const book = (await service.state()).books.find(item => item.contentType === 'subscription')
  await assert.rejects(service.download({ bookId: book.id }), /订阅还没有条目/)
  await assert.rejects(service.batchDownloadBooks({ bookIds: [book.id] }), /订阅暂不支持下载/)
})

test('an ordinary book source cannot declare itself a subscription', async () => {
  const { service } = await serviceFixture()
  await assert.rejects(
    service.importSource({ text: JSON.stringify({ ...bookSample, contentType: 'subscription' }) }),
    (error) => error.code === 'reader/invalid-source' && /只有订阅源/.test(error.message),
  )
})

test('a source with too many categories is refused', async () => {
  const { service } = await serviceFixture()
  const lines = Array.from({ length: 501 }, (_, index) => `分类${index + 1}::/list/${index + 1}/page/{{page}}.html`).join('\n')
  await assert.rejects(
    service.importSource({ text: JSON.stringify({ ...rssSample(), sortUrl: lines }) }),
    (error) => error.code === 'reader/too-large',
  )
})

test('ordinary book source import keeps its old shape and is not treated as an RSS source', async () => {
  const { service } = await serviceFixture()
  const result = await service.importSource({ text: JSON.stringify(bookSample) })
  assert.equal(result.kind, undefined)
  assert.equal(result.imported, 1)
  assert.deepEqual(result.names, ['普通书源'])

  const state = await service.state()
  const source = state.sources.find((item) => item.name === '普通书源')
  assert.equal(source.contentType, 'novel')
  assert.notEqual(source.kind, 'rss')
})

test('a generic collection source is still refused instead of being mistaken for a subscription', async () => {
  const { service } = await serviceFixture()
  await assert.rejects(
    service.importSource({ text: JSON.stringify({ sourceName: '采集', sourceUrl: 'https://c.example' }) }),
    (error) => error.code === 'reader/unsupported-source' && /采集源/.test(error.message),
  )
})

test('an array import can carry book sources and RSS sources side by side', async () => {
  const { service } = await serviceFixture()
  const result = await service.importSource({ text: JSON.stringify([bookSample, rssSample()]) })
  assert.equal(result.imported, 1)
  assert.equal(result.rss.length, 1)
  assert.equal(result.rss[0].categories.length, CATEGORY_COUNT)
  assert.deepEqual(result.names, ['普通书源'])
  const state = await service.state()
  assert.ok(state.sources.some((source) => source.kind === 'rss'))
  assert.ok(state.sources.some((source) => source.name === '普通书源'))
})

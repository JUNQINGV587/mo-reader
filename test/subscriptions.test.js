import test from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers.js'
import { chapterId, stableId } from '../lib/utils.js'

function librarySource(name, url, rules = {}) {
  return { bookSourceName: name, bookSourceUrl: url, rules }
}

test('unsubscribing removes only the subscription record and keeps imported sources', async () => {
  const { service } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify([librarySource('源甲', 'https://a.example')]) }),
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  const result = await service.removeSubscription({ id: subscribed.subscription.id })
  assert.equal(result.removed, true)
  const state = await service.state()
  assert.equal(state.subscriptions.length, 0)
  assert.ok(state.sources.some(source => source.name === '源甲'), '取消订阅不能删除书源')
})

test('manual refresh atomically adds, updates and removes unowned sources without touching books', async () => {
  let library = [
    librarySource('源甲', 'https://a.example'),
    librarySource('源乙', 'https://b.example'),
  ]
  let fetches = 0
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => {
      fetches += 1
      return { text: JSON.stringify(library), url: 'https://lib.example/sources.json' }
    },
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json', allowHttp: true })
  const [sourceA, sourceB] = subscribed.subscription.sourceIds
  await service.setSourceEnabled({ id: sourceA, enabled: false })

  const bookId = stableId('book', sourceB, 'https://b.example/book')
  const chapter = { id: chapterId(bookId, 'https://b.example/chapter/1'), bookId, index: 0, title: '第一章', url: 'https://b.example/chapter/1', text: '缓存正文' }
  await db.books.put(bookId, { id: bookId, sourceId: sourceB, bookUrl: 'https://b.example/book', name: '乙书', local: false })
  await db.chapters.put(chapter.id, chapter)

  library = [
    librarySource('源甲改', 'https://a.example'),
    librarySource('源丙', 'https://c.example'),
  ]
  const result = await service.refreshSubscription({ id: subscribed.subscription.id })
  assert.equal(fetches, 2)
  assert.deepEqual({ added: result.added, updated: result.updated, removed: result.removed }, { added: 1, updated: 1, removed: 1 })
  const state = await service.state()
  const refreshedA = state.sources.find(item => item.id === sourceA)
  assert.equal(refreshedA.name, '源甲改')
  assert.equal(refreshedA.enabled, false, '刷新必须保留本地停用状态')
  assert.equal(state.sources.some(item => item.id === sourceB), false, '上游删除应移除无人拥有的源')
  assert.equal(state.sources.some(item => item.bookSourceUrl === 'https://c.example'), true)
  assert.deepEqual(state.subscriptions[0].sourceIds.slice().sort(), [sourceA, state.sources.find(item => item.bookSourceUrl === 'https://c.example').id].sort())
  assert.equal(state.subscriptions[0].status, 'ready')
  assert.ok(state.subscriptions[0].lastSuccessAt)

  assert.equal(db.books.get(bookId).name, '乙书', '上游删除不得移除书架书籍')
  assert.equal(db.chapters.get(chapter.id).text, '缓存正文', '已下载章节保留')
  assert.equal((await service.chapter({ bookId, chapterId: chapter.id })).text, '缓存正文')
  assert.throws(() => service.source(sourceB), /书源已不可用/)
})

test('failed refresh keeps the previous source snapshot and records the error', async () => {
  let library = [librarySource('源甲', 'https://a.example')]
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library), url: 'https://lib.example/sources.json' }),
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  const sourceId = subscribed.subscription.sourceIds[0]
  await service.setSourceEnabled({ id: sourceId, enabled: false })
  library = [librarySource('源甲改', 'https://a.example'), { bookSourceName: '坏源', bookSourceUrl: 'http://bad.example' }]
  await assert.rejects(() => service.refreshSubscription({ id: subscribed.subscription.id }), /无效/)
  const state = await service.state()
  const unchanged = state.sources.find(item => item.id === sourceId)
  assert.equal(unchanged.name, '源甲')
  assert.equal(unchanged.enabled, false)
  assert.equal(state.sources.some(item => item.name === '坏源'), false)
  assert.equal(state.subscriptions[0].status, 'error')
  assert.ok(state.subscriptions[0].lastFailureAt)
  assert.match(state.subscriptions[0].lastError, /无效/)
})

test('refreshing an unchanged library does not rewrite sources', async () => {
  const library = [librarySource('源甲', 'https://a.example')]
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library) }),
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  let writes = 0
  const put = db.sources.put.bind(db.sources)
  db.sources.put = async (...args) => { writes += 1; return put(...args) }
  const result = await service.refreshSubscription({ id: subscribed.subscription.id })
  assert.deepEqual({ added: result.added, updated: result.updated, removed: result.removed }, { added: 0, updated: 0, removed: 0 })
  assert.equal(writes, 0, '无变化时不应重写书源')
  assert.equal((await service.state()).subscriptions[0].status, 'ready')
})

test('manual and scheduled refreshes of one subscription share the same in-flight request', async () => {
  const library = [librarySource('源甲', 'https://a.example')]
  let calls = 0
  let release
  const { service } = await serviceFixture({}, {
    fetchRemote: async () => {
      calls += 1
      if (calls === 1) return { text: JSON.stringify(library) }
      return new Promise(resolve => { release = () => resolve({ text: JSON.stringify(library) }) })
    },
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  const first = service.refreshSubscription({ id: subscribed.subscription.id })
  const second = service.refreshSubscriptions()
  for (let attempt = 0; attempt < 100 && !release; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(release, '定时刷新应已发起并等待网络')
  assert.equal(calls, 2, '首次订阅 1 次请求 + 合并后刷新 1 次请求')
  assert.equal((await service.state()).subscriptions[0].checking, true)
  release()
  await Promise.all([first, second])
  assert.equal((await service.state()).subscriptions[0].checking, false)
})

test('a concurrent resubscribe is not overwritten by an older refresh snapshot', async () => {
  let calls = 0
  let release
  const libraryA = [librarySource('源甲', 'https://a.example')]
  const libraryC = [...libraryA, librarySource('源丙', 'https://c.example')]
  const { service } = await serviceFixture({}, {
    fetchRemote: async () => {
      calls += 1
      if (calls === 1) return { text: JSON.stringify(libraryA) }
      if (calls === 2) return new Promise(resolve => { release = () => resolve({ text: JSON.stringify(libraryA) }) })
      return { text: JSON.stringify(libraryC) }
    },
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  const refreshing = service.refreshSubscription({ id: subscribed.subscription.id })
  for (let attempt = 0; attempt < 100 && !release; attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(release, '刷新应已进入等待')
  await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  release()
  await refreshing
  const state = await service.state()
  assert.equal(state.subscriptions[0].sourceIds.length, 2, '刷新不能覆盖并发重新订阅新增的源')
  assert.ok(state.sources.some(item => item.name === '源丙'))
})

test('upstream deletion keeps a source still owned by another subscription', async () => {
  const shared = librarySource('共享源', 'https://shared.example')
  const libraries = {
    'https://lib.example/a.json': [shared],
    'https://lib.example/b.json': [shared, librarySource('乙源', 'https://b.example')],
  }
  const { service } = await serviceFixture({}, {
    fetchRemote: async url => ({ text: JSON.stringify(libraries[url]), url }),
  })
  const first = await service.subscribeSourceLibrary({ url: 'https://lib.example/a.json' })
  const sharedId = first.subscription.sourceIds[0]
  await service.subscribeSourceLibrary({ url: 'https://lib.example/b.json' })
  libraries['https://lib.example/a.json'] = [librarySource('甲源', 'https://a.example')]
  await service.refreshSubscription({ id: first.subscription.id })
  assert.ok(service.source(sharedId), '另一个订阅仍拥有该源，不能删除')
})

test('legacy subscription without allowHttp can still refresh an existing HTTP source', async () => {
  const library = [librarySource('旧 HTTP 源', 'http://legacy.example')]
  let fetchAllowHttp
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async (_url, options) => {
      fetchAllowHttp = options.allowHttp
      return { text: JSON.stringify(library) }
    },
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json', allowHttp: true })
  const legacy = { ...db.subscriptions.get(subscribed.subscription.id) }
  delete legacy.allowHttp
  await db.subscriptions.put(legacy.id, legacy)
  const result = await service.refreshSubscription({ id: legacy.id })
  assert.equal(fetchAllowHttp, true)
  assert.equal(result.updated + result.unchanged, 1)
  assert.equal(db.subscriptions.get(legacy.id).allowHttp, true)
})

test('a write failure rolls the source table back to the previous snapshot', async () => {
  let library = [
    librarySource('源甲', 'https://a.example'),
    librarySource('源乙', 'https://b.example'),
  ]
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => ({ text: JSON.stringify(library) }),
  })
  const subscribed = await service.subscribeSourceLibrary({ url: 'https://lib.example/sources.json' })
  const before = new Map([...db.sources.entries()].map(([id, item]) => [id, structuredClone(item)]))
  library = [
    librarySource('源甲新版', 'https://a.example'),
    librarySource('源丙', 'https://c.example'),
  ]
  let writes = 0
  const put = db.sources.put.bind(db.sources)
  db.sources.put = async (...args) => {
    writes += 1
    if (writes === 2) throw new Error('disk full')
    return put(...args)
  }
  await assert.rejects(() => service.refreshSubscription({ id: subscribed.subscription.id }), /已保留旧版/)
  const state = await service.state()
  assert.deepEqual(new Map(state.sources.filter(item => item.id !== 'local').map(item => [item.id, item.name])), new Map([...before].map(([id, item]) => [id, item.name])))
  assert.equal(state.subscriptions[0].status, 'error')
  assert.match(state.subscriptions[0].lastError, /已保留旧版/)
})

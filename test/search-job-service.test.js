/**
 * 搜索作业服务层测试（#150）：start 立刻拿作业号，轮询快照边搜边出；
 * 同一作业的书目只增不重复，最终与整批 searchBooks 的去重结果一致。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

function fakeTable(records = []) {
  const map = new Map(records.map((record) => [record.id, record]))
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
      for (const key of keys) map.delete(key)
    },
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

/** 书源搜索服务：按路径延迟响应，用来制造「先完成一源、后排队的源陆续完成」的现场。 */
async function startSearchServer({ items, delayFor = () => 0, hold = () => false }) {
  const hits = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    if (hold(url.pathname)) return
    setTimeout(() => {
      if (response.writableEnded || response.destroyed) return
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(searchHtml(items(url.pathname)))
    }, Math.max(0, delayFor(url.pathname)))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, hits }
}

async function createServiceFromDb(db) {
  const { ReaderService } = await import('../dist/server/service.js')
  const service = Object.create(ReaderService.prototype)
  // Object.create 不跑构造函数，搜索取消表与作业协调器位置要手工补上。
  service.searchCancellations = new Map()
  service.cancelledSearchTokens = new Map()
  service.searchJobCoordinator = null
  service.db = db
  return service
}

function newDb() {
  return {
    jobs: fakeTable(),
    sources: fakeTable(),
    books: fakeTable(),
    chapters: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    settings: { get: () => undefined, set: async () => undefined },
  }
}

async function createService(origin, count, { db, baseFor } = {}) {
  const service = await createServiceFromDb(db ?? newDb())
  const sources = Array.from({ length: count }, (_, index) => {
    const base = baseFor ? baseFor(index) : `${origin}/s${index}`
    return {
      bookSourceUrl: base,
      bookSourceName: `源${index}`,
      enabled: true,
      searchUrl: `${base}/search?q={{key}}`,
      ruleSearch,
    }
  })
  const imported = await service.importSources({ payload: JSON.stringify(sources) })
  assert.equal(imported.added, count)
  return service
}

function bookKey(book) {
  return `${String(book?.name ?? '').trim()}\u0000${String(book?.author ?? '').trim()}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForJob(service, jobId, predicate, timeoutMs = 5000) {
  const startedAt = Date.now()
  let snapshot = null
  while (Date.now() - startedAt < timeoutMs) {
    snapshot = await service.getSearchJob({ jobId })
    if (snapshot && predicate(snapshot)) return snapshot
    await sleep(20)
  }
  return snapshot
}

test('搜索作业边搜边出：轮询只增不重复，最终与整批去重一致', async () => {
  const { server, origin } = await startSearchServer({
    items: (path) => {
      if (path === '/s0/search') {
        return [
          { name: '完美世界', author: '辰东', bookUrl: '/s0/book/1' },
          { name: '遮天', author: '辰东', bookUrl: '/s0/book/2' },
        ]
      }
      if (path === '/s1/search') {
        return [
          { name: '完美世界', author: '辰东', bookUrl: '/s1/book/9', intro: '一粒尘可填海' },
          { name: '凡人修仙传', author: '忘语', bookUrl: '/s1/book/3' },
        ]
      }
      return [{ name: '完美世界', author: '辰东', bookUrl: '/s2/book/1' }]
    },
    delayFor: (path) => (path === '/s0/search' ? 0 : path === '/s1/search' ? 150 : 300),
  })
  const service = await createService(origin, 3)
  try {
    const startedAt = Date.now()
    const started = await service.startSearch({ key: '完美世界' })
    assert.equal(typeof started?.jobId, 'string')
    assert.ok(started.jobId, 'startSearch 应返回作业号')
    const jobId = started.jobId

    const seen = new Map()
    let firstBatchAt = 0
    let final = null
    while (Date.now() - startedAt < 5000) {
      const snapshot = await service.getSearchJob({ jobId })
      assert.ok(snapshot, '作业应能按 id 读回')
      assert.equal(snapshot.totalSources, 3)
      assert.equal(snapshot.bookCount, snapshot.books.length, 'bookCount 应等于快照书目数')
      assert.equal(new Set(snapshot.books.map(bookKey)).size, snapshot.books.length, '同一快照内不应重复')
      for (const key of seen.keys()) {
        assert.ok(snapshot.books.some((book) => bookKey(book) === key), '已出现的书目不应从快照消失')
      }
      for (const book of snapshot.books) seen.set(bookKey(book), book)
      if (snapshot.books.length > 0 && !firstBatchAt) firstBatchAt = Date.now()
      if (snapshot.status === 'done') {
        final = snapshot
        break
      }
      await sleep(20)
    }
    assert.ok(final, '作业应在超时前完成')
    assert.ok(firstBatchAt > 0 && firstBatchAt - startedAt < 2000, '首个书源完成后 2 秒内应出现第一批书目')
    assert.equal(final.status, 'done')
    assert.equal(final.cancelled, false)
    assert.equal(final.doneSources, 3, '所有书源都应计入已搜源数')
    assert.equal(final.failures.length, 0)
    assert.equal(final.bookCount, 3)
    assert.equal(seen.size, final.books.length, '轮询期间只增不重复')
    const merged = final.books.find((book) => book.name === '完美世界')
    assert.equal(merged.sourceCount, 3, '三源同书合并成一条')
    assert.equal(merged.intro, '一粒尘可填海', '主记录缺失字段由后续来源补齐')

    const batch = await service.searchBooks({ key: '完美世界' })
    assert.deepEqual(final.books, batch.books, '最终快照应与整批去重结果一致')
  } finally {
    await service.searchJobCoordinator?.shutdown?.()
    server.close()
  }
})
async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

test('失败源单列失败项，其余源继续完成', async () => {
  const deadBase = 'http://127.0.0.1:1/s1'
  const { server, origin } = await startSearchServer({
    items: (path) =>
      path === '/s0/search'
        ? [{ name: '完美世界', author: '辰东', bookUrl: '/s0/book/1' }]
        : [{ name: '遮天', author: '辰东', bookUrl: '/s2/book/2' }],
    delayFor: (path) => (path === '/s2/search' ? 200 : 0),
  })
  const service = await createService(origin, 3, {
    baseFor: (index) => (index === 1 ? deadBase : `${origin}/s${index}`),
  })
  try {
    const { jobId } = await service.startSearch({ key: '完美世界' })
    const progress = []
    const final = await waitForJob(service, jobId, (snapshot) => {
      progress.push({ doneSources: snapshot.doneSources, status: snapshot.status })
      return snapshot.status === 'done'
    })
    assert.ok(final, '作业应在超时前完成')
    assert.equal(final.status, 'done')
    assert.equal(final.doneSources, 3, '失败源也计入已搜源数')
    assert.equal(final.bookCount, 2)
    assert.deepEqual(final.books.map((book) => book.name).sort(), ['完美世界', '遮天'].sort())
    assert.equal(final.failures.length, 1)
    assert.equal(final.failures[0].sourceName, '源1')
    assert.equal(final.failures[0].bookSourceUrl, deadBase)
    assert.ok(final.failures[0].error, '失败项应带错误文案')
    for (let index = 1; index < progress.length; index += 1) {
      assert.ok(progress[index].doneSources >= progress[index - 1].doneSources, '已搜源数不应回退')
    }
    assert.ok(
      progress.some((item) => item.status === 'running' && item.doneSources > 0 && item.doneSources < 3),
      '轮询期间应能看到部分源完成的中间快照',
    )
  } finally {
    await service.searchJobCoordinator?.shutdown?.()
    await closeServer(server)
  }
})

test('取消搜索保留已得书目，并中断在途请求', async () => {
  const { server, origin } = await startSearchServer({
    items: () => [{ name: '完美世界', author: '辰东', bookUrl: '/s0/book/1' }],
    hold: (path) => path !== '/s0/search',
  })
  const service = await createService(origin, 3)
  try {
    const { jobId } = await service.startSearch({ key: '完美世界' })
    const running = await waitForJob(service, jobId, (snapshot) => snapshot.doneSources >= 1 && snapshot.bookCount >= 1)
    assert.equal(running.status, 'running')
    const cancelStartedAt = Date.now()
    const cancelled = await service.cancelSearchJob({ jobId })
    assert.ok(Date.now() - cancelStartedAt < 2000, '取消应尽快中断在途请求')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.cancelled, true)
    assert.equal(cancelled.stageText, '已取消搜索')
    assert.equal(cancelled.doneSources, 1)
    assert.equal(cancelled.bookCount, 1)
    assert.equal(cancelled.books.length, 1)
    assert.equal(cancelled.books[0].name, '完美世界')
    assert.equal(cancelled.failures.length, 0, '中断不应记成失败源')
    const again = await service.getSearchJob({ jobId })
    assert.equal(again.status, 'cancelled')
    assert.equal(again.bookCount, 1)
  } finally {
    await service.searchJobCoordinator?.shutdown?.()
    await closeServer(server)
  }
})

test('取消后不再启动未开始的书源', async () => {
  const { server, origin, hits } = await startSearchServer({
    items: () => [{ name: '书', author: '作者', bookUrl: '/b/1' }],
    hold: () => true,
  })
  const service = await createService(origin, 10)
  try {
    const startedAt = Date.now()
    const { jobId } = await service.startSearch({ key: '书' })
    while (hits.size < 8 && Date.now() - startedAt < 2000) await sleep(10)
    assert.equal(hits.size, 8, '作业内部应保持 8 个在途请求')
    const cancelled = await service.cancelSearchJob({ jobId })
    assert.equal(cancelled.status, 'cancelled')
    assert.ok(Date.now() - startedAt < 3000, '取消应中断 8 个在途请求')
    await sleep(100)
    assert.equal(hits.has('/s8/search'), false, '取消后不再启动未开始的书源')
    assert.equal(hits.has('/s9/search'), false)
    assert.equal(hits.size, 8)
    assert.equal(cancelled.doneSources, 0)
    assert.equal(cancelled.bookCount, 0)
  } finally {
    await service.searchJobCoordinator?.shutdown?.()
    await closeServer(server)
  }
})

test('关页重开按作业号从持久化记录接回结果', async () => {
  const { server, origin } = await startSearchServer({
    items: () => [{ name: '完美世界', author: '辰东', bookUrl: '/s0/book/1' }],
  })
  const db = newDb()
  try {
    const first = await createService(origin, 1, { db })
    const { jobId } = await first.startSearch({ key: '完美世界' })
    const done = await waitForJob(first, jobId, (snapshot) => snapshot.status === 'done')
    assert.equal(done.status, 'done')
    await first.searchJobCoordinator.shutdown()

    const reopened = await createServiceFromDb(db)
    const restored = await reopened.getSearchJob({ jobId })
    assert.ok(restored, '重开页面后应能按作业号读回快照')
    assert.equal(restored.jobId, jobId)
    assert.equal(restored.status, 'done')
    assert.equal(restored.key, '完美世界')
    assert.equal(restored.bookCount, 1)
    assert.equal(restored.books[0].name, '完美世界')
    assert.equal(restored.doneSources, 1)

    // 下一次搜索会清掉上一份终态快照，避免作业表无限增长。
    const { jobId: nextJobId } = await reopened.startSearch({ key: '遮天' })
    assert.notEqual(nextJobId, jobId)
    assert.equal(await db.jobs.get(jobId), undefined, '下一次搜索应清掉上一次终态快照')
    assert.equal(await reopened.getSearchJob({ jobId }), null)
    await waitForJob(reopened, nextJobId, (snapshot) => snapshot.status === 'done')
  } finally {
    await closeServer(server)
  }
})

test('服务重启后残留进行中作业显示已中断，过期快照被清理', async () => {
  const { recoverInterruptedSearchJobs, cleanupExpiredSearchJobs } = await import('../dist/server/search-job.js')
  const db = newDb()
  const now = Date.now()
  const seeded = {
    id: 'search-running-seeded',
    kind: 'search',
    status: 'running',
    stage: 'searching',
    stageText: '搜索中',
    key: '完美世界',
    scope: null,
    doneSources: 1,
    totalSources: 2,
    bookCount: 1,
    books: [{ name: '完美世界', author: '辰东', sources: [], sourceCount: 1 }],
    failures: [],
    cancelled: false,
    error: '',
    createdAt: now - 1000,
    updatedAt: now - 1000,
  }
  await db.jobs.put(seeded.id, seeded)
  assert.equal(await recoverInterruptedSearchJobs(db.jobs, now), 1)
  const recovered = db.jobs.get(seeded.id)
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.stageText, '已中断')
  assert.match(recovered.error, /服务重启/)
  assert.equal(recovered.cancelled, false)
  assert.equal(recovered.bookCount, 1, '中断后保留已得书目')
  assert.equal(recovered.books[0].name, '完美世界')

  const oldDone = { ...seeded, id: 'search-old-done', status: 'done', stageText: '搜索完成', updatedAt: now - 25 * 60 * 60 * 1000 }
  const freshDone = { ...seeded, id: 'search-fresh-done', status: 'done', stageText: '搜索完成', updatedAt: now - 60 * 1000 }
  const oldRunning = { ...seeded, id: 'search-old-running', status: 'running', updatedAt: now - 25 * 60 * 60 * 1000 }
  const otherKind = { ...seeded, id: 'download-old', kind: 'download', status: 'done', updatedAt: now - 25 * 60 * 60 * 1000 }
  await db.jobs.put(oldDone.id, oldDone)
  await db.jobs.put(freshDone.id, freshDone)
  await db.jobs.put(oldRunning.id, oldRunning)
  await db.jobs.put(otherKind.id, otherKind)
  const cleaned = await cleanupExpiredSearchJobs(db.jobs, now)
  assert.equal(cleaned, 1, '只清理过期的终态搜索作业')
  assert.equal(db.jobs.get(oldDone.id), undefined)
  assert.ok(db.jobs.get(freshDone.id))
  assert.ok(db.jobs.get(oldRunning.id), '进行中的作业不按时长清理')
  assert.ok(db.jobs.get(otherKind.id), '不碰其他类型的作业')
})
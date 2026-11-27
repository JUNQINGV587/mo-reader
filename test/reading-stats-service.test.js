import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 阅读统计（#129）的服务端测试：直接调服务对象，用假数据表，不联网、不起端口。
 * 覆盖统计落库、进度保存不抹统计、聚合、清空统计与删书墓碑。
 * 前置：npm run build:server（测试 import 的是 dist/server/service.js）。
 */

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const books = fakeTable()
  const readRecords = fakeTable()
  const bookmarks = fakeTable()
  const db = {
    books,
    readRecords,
    bookmarks,
    chapters: fakeTable(),
    sources: fakeTable(),
    notes: fakeTable(),
    jobs: fakeTable(),
    downloadEntries: fakeTable(),
    mediaEntries: fakeTable(),
    subscriptions: fakeTable(),
    settings: { get: () => ({}), set: async () => undefined },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  // 缓存清理另有专测；这里只关心 read_records 的去留。
  service.purgeBookCaches = async () => ({ text: { removed: 0, bytes: 0 }, media: { removed: 0, bytes: 0 } })
  return { service, books, readRecords, bookmarks }
}

test('saveReadingTime 建记录并累加，进度字段不动', async () => {
  const { service, readRecords } = await makeService()
  await readRecords.put('b1', { id: 'b1', bookId: 'b1', chapterIndex: 3, chapterTitle: '第4章', position: 9 })
  const at = new Date(2026, 0, 15, 12, 0, 0)
  await service.saveReadingTime({ bookId: 'b1', daily: { '2026-01-15': 5000 }, at: at.toISOString() })
  await service.saveReadingTime({ bookId: 'b1', daily: { '2026-01-15': 3000 }, at: at.toISOString() })
  const record = readRecords.get('b1')
  assert.equal(record.readMs, 8000)
  assert.equal(record.dailyMs['2026-01-15'], 8000)
  assert.equal(record.chapterIndex, 3)
  assert.equal(record.chapterTitle, '第4章')
  assert.equal(record.position, 9)
  assert.equal(record.updatedAt, at.toISOString())
})

test('saveReadingTime 忽略非法日期与非法时长', async () => {
  const { service, readRecords } = await makeService()
  await service.saveReadingTime({ bookId: 'b1', daily: { 'not-a-date': 5000, '2026-01-15': -3, '2026-01-16': 'x' } })
  const record = readRecords.get('b1')
  assert.equal(record.readMs, 0)
  assert.deepEqual(record.dailyMs, {})
})

test('saveProgress 保留统计字段并清掉已删除标记', async () => {
  const { service, books, readRecords } = await makeService()
  await books.put('b1', { id: 'b1', name: '书' })
  await readRecords.put('b1', {
    id: 'b1',
    bookId: 'b1',
    readMs: 60_000,
    dailyMs: { '2026-01-01': 60_000 },
    archiveMs: { '2024-03': 1 },
    deleted: true,
  })
  await service.saveProgress({ bookId: 'b1', chapterIndex: 2, chapterTitle: '第3章', position: 5 })
  const record = readRecords.get('b1')
  assert.equal(record.readMs, 60_000)
  assert.equal(record.dailyMs['2026-01-01'], 60_000)
  assert.equal(record.archiveMs['2024-03'], 1)
  assert.equal(record.deleted, undefined)
  assert.equal(record.chapterTitle, '第3章')
})

test('getReadingStats 聚合书与墓碑，今日时长按本地日期', async () => {
  const { service, books, readRecords } = await makeService()
  await books.put('b1', { id: 'b1', name: '在架书', totalChapterNum: 10 })
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await readRecords.put('b1', {
    id: 'b1',
    bookId: 'b1',
    readMs: 60_000,
    dailyMs: { [key]: 60_000 },
    chapterIndex: 4,
    chapterTitle: '第5章',
    updatedAt: today.toISOString(),
  })
  await readRecords.put('gone', {
    id: 'gone',
    bookId: 'gone',
    bookName: '已删的书',
    readMs: 30_000,
    dailyMs: {},
    deleted: true,
  })
  const stats = await service.getReadingStats()
  assert.equal(stats.totalMs, 90_000)
  assert.equal(stats.todayMs, 60_000)
  assert.equal(stats.books[0].bookId, 'b1')
  assert.equal(stats.books[0].deleted, false)
  assert.equal(stats.books[1].bookId, 'gone')
  assert.equal(stats.books[1].deleted, true)
  assert.equal(stats.books[1].name, '已删的书')
})

test('clearReadingStats 只清统计，保留进度与书签，纯墓碑删除', async () => {
  const { service, readRecords, bookmarks } = await makeService()
  await readRecords.put('b1', {
    id: 'b1',
    bookId: 'b1',
    readMs: 60_000,
    dailyMs: { '2026-01-01': 60_000 },
    archiveMs: { '2024-03': 1000 },
    chapterIndex: 3,
    chapterTitle: '第4章',
  })
  await readRecords.put('gone', { id: 'gone', bookId: 'gone', readMs: 5000, dailyMs: {}, deleted: true })
  await bookmarks.put('bm1', { id: 'bm1', bookId: 'b1', chapterIndex: 1 })
  const result = await service.clearReadingStats()
  assert.equal(result.cleared, 2)
  const kept = readRecords.get('b1')
  assert.equal(kept.readMs, 0)
  assert.deepEqual(kept.dailyMs, {})
  assert.deepEqual(kept.archiveMs, {})
  assert.equal(kept.chapterTitle, '第4章')
  assert.equal(readRecords.map.has('gone'), false)
  assert.equal(bookmarks.map.size, 1)
  const stats = await service.getReadingStats()
  assert.equal(stats.totalMs, 0)
  assert.equal(stats.todayMs, 0)
})

test('删书时有统计写墓碑保留进度，没有统计照旧删除', async () => {
  const { service, books, readRecords } = await makeService()
  await books.put('b1', { id: 'b1', name: '要删的书' })
  await books.put('b2', { id: 'b2', name: '没统计的书' })
  await readRecords.put('b1', {
    id: 'b1',
    bookId: 'b1',
    readMs: 120_000,
    dailyMs: { '2026-01-01': 120_000 },
    chapterIndex: 2,
    chapterTitle: '第3章',
  })
  await readRecords.put('b2', { id: 'b2', bookId: 'b2', chapterIndex: 1 })
  const result = await service.removeBooks({ ids: ['b1', 'b2'] })
  assert.equal(result.deleted, 2)
  const tomb = readRecords.get('b1')
  assert.equal(tomb.deleted, true)
  assert.equal(tomb.bookName, '要删的书')
  assert.equal(tomb.readMs, 120_000)
  assert.equal(tomb.chapterTitle, '第3章')
  assert.equal(readRecords.map.has('b2'), false)
  const stats = await service.getReadingStats()
  assert.equal(stats.books.length, 1)
  assert.equal(stats.books[0].deleted, true)
  assert.equal(stats.books[0].name, '要删的书')
})

test('清空统计不会动书的进度与最后阅读', async () => {
  const { service, books, readRecords } = await makeService()
  await books.put('b1', { id: 'b1', name: '书' })
  await readRecords.put('b1', {
    id: 'b1',
    bookId: 'b1',
    readMs: 60_000,
    dailyMs: { '2026-01-01': 60_000 },
    chapterIndex: 3,
    position: 8,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  await service.clearReadingStats()
  const record = readRecords.get('b1')
  assert.equal(record.chapterIndex, 3)
  assert.equal(record.position, 8)
  assert.equal(record.updatedAt, '2026-01-01T00:00:00.000Z')
})

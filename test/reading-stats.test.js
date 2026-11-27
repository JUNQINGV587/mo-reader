import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 阅读统计（#129）的纯函数与计时器：日桶、400 天归档、聚合、12 小时会话上限。
 * 前置：npm run build:server（测试 import 的是 dist/core/reader/stats.js）。
 */

const {
  DAY_MS,
  DAILY_RETENTION_DAYS,
  SESSION_CAP_MS,
  FLUSH_INTERVAL_MS,
  addReadingTime,
  aggregateReadingStats,
  formatReadingDuration,
  localDateKey,
  normalizeReadingTime,
  shouldCountReading,
  ReadingTimer,
} = await import('../dist/core/reader/stats.js')

function localNoon(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0)
}

test('旧记录缺统计字段按 0，非法值忽略，未知字段不受影响', () => {
  const stats = normalizeReadingTime({ id: 'b1', chapterIndex: 3, readMs: 'x', dailyMs: [] })
  assert.equal(stats.readMs, 0)
  assert.deepEqual(stats.dailyMs, {})
  assert.deepEqual(stats.archiveMs, {})
  assert.equal(stats.updatedAt, '')
})

test('只有日桶没有总量时按日桶之和补齐，已有总量取较大值', () => {
  assert.equal(normalizeReadingTime({ dailyMs: { '2026-01-01': 60_000 } }).readMs, 60_000)
  assert.equal(normalizeReadingTime({ readMs: 1000, dailyMs: { '2026-01-01': 60_000 } }).readMs, 60_000)
})

test('累加阅读时长写进本地日期桶，并更新时间', () => {
  const now = localNoon(2026, 1, 15)
  const next = addReadingTime({ readMs: 1000, dailyMs: { '2026-01-14': 1000 } }, { '2026-01-15': 5000 }, now)
  assert.equal(next.readMs, 6000)
  assert.equal(next.dailyMs['2026-01-14'], 1000)
  assert.equal(next.dailyMs['2026-01-15'], 5000)
  assert.equal(next.updatedAt, now.toISOString())
})

test('超过 400 天的日桶按月份并入 archiveMs，总时长不变', () => {
  const now = localNoon(2026, 6, 1)
  const old = localDateKey(localNoon(2024, 3, 7))
  const recent = localDateKey(localNoon(2026, 5, 30))
  const next = addReadingTime({}, { [old]: 120_000, [recent]: 60_000 }, now)
  assert.equal(next.dailyMs[old], undefined)
  assert.equal(next.dailyMs[recent], 60_000)
  assert.equal(next.archiveMs['2024-03'], 120_000)
  assert.equal(next.readMs, 180_000)
})

test('400 天整仍在日桶里，只有更老才归档', () => {
  const now = localNoon(2026, 6, 1)
  const kept = localDateKey(new Date(now.getTime() - (DAILY_RETENTION_DAYS - 1) * DAY_MS))
  const folded = localDateKey(new Date(now.getTime() - DAILY_RETENTION_DAYS * DAY_MS))
  const next = addReadingTime({}, { [kept]: 1000, [folded]: 2000 }, now)
  assert.equal(next.dailyMs[kept], 1000)
  assert.equal(next.dailyMs[folded], undefined)
  assert.equal(next.archiveMs[folded.slice(0, 7)], 2000)
})

test('空记录聚合全为 0，近 7 天固定 7 个日期桶', () => {
  const stats = aggregateReadingStats([], [], { now: localNoon(2026, 1, 15) })
  assert.equal(stats.totalMs, 0)
  assert.equal(stats.todayMs, 0)
  assert.equal(stats.last30Ms, 0)
  assert.equal(stats.last7Days.length, 7)
  assert.equal(stats.last7Days[6].date, '2026-01-15')
  assert.equal(stats.last7Days[6].ms, 0)
  assert.equal(stats.heat.length, 365)
  assert.equal(stats.heat[0].date, '2025-01-16')
  assert.equal(stats.heat[364].date, '2026-01-15')
  assert.ok(stats.heat.every((day) => day.ms === 0))
  assert.deepEqual(stats.books, [])
})

test('单本聚合：今日、累计、近 7 天、近 30 天与排行都由记录算出', () => {
  const now = localNoon(2026, 1, 15)
  const records = [
    {
      id: 'b1',
      bookId: 'b1',
      readMs: 90_000,
      dailyMs: { '2026-01-15': 60_000, '2026-01-14': 30_000 },
      chapterIndex: 4,
      chapterTitle: '第5章',
      updatedAt: localNoon(2026, 1, 15).toISOString(),
    },
  ]
  const books = [
    { id: 'b1', name: '测试书', totalChapterNum: 10, lastReadAt: 0 },
  ]
  const stats = aggregateReadingStats(records, books, { now })
  assert.equal(stats.todayMs, 60_000)
  assert.equal(stats.totalMs, 90_000)
  assert.equal(stats.last30Ms, 90_000)
  assert.equal(stats.last7Days[5].date, '2026-01-14')
  assert.equal(stats.last7Days[5].ms, 30_000)
  assert.equal(stats.books.length, 1)
  assert.equal(stats.books[0].name, '测试书')
  assert.equal(stats.books[0].readMs, 90_000)
  assert.equal(stats.books[0].deleted, false)
  assert.equal(stats.books[0].chapterTitle, '第5章')
  assert.equal(stats.books[0].percent, 50)
  assert.equal(stats.heat[364].date, '2026-01-15')
  assert.equal(stats.heat[364].ms, 60_000)
  assert.equal(stats.heat[363].date, '2026-01-14')
  assert.equal(stats.heat[363].ms, 30_000)
  assert.equal(stats.heat.find((day) => day.date === '2026-01-01').ms, 0)
})

test('热力数组固定 365 项、按日期升序，跨 400 天归档后仍覆盖 365 天', () => {
  const now = localNoon(2026, 6, 1)
  const record = addReadingTime({ readMs: 0, dailyMs: { '2024-03-07': 120_000 } }, {}, now)
  assert.equal(record.dailyMs['2024-03-07'], undefined)
  assert.equal(record.archiveMs['2024-03'], 120_000)
  const stats = aggregateReadingStats(
    [{ id: 'b1', bookId: 'b1', ...record }],
    [{ id: 'b1', name: '书' }],
    { now },
  )
  assert.equal(stats.totalMs, 120_000)
  assert.equal(stats.heat.length, 365)
  assert.equal(stats.heat[364].date, '2026-06-01')
  for (let index = 1; index < stats.heat.length; index += 1) {
    assert.ok(stats.heat[index].date > stats.heat[index - 1].date)
  }
  assert.ok(stats.heat.every((day) => day.ms === 0))
})

test('已删除书保留在排行里并标注，名字取墓碑', () => {
  const now = localNoon(2026, 1, 15)
  const stats = aggregateReadingStats(
    [
      { id: 'gone', bookId: 'gone', bookName: '删掉的书', readMs: 5000, dailyMs: {}, deleted: true },
    ],
    [],
    { now },
  )
  assert.equal(stats.totalMs, 5000)
  assert.equal(stats.books.length, 1)
  assert.equal(stats.books[0].name, '删掉的书')
  assert.equal(stats.books[0].deleted, true)
})

test('排行按总时长从多到少，已删除书在同一榜里', () => {
  const now = localNoon(2026, 1, 15)
  const stats = aggregateReadingStats(
    [
      { id: 'a', bookId: 'a', readMs: 1000, dailyMs: {} },
      { id: 'b', bookId: 'b', readMs: 3000, dailyMs: {} },
      { id: 'c', bookId: 'c', readMs: 2000, dailyMs: {}, deleted: true, bookName: '旧书' },
    ],
    [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    { now },
  )
  assert.deepEqual(stats.books.map((item) => item.bookId), ['b', 'c', 'a'])
})

test('时长文案：不足 1 分、整分、小时与分', () => {
  assert.equal(formatReadingDuration(0), '0 分')
  assert.equal(formatReadingDuration(45_000), '<1 分')
  assert.equal(formatReadingDuration(90_000), '1 分')
  assert.equal(formatReadingDuration(3_900_000), '1 小时 5 分')
  assert.equal(formatReadingDuration(3_600_000), '1 小时')
})

test('计时器按 1 秒累加、每 5 秒落盘一次', () => {
  let now = localNoon(2026, 1, 15)
  const flushes = []
  const timer = new ReadingTimer({
    now: () => now.getTime(),
    flush: (payload) => flushes.push(payload),
    autoTick: false,
  })
  timer.setBook('b1')
  timer.setActive(true)
  for (let i = 0; i < 4; i += 1) {
    now = new Date(now.getTime() + 1000)
    timer.tick()
  }
  assert.equal(flushes.length, 0)
  now = new Date(now.getTime() + 1000)
  timer.tick()
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].bookId, 'b1')
  assert.equal(flushes[0].daily['2026-01-15'], FLUSH_INTERVAL_MS)
})

test('换书立即落盘，新书从零开始；停止计时也立即落盘', () => {
  let now = localNoon(2026, 1, 15)
  const flushes = []
  const timer = new ReadingTimer({ now: () => now.getTime(), flush: (payload) => flushes.push(payload), autoTick: false })
  timer.setBook('b1')
  timer.setActive(true)
  now = new Date(now.getTime() + 2000)
  timer.tick(2000)
  timer.setBook('b2')
  assert.deepEqual(flushes.map((item) => item.bookId), ['b1'])
  assert.equal(flushes[0].daily['2026-01-15'], 2000)
  timer.setActive(false)
  assert.equal(flushes.length, 1)
  timer.setBook('b2')
  timer.setActive(true)
  now = new Date(now.getTime() + 1000)
  timer.tick()
  timer.flush()
  assert.equal(flushes[1].bookId, 'b2')
  assert.equal(flushes[1].daily['2026-01-15'], 1000)
})

test('跨午夜按本地日期分桶', () => {
  let now = new Date(2026, 0, 15, 23, 59, 58)
  const flushes = []
  const timer = new ReadingTimer({ now: () => now.getTime(), flush: (payload) => flushes.push(payload), autoTick: false })
  timer.setBook('b1')
  timer.setActive(true)
  now = new Date(now.getTime() + 1000)
  timer.tick()
  now = new Date(now.getTime() + 1000)
  timer.tick()
  now = new Date(now.getTime() + 1000)
  timer.tick()
  timer.flush()
  assert.equal(flushes.length, 1)
  assert.equal(flushes[0].daily['2026-01-15'], 2000)
  assert.equal(flushes[0].daily['2026-01-16'], 1000)
})

test('单次会话 12 小时封顶，离开后重新开始计时', () => {
  let now = localNoon(2026, 1, 15)
  const flushes = []
  const timer = new ReadingTimer({ now: () => now.getTime(), flush: (payload) => flushes.push(payload), autoTick: false })
  timer.setBook('b1')
  timer.setActive(true)
  now = new Date(now.getTime() + SESSION_CAP_MS + 60_000)
  timer.tick(SESSION_CAP_MS + 60_000)
  timer.flush()
  const total = Object.values(flushes[0].daily).reduce((sum, value) => sum + value, 0)
  assert.equal(total, SESSION_CAP_MS)
  assert.equal(timer.capped, true)
  timer.tick(1000)
  timer.flush()
  assert.equal(flushes.length, 1)
  timer.setActive(false)
  timer.setBook('b1')
  timer.setActive(true)
  now = localNoon(2026, 1, 15)
  now = new Date(now.getTime() + 1000)
  timer.tick()
  timer.flush()
  assert.equal(flushes.length, 2)
  assert.equal(flushes[1].daily['2026-01-15'], 1000)
})

test('没有书或没在计时时不累加也不落盘', () => {
  const noBook = []
  const idle = new ReadingTimer({ flush: (payload) => noBook.push(payload), autoTick: false })
  idle.setActive(true)
  idle.tick(1000)
  idle.flush()
  assert.equal(noBook.length, 0)

  const idleBook = []
  const timer = new ReadingTimer({ flush: (payload) => idleBook.push(payload), autoTick: false })
  timer.setBook('b1')
  timer.tick(1000)
  timer.flush()
  assert.equal(idleBook.length, 0)
})

test('localDateKey 用本地日期而不是 UTC', () => {
  const late = new Date(2026, 0, 15, 23, 30, 0)
  assert.equal(localDateKey(late), '2026-01-15')
})

test('阅读页、可见、聚焦、有书同时成立才计时', () => {
  const base = { readingPage: true, bookId: 'b1', hidden: false, focused: true }
  assert.equal(shouldCountReading(base), true)
  assert.equal(shouldCountReading({ ...base, readingPage: false }), false)
  assert.equal(shouldCountReading({ ...base, bookId: '' }), false)
  assert.equal(shouldCountReading({ ...base, hidden: true }), false)
  assert.equal(shouldCountReading({ ...base, focused: false }), false)
})

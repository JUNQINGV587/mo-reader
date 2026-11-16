import assert from 'node:assert/strict'
import test from 'node:test'

test('模拟阅读：按起始章节 + 每日章节数 + 起始日期解锁', async () => {
  const { simulatedChapterCount, daysPassed } = await import('../dist/core/reader/simulate.js')
  const book = {
    simulateEnabled: true,
    simulateStartDate: '2026-11-16',
    simulateStartChapter: 10,
    simulateDailyChapters: 3,
    totalChapterNum: 100,
  }
  const day0 = new Date(2026, 10, 16)
  assert.equal(daysPassed(day0, day0), 1)
  assert.equal(simulatedChapterCount(book, day0), 13)
  const day1 = new Date(2026, 10, 17)
  assert.equal(simulatedChapterCount(book, day1), 16)
  const far = new Date(2026, 11, 31)
  assert.equal(simulatedChapterCount(book, far), 100)
})

test('模拟阅读：关闭时返回真实章节总数', async () => {
  const { simulatedChapterCount } = await import('../dist/core/reader/simulate.js')
  assert.equal(simulatedChapterCount({ totalChapterNum: 42 }, new Date(2026, 10, 16)), 42)
})

test('模拟阅读：进度比例以模拟章节数为分母', async () => {
  const { simulatedProgress } = await import('../dist/core/reader/simulate.js')
  const book = {
    simulateEnabled: true,
    simulateStartDate: '2026-11-16',
    simulateStartChapter: 0,
    simulateDailyChapters: 2,
    totalChapterNum: 100,
  }
  const today = new Date(2026, 10, 16)
  // 第 1 天解锁 2 章；读到第 2 章（index 1）时进度 = 1 / (2 - 1) = 1
  assert.equal(simulatedProgress(book, 1, today), 1)
  // index 0 → 0
  assert.equal(simulatedProgress(book, 0, today), 0)
})

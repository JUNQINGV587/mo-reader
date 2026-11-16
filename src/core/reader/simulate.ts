/**
 * 模拟阅读：按「起始章节 + 每日章节数 + 起始日期」计算当前应解锁到的章节数。
 * 对齐阅读 Book.simulatedTotalChapterNum()：
 *   chapters = min(totalChapterNum, startChapter + daysPassed * dailyChapters)
 * 其中 daysPassed = 起止日期之间的天数 + 1。
 */

export interface SimulateBook {
  simulateEnabled?: boolean
  simulateStartDate?: string
  simulateStartChapter?: number
  simulateDailyChapters?: number
  totalChapterNum?: number
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? null : date
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** 起止日期之间包含首尾的天数；start 在 today 之后时按 1 天算。 */
export function daysPassed(start: Date, today: Date): number {
  const from = startOfDay(start).getTime()
  const to = startOfDay(today).getTime()
  const diff = Math.floor((to - from) / 86_400_000) + 1
  return Math.max(1, diff)
}

export function simulatedChapterCount(book: SimulateBook, today = new Date()): number {
  const total = Math.max(0, Math.trunc(book.totalChapterNum ?? 0))
  if (!book.simulateEnabled) return total
  const start = parseDate(book.simulateStartDate) ?? today
  const days = daysPassed(start, today)
  const daily = Math.max(1, Math.trunc(book.simulateDailyChapters ?? 3))
  const startChapter = Math.max(0, Math.trunc(book.simulateStartChapter ?? 0))
  const unlocked = startChapter + days * daily
  return Math.min(total, unlocked)
}

/** 进度比例：用模拟章节数做分母；0 章返回 0。 */
export function simulatedProgress(
  book: SimulateBook,
  durChapterIndex: number,
  today = new Date(),
): number {
  const count = simulatedChapterCount(book, today)
  if (count <= 0) return 0
  if (count === 1) return 1
  return Math.min(1, Math.max(0, durChapterIndex / (count - 1)))
}

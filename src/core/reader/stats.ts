/**
 * 阅读统计：把阅读页的计时落成日桶，聚合成「我的」页要的今日 / 近 7 天 / 近 30 天 / 按书排行。
 * 纯函数 + 计时器，不碰存储、不碰 DOM，方便 Node 测试与 Web 复用。
 *
 * 约定：
 * - dailyMs 的键是本地日期 YYYY-MM-DD，archiveMs 的键是本地月份 YYYY-MM；
 * - 日桶只保留最近 400 天，更老的按月份并入 archiveMs，总时长不变；
 * - 旧记录缺 readMs / dailyMs / archiveMs / updatedAt 时一律按 0 / 空处理。
 */

export const DAY_MS = 86_400_000
export const DAILY_RETENTION_DAYS = 400
export const SESSION_CAP_MS = 12 * 60 * 60 * 1000
export const FLUSH_INTERVAL_MS = 5_000

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const MONTH_KEY = /^\d{4}-\d{2}$/

export interface ReadingTime {
  readMs: number
  dailyMs: Record<string, number>
  archiveMs: Record<string, number>
  updatedAt: string
}

export interface ReadingBookStats {
  bookId: string
  name: string
  readMs: number
  lastReadAt: string
  chapterIndex: number
  chapterTitle: string
  percent: number
  deleted: boolean
}

export interface ReadingDayStat {
  date: string
  label: string
  ms: number
}

export interface ReadingHeatDay {
  date: string
  ms: number
}

export interface ReadingStats {
  totalMs: number
  todayMs: number
  last30Ms: number
  last7Days: ReadingDayStat[]
  /** 含今天的 365 天热力数组，按日期升序，缺省 0；只覆盖日桶，归档月份不摊回。 */
  heat: ReadingHeatDay[]
  books: ReadingBookStats[]
}

export interface AggregatableBook {
  id?: string
  name?: string
  totalChapterNum?: number
  lastReadAt?: string | number
}

function positiveMs(value: unknown): number {
  const ms = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
}

function readMsField(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value)
}

function sanitizeBuckets(value: unknown, keys: RegExp): Record<string, number> {
  const out: Record<string, number> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!keys.test(key)) continue
    const ms = positiveMs(raw)
    if (ms > 0) out[key] = ms
  }
  return out
}

function sumBuckets(buckets: Record<string, number>): number {
  return Object.values(buckets).reduce((sum, ms) => sum + ms, 0)
}

/** 本地日期键（不是 UTC），跨零点按用户本地日期分桶。 */
export function localDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localMonthKey(date: Date): string {
  return localDateKey(date).slice(0, 7)
}

/** 从阅读记录里取出统计字段；缺字段、类型不对都按 0 处理，多个统计字段以较大值为准。 */
export function normalizeReadingTime(record: unknown): ReadingTime {
  const source = record && typeof record === 'object' ? (record as Record<string, unknown>) : {}
  const dailyMs = sanitizeBuckets(source.dailyMs, DATE_KEY)
  const archiveMs = sanitizeBuckets(source.archiveMs, MONTH_KEY)
  return {
    readMs: Math.max(readMsField(source.readMs), sumBuckets(dailyMs) + sumBuckets(archiveMs)),
    dailyMs,
    archiveMs,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  }
}

function isExpired(key: string, oldest: string): boolean {
  return key < oldest
}

/**
 * 把一次落盘的时长并进记录：累加 readMs、写本地日桶、把超过 400 天的日桶折进 archiveMs。
 * 返回新对象，不修改入参。
 */
export function addReadingTime(
  record: unknown,
  daily: Record<string, number>,
  now: Date = new Date(),
): ReadingTime {
  const base = normalizeReadingTime(record)
  const dailyMs: Record<string, number> = { ...base.dailyMs }
  const archiveMs: Record<string, number> = { ...base.archiveMs }
  const additions = sanitizeBuckets(daily, DATE_KEY)
  let added = 0
  for (const [key, ms] of Object.entries(additions)) {
    dailyMs[key] = (dailyMs[key] ?? 0) + ms
    added += ms
  }
  const oldestKey = localDateKey(new Date(now.getTime() - (DAILY_RETENTION_DAYS - 1) * DAY_MS))
  for (const key of Object.keys(dailyMs)) {
    if (!isExpired(key, oldestKey)) continue
    const month = key.slice(0, 7)
    archiveMs[month] = (archiveMs[month] ?? 0) + dailyMs[key]
    delete dailyMs[key]
  }
  return {
    readMs: Math.max(base.readMs + added, sumBuckets(dailyMs) + sumBuckets(archiveMs)),
    dailyMs,
    archiveMs,
    updatedAt: now.toISOString(),
  }
}

function lastDays(now: Date, count: number): ReadingDayStat[] {
  const days: ReadingDayStat[] = []
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12, 0, 0)
    days.push({
      date: localDateKey(date),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      ms: 0,
    })
  }
  return days
}

function percentOf(record: Record<string, unknown>, book: AggregatableBook | undefined): number {
  const total = typeof book?.totalChapterNum === 'number' ? book.totalChapterNum : 0
  const index = typeof record.chapterIndex === 'number' ? record.chapterIndex : 0
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(index)) return 0
  return Math.min(100, Math.max(0, Math.round(((index + 1) / total) * 100)))
}

function lastReadIso(record: Record<string, unknown>, book: AggregatableBook | undefined): string {
  if (typeof record.updatedAt === 'string' && record.updatedAt) return record.updatedAt
  const fallback = book?.lastReadAt
  if (typeof fallback === 'string') return fallback
  if (typeof fallback === 'number' && Number.isFinite(fallback) && fallback > 0) {
    return new Date(fallback).toISOString()
  }
  return ''
}

/** 把阅读记录聚合成「我的」页的统计；已删除的书保留在排行里并标注。 */
export function aggregateReadingStats(
  records: unknown[],
  books: AggregatableBook[],
  options: { now?: Date } = {},
): ReadingStats {
  const now = options.now ?? new Date()
  const byId = new Map<string, AggregatableBook>()
  for (const book of books) {
    const id = typeof book?.id === 'string' ? book.id : ''
    if (id) byId.set(id, book)
  }
  const todayKey = localDateKey(now)
  const days = lastDays(now, 7)
  const dayIndex = new Map(days.map((day) => [day.date, day]))
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29, 12, 0, 0)
  const windowStartKey = localDateKey(windowStart)
  const heatStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 364, 12, 0, 0)
  const heatStartKey = localDateKey(heatStart)
  const heatMs = new Map<string, number>()
  let totalMs = 0
  let todayMs = 0
  let last30Ms = 0
  const bookStats: ReadingBookStats[] = []
  for (const raw of records) {
    const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const time = normalizeReadingTime(record)
    if (time.readMs <= 0) continue
    const bookId = typeof record.bookId === 'string' ? record.bookId : typeof record.id === 'string' ? record.id : ''
    if (!bookId) continue
    const book = byId.get(bookId)
    const deleted = !book || record.deleted === true
    totalMs += time.readMs
    todayMs += time.dailyMs[todayKey] ?? 0
    for (const [key, ms] of Object.entries(time.dailyMs)) {
      const day = dayIndex.get(key)
      if (day) day.ms += ms
      if (key >= windowStartKey) last30Ms += ms
      if (key >= heatStartKey) heatMs.set(key, (heatMs.get(key) ?? 0) + ms)
    }
    bookStats.push({
      bookId,
      name: book?.name || (typeof record.bookName === 'string' && record.bookName) || '已删除',
      readMs: time.readMs,
      lastReadAt: lastReadIso(record, book),
      chapterIndex: typeof record.chapterIndex === 'number' ? record.chapterIndex : 0,
      chapterTitle: typeof record.chapterTitle === 'string' ? record.chapterTitle : '',
      percent: percentOf(record, book),
      deleted,
    })
  }
  bookStats.sort((a, b) => b.readMs - a.readMs || a.bookId.localeCompare(b.bookId))
  const heat: ReadingHeatDay[] = []
  for (let offset = 364; offset >= 0; offset -= 1) {
    const date = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12, 0, 0))
    heat.push({ date, ms: heatMs.get(date) ?? 0 })
  }
  return { totalMs, todayMs, last30Ms, last7Days: days, heat, books: bookStats }
}

/** 时长文案：卡片和底栏共用，0 分 / 不足 1 分 / N 分 / N 小时 M 分。 */
export function formatReadingDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分'
  if (ms < 60_000) return '<1 分'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分`
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`
}

export interface ReadingActivity {
  readingPage: boolean
  bookId: string
  hidden: boolean
  focused: boolean
}

/** 只有阅读页、有书、标签页可见且窗口聚焦同时成立时才算阅读。 */
export function shouldCountReading(activity: ReadingActivity): boolean {
  return activity.readingPage && activity.bookId !== '' && !activity.hidden && activity.focused
}

export interface ReadingFlushPayload {
  bookId: string
  daily: Record<string, number>
}

export interface ReadingTimerOptions {
  now?: () => number
  flush: (payload: ReadingFlushPayload) => void | Promise<void>
  tickMs?: number
  flushMs?: number
  /** 测试里关掉真实定时器，手动调 tick。 */
  autoTick?: boolean
}

/**
 * 阅读计时器：只在阅读页且可见、聚焦时由外部 setActive(true) 开启。
 * 每秒累加、每 5 秒落盘、换书/停止/离开立即落盘，单次会话最多计 12 小时。
 */
export class ReadingTimer {
  bookId = ''
  active = false
  capped = false
  sessionMs = 0

  private readonly now: () => number
  private readonly flushFn: ReadingTimerOptions['flush']
  private readonly tickMs: number
  private readonly flushMs: number
  private readonly autoTick: boolean
  private pending: Record<string, number> = {}
  private pendingMs = 0
  private interval: ReturnType<typeof setInterval> | null = null

  constructor(options: ReadingTimerOptions) {
    this.now = options.now ?? Date.now
    this.flushFn = options.flush
    this.tickMs = options.tickMs ?? 1000
    this.flushMs = options.flushMs ?? FLUSH_INTERVAL_MS
    this.autoTick = options.autoTick !== false
  }

  setBook(bookId: string): void {
    if (bookId === this.bookId) return
    this.flush()
    this.bookId = bookId
  }

  setActive(active: boolean): void {
    if (active === this.active) return
    if (!active) {
      this.stopInterval()
      this.flush()
      this.resetSession()
      this.active = false
      return
    }
    this.active = true
    if (this.autoTick) {
      this.stopInterval()
      this.interval = setInterval(() => this.tick(), this.tickMs)
    }
  }

  /** 累加一段阅读时长；默认 1 秒，跨零点按本地日期拆分。 */
  tick(ms: number = this.tickMs): void {
    if (!this.active || !this.bookId || this.capped) return
    const remaining = SESSION_CAP_MS - this.sessionMs
    if (remaining <= 0) {
      this.capped = true
      return
    }
    const delta = Math.min(ms, remaining)
    if (!Number.isFinite(delta) || delta <= 0) return
    this.addAcrossDays(this.now() - delta, delta)
    this.sessionMs += delta
    this.pendingMs += delta
    if (this.sessionMs >= SESSION_CAP_MS) this.capped = true
    if (this.pendingMs >= this.flushMs) this.flush()
  }

  /** 立即落盘；没有待写时长或没有书时不回调。 */
  flush(): void {
    if (!this.bookId || this.pendingMs <= 0) return
    const payload: ReadingFlushPayload = { bookId: this.bookId, daily: this.pending }
    this.pending = {}
    this.pendingMs = 0
    try {
      const result = this.flushFn(payload)
      if (result && typeof (result as Promise<void>).catch === 'function') {
        ;(result as Promise<void>).catch(() => undefined)
      }
    } catch {
      // 落盘失败不打断阅读，下一次落盘会带上新时长。
    }
  }

  stop(): void {
    this.setActive(false)
    this.bookId = ''
  }

  private resetSession(): void {
    this.sessionMs = 0
    this.capped = false
  }

  private stopInterval(): void {
    if (this.interval === null) return
    clearInterval(this.interval)
    this.interval = null
  }

  private addAcrossDays(startMs: number, delta: number): void {
    let cursor = startMs
    let left = delta
    while (left > 0) {
      const cursorDate = new Date(cursor)
      const nextMidnight = new Date(
        cursorDate.getFullYear(),
        cursorDate.getMonth(),
        cursorDate.getDate() + 1,
        0, 0, 0, 0,
      ).getTime()
      const chunk = Math.min(left, Math.max(1, nextMidnight - cursor))
      const key = localDateKey(new Date(cursor))
      this.pending[key] = (this.pending[key] ?? 0) + chunk
      cursor += chunk
      left -= chunk
    }
  }
}

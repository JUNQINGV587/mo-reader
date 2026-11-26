import { createHash, randomUUID } from 'node:crypto'
import type { TocChapter } from '../core/source/analyze.js'
import { cachedChapterSize, writeCachedChapter } from './cache.js'

/** 作业类型：下载整本/区间时写进 jobs.kind，与后续导出作业区分。 */
export const DOWNLOAD_KIND = 'download'
/** 单章失败后的重试次数（不含首次尝试），指数退避。 */
export const CHAPTER_RETRY_LIMIT = 2
/** 全局最多同时下载的章节数。 */
export const DOWNLOAD_CONCURRENCY = 4
/** 同一来源最多同时下载的章节数。 */
export const SOURCE_CONCURRENCY = 2
/** 进度落盘间隔（毫秒）：最多每 500ms 写一次 jobs 表。 */
export const PROGRESS_FLUSH_MS = 500
/** 重试退避基数（毫秒），测试可覆盖服务实例上的 downloadRetryBaseMs。 */
export const DEFAULT_RETRY_BASE_MS = 300

export type JobStatus = 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'

/** jobs 表记录：字段与规格 #103 一致。 */
export interface DownloadJob {
  id: string
  kind: string
  bookId: string
  bookName: string
  status: JobStatus
  fromIndex: number
  toIndex: number
  all: boolean
  total: number
  completed: number
  failed: number
  skipped: number
  bytes: number
  error: string
  createdAt: number
  updatedAt: number
}

export interface CachedChapterResult {
  bytes: number
  cached: boolean
}

/** 一章下载完成（含命中已有缓存）时交给宿主的登记信息；正文本身不在这里。 */
export interface ChapterDownload {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  sourceUrl: string
  bytes: number
}

/** 单章在整本书里的位置，用于下载/阅读时补登索引。 */
export interface ChapterLocation {
  bookId: string
  chapterIndex: number
  chapterTitle?: string
}

/** 索引 key：bookId 可能含任意字符，先哈希再拼章序号，满足 per-record 的 key 约束。 */
export function downloadEntryKey(bookId: string, chapterIndex: number): string {
  const digest = createHash('sha1').update(bookId).digest('hex').slice(0, 16)
  return `dl-${digest}-${Math.max(0, Math.floor(chapterIndex))}`
}

/** 下载器依赖的服务能力；服务与测试都通过它注入，避免直接抓网络。 */
export interface DownloadHost {
  db(): any
  getContent(args: Record<string, unknown>): Promise<any>
  loadToc(book: Record<string, unknown>): Promise<TocChapter[]>
  currentChapterIndex(bookId: string, book: Record<string, unknown>): number
  retryBaseMs(): number | undefined
  /** 可选：把下载完成/已有缓存的章节登记到下载索引；宿主不提供时跳过。 */
  recordChapterDownload?(entry: ChapterDownload): Promise<void>
}

export function isActiveJob(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'paused'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as any).unref?.()
  })
}

/** 永久性失败（非文本章节、空正文）：重试没有意义，立即计失败。 */
class PermanentChapterError extends Error {}

/**
 * 单章下载：命中缓存直接计完成；否则拉正文并写入文字缓存。
 * 失败最多重试 CHAPTER_RETRY_LIMIT 次（指数退避），仍失败则抛出。
 */
export async function ensureChapterCached(
  host: DownloadHost,
  sourceUrl: string,
  chapterUrl: string,
  retryBaseMs = DEFAULT_RETRY_BASE_MS,
  location?: ChapterLocation,
): Promise<CachedChapterResult> {
  const existing = await cachedChapterSize(sourceUrl, chapterUrl)
  if (existing > 0) {
    await recordChapterDownload(host, sourceUrl, chapterUrl, existing, location)
    return { bytes: existing, cached: true }
  }
  const base = Number.isFinite(retryBaseMs) && retryBaseMs >= 0 ? retryBaseMs : DEFAULT_RETRY_BASE_MS
  let lastError: unknown = null
  for (let attempt = 0; attempt <= CHAPTER_RETRY_LIMIT; attempt += 1) {
    try {
      const content = await host.getContent({ sourceUrl, chapterUrl })
      if (content?.kind && content.kind !== 'text') throw new PermanentChapterError('该章节不是文本类型')
      const text = String(content?.content ?? '')
      if (!text.trim()) throw new PermanentChapterError('正文为空')
      const bytes = await writeCachedChapter(sourceUrl, chapterUrl, text)
      await recordChapterDownload(host, sourceUrl, chapterUrl, bytes, location)
      return { bytes, cached: false }
    } catch (error) {
      lastError = error
      if (error instanceof PermanentChapterError) break
      if (attempt < CHAPTER_RETRY_LIMIT) await sleep(base * 2 ** attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** 索引是簿记：登记失败只丢统计，不能让已下好的章节算失败。 */
async function recordChapterDownload(
  host: DownloadHost,
  sourceUrl: string,
  chapterUrl: string,
  bytes: number,
  location?: ChapterLocation,
): Promise<void> {
  if (!location || !host.recordChapterDownload) return
  try {
    await host.recordChapterDownload({
      bookId: location.bookId,
      chapterIndex: location.chapterIndex,
      chapterTitle: location.chapterTitle ?? '',
      chapterUrl,
      sourceUrl,
      bytes,
    })
  } catch {
    // 忽略：索引缺失时按未登记处理，缓存文件仍可读。
  }
}

/** 全局 + 同来源两级并发闸门；acquire 排队等待，release 后唤醒可运行者。 */
export class ChapterLimiter {
  private active = 0
  private readonly bySource = new Map<string, number>()
  private readonly waiters: Array<{ source: string; resolve: () => void }> = []

  constructor(
    private readonly globalLimit = DOWNLOAD_CONCURRENCY,
    private readonly sourceLimit = SOURCE_CONCURRENCY,
  ) {}

  async acquire(source: string): Promise<void> {
    if (this.reserve(source)) return
    await new Promise<void>((resolve) => {
      this.waiters.push({ source, resolve })
    })
  }

  release(source: string): void {
    this.active = Math.max(0, this.active - 1)
    const used = (this.bySource.get(source) ?? 1) - 1
    if (used <= 0) this.bySource.delete(source)
    else this.bySource.set(source, used)
    this.drain()
  }

  private reserve(source: string): boolean {
    if (this.active >= this.globalLimit) return false
    const used = this.bySource.get(source) ?? 0
    if (used >= this.sourceLimit) return false
    this.active += 1
    this.bySource.set(source, used + 1)
    return true
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length && this.active < this.globalLimit; ) {
      const waiter = this.waiters[index]!
      if (!this.reserve(waiter.source)) {
        index += 1
        continue
      }
      this.waiters.splice(index, 1)
      waiter.resolve()
    }
  }
}

interface StartOptions {
  fromIndex?: number
  toIndex?: number
  all?: boolean
}

interface ListFilter {
  bookId?: string
  kind?: string
  status?: string
}

/**
 * 下载作业协调器：负责建作业、按范围调度章节、暂停/继续/取消、限频落盘。
 * 同一本书同一 kind 同时只保留一个活动作业；重启后的恢复由 recoverInterruptedJobs 完成。
 */
export class DownloadCoordinator {
  private readonly live = new Map<string, DownloadJob>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly pendingFlush = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lastFlush = new Map<string, number>()
  private readonly writeChains = new Map<string, Promise<void>>()
  private readonly limiter = new ChapterLimiter()

  constructor(private readonly host: DownloadHost) {}

  async start(bookId: string, options: StartOptions = {}) {
    const db = this.host.db()
    const book = db.books.get(bookId) as Record<string, any> | undefined
    if (!book) throw new Error('书不存在')
    const origin = String(book.origin ?? '')
    if (origin === 'local') throw new Error('本地书无需下载')
    if (!origin) throw new Error('书缺少来源地址')
    const chapters = await this.host.loadToc(book)
    if (!chapters.length) throw new Error('目录为空')
    const existing = this.findActive(bookId)
    if (existing) return { job: { ...existing }, existing: true }

    const last = chapters.length - 1
    const all = options.all === true
    const requestedFrom = all ? 0 : options.fromIndex === undefined ? this.host.currentChapterIndex(bookId, book) : Number(options.fromIndex)
    const requestedTo = all || options.toIndex === undefined ? last : Number(options.toIndex)
    const fromIndex = clampIndex(requestedFrom, last)
    const toIndex = clampIndex(requestedTo, last)
    if (toIndex < fromIndex) throw new Error('起止章节无效')

    const now = Date.now()
    const job: DownloadJob = {
      id: randomUUID(),
      kind: DOWNLOAD_KIND,
      bookId,
      bookName: String(book.name ?? ''),
      status: 'queued',
      fromIndex,
      toIndex,
      all,
      total: toIndex - fromIndex + 1,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    this.live.set(job.id, job)
    await this.write(job, true)
    this.launch(job.id)
    return { job: { ...job }, existing: false }
  }

  async pause(id: string) {
    return this.stop(id, 'paused')
  }

  async cancel(id: string) {
    return this.stop(id, 'cancelled')
  }

  async resume(id: string) {
    return this.restart(id)
  }

  async retry(id: string) {
    return this.restart(id)
  }

  get(id: string) {
    return { job: { ...this.requireJob(id) } }
  }

  list(filter: ListFilter = {}) {
    const jobs: DownloadJob[] = []
    const table = this.host.db().jobs
    // 旧测试的假 db 可能没有作业表，按「没有作业」处理。
    if (!table || typeof table.entries !== 'function') return jobs
    for (const [id, record] of table.entries()) {
      const job = (this.live.get(id) ?? record) as DownloadJob
      if (filter.bookId && job.bookId !== filter.bookId) continue
      if (filter.kind && job.kind !== filter.kind) continue
      if (filter.status && job.status !== filter.status) continue
      jobs.push({ ...job })
    }
    jobs.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    return jobs
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size) {
      await Promise.allSettled([...this.runners.values()])
    }
  }

  /** 只等这本书的在途作业收尾，别的书还在下也不耽误删这本。 */
  async waitBookIdle(bookId: string): Promise<void> {
    for (;;) {
      const pending: Promise<void>[] = []
      for (const [id, runner] of this.runners) {
        const job = this.live.get(id) ?? (this.host.db().jobs?.get(id) as DownloadJob | undefined)
        if (job?.bookId === bookId) pending.push(runner)
      }
      if (!pending.length) return
      await Promise.allSettled(pending)
    }
  }

  /** 服务关闭：把还在跑或排队的作业标为暂停，落盘并等待协程收尾。 */
  async shutdown(): Promise<void> {
    const now = Date.now()
    for (const job of this.live.values()) {
      if (job.status !== 'running' && job.status !== 'queued') continue
      job.status = 'paused'
      job.error = '宿主重启'
      job.updatedAt = now
      await this.write(job, true)
    }
    await this.waitIdle()
    for (const timer of this.pendingFlush.values()) clearTimeout(timer)
    this.pendingFlush.clear()
  }

  private async stop(id: string, status: 'paused' | 'cancelled') {
    const job = this.requireJob(id)
    if (!isActiveJob(job.status) || job.status === status) return { job: { ...job } }
    job.status = status
    job.updatedAt = Date.now()
    await this.write(job, true)
    return { job: { ...job } }
  }

  private async restart(id: string) {
    const job = this.requireJob(id)
    if (job.status === 'running' || job.status === 'queued') return { job: { ...job } }
    const runner = this.runners.get(id)
    if (runner) await runner.catch(() => {})
    // 旧协程收尾时会写终态/暂停态，重新读取后再排进队列。
    const current = this.requireJob(id)
    current.status = 'queued'
    current.error = ''
    current.updatedAt = Date.now()
    await this.write(current, true)
    this.launch(id)
    return { job: { ...current } }
  }

  private requireJob(id: string): DownloadJob {
    const existing = this.live.get(id) ?? (this.host.db().jobs.get(id) as DownloadJob | undefined)
    if (!existing) throw new Error('作业不存在')
    this.live.set(id, existing)
    return existing
  }

  private findActive(bookId: string): DownloadJob | undefined {
    const candidates: DownloadJob[] = []
    const table = this.host.db().jobs
    if (!table || typeof table.entries !== 'function') return undefined
    for (const [id, record] of table.entries()) {
      const job = (this.live.get(id) ?? record) as DownloadJob
      if (job.bookId !== bookId || job.kind !== DOWNLOAD_KIND) continue
      if (isActiveJob(job.status)) candidates.push(job)
    }
    return candidates[0]
  }

  private launch(id: string): void {
    if (this.runners.has(id)) return
    const runner = this.run(id)
      .catch(() => {})
      .finally(() => {
        if (this.runners.get(id) === runner) this.runners.delete(id)
      })
    this.runners.set(id, runner)
  }

  private async run(id: string): Promise<void> {
    const job = this.requireJob(id)
    if (job.status !== 'queued') return
    const db = this.host.db()
    const book = db.books.get(job.bookId) as Record<string, unknown> | undefined
    if (!book) {
      job.status = 'failed'
      job.error = '书不存在'
      job.updatedAt = Date.now()
      await this.write(job, true)
      return
    }
    let chapters: TocChapter[]
    try {
      chapters = await this.host.loadToc(book)
    } catch (error) {
      job.status = 'failed'
      job.error = errorMessage(error)
      job.updatedAt = Date.now()
      await this.write(job, true)
      return
    }
    const last = chapters.length - 1
    const toIndex = Math.max(0, Math.min(job.toIndex, last))
    const fromIndex = Math.max(0, Math.min(job.fromIndex, toIndex))
    job.status = 'running'
    job.error = ''
    job.fromIndex = fromIndex
    job.toIndex = toIndex
    job.total = Math.max(0, toIndex - fromIndex + 1)
    // 继续/重试时重扫范围：已缓存章节直接计完成，因此不会重下。
    job.completed = 0
    job.failed = 0
    job.skipped = 0
    job.bytes = 0
    job.updatedAt = Date.now()
    await this.write(job, true)
    try {
      await this.downloadRange(job, chapters, String(book.origin ?? ''))
    } catch (error) {
      if (job.status === 'running') {
        job.status = 'failed'
        job.error = errorMessage(error)
        job.updatedAt = Date.now()
      }
    } finally {
      if (job.status === 'running') {
        if (job.completed > 0) job.status = 'done'
        else {
          job.status = 'failed'
          job.error = job.failed > 0 ? '全部章节下载失败' : '没有可下载的章节'
        }
      }
      job.updatedAt = Date.now()
      await this.write(job, true)
      this.live.delete(id)
    }
  }

  private async downloadRange(job: DownloadJob, chapters: TocChapter[], sourceUrl: string): Promise<void> {
    let nextIndex = job.fromIndex
    const workerCount = Math.max(1, Math.min(DOWNLOAD_CONCURRENCY, job.total))
    const worker = async (): Promise<void> => {
      while (true) {
        if (job.status !== 'running') return
        const index = nextIndex
        nextIndex += 1
        if (index > job.toIndex) return
        const chapter = chapters[index]
        if (!chapter || chapter.isVolume || !chapter.url) {
          job.skipped += 1
          this.touch(job)
          continue
        }
        await this.limiter.acquire(sourceUrl)
        try {
          if (job.status !== 'running') return
          const result = await ensureChapterCached(this.host, sourceUrl, chapter.url, this.retryBase(), {
            bookId: job.bookId,
            chapterIndex: index,
            chapterTitle: chapter.title,
          })
          job.completed += 1
          job.bytes += result.bytes
        } catch {
          job.failed += 1
        } finally {
          this.limiter.release(sourceUrl)
        }
        this.touch(job)
      }
    }
    const workers: Array<Promise<void>> = []
    for (let i = 0; i < workerCount; i += 1) workers.push(worker())
    await Promise.all(workers)
  }

  private touch(job: DownloadJob): void {
    job.updatedAt = Date.now()
    this.scheduleWrite(job)
  }

  private scheduleWrite(job: DownloadJob): void {
    if (this.pendingFlush.has(job.id)) return
    const last = this.lastFlush.get(job.id) ?? 0
    const wait = PROGRESS_FLUSH_MS - (Date.now() - last)
    if (wait <= 0) {
      void this.write(job)
      return
    }
    const timer = setTimeout(() => {
      this.pendingFlush.delete(job.id)
      void this.write(job)
    }, wait)
    ;(timer as any).unref?.()
    this.pendingFlush.set(job.id, timer)
  }

  private cancelFlush(id: string): void {
    const timer = this.pendingFlush.get(id)
    if (timer) clearTimeout(timer)
    this.pendingFlush.delete(id)
  }

  private async write(job: DownloadJob, force = false): Promise<void> {
    if (force) this.cancelFlush(job.id)
    else if (this.pendingFlush.has(job.id)) return
    const now = Date.now()
    const last = this.lastFlush.get(job.id) ?? 0
    if (!force && now - last < PROGRESS_FLUSH_MS) {
      this.scheduleWrite(job)
      return
    }
    this.lastFlush.set(job.id, now)
    const snapshot = { ...job }
    const previous = this.writeChains.get(job.id) ?? Promise.resolve()
    const chain: Promise<void> = previous.then(async () => {
      try {
        await this.host.db().jobs.put(job.id, snapshot)
      } catch {
        // 进度落盘失败不打断下载，下次落盘会带上最新进度。
      }
    })
    this.writeChains.set(job.id, chain)
    chain.then(
      () => {
        if (this.writeChains.get(job.id) === chain) this.writeChains.delete(job.id)
      },
      () => {},
    )
    await chain
  }

  private retryBase(): number {
    const value = this.host.retryBaseMs()
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_BASE_MS
  }
}

function clampIndex(value: number, last: number): number {
  if (!Number.isFinite(value)) return 0
  const index = Math.trunc(value)
  return Math.max(0, Math.min(last, index))
}

/**
 * 宿主重启后调用：把残留的 running/queued 作业标为暂停并注明原因，
 * 让详情页能显示「已暂停（宿主重启）」并提供继续。
 */
export async function recoverInterruptedJobs(jobs: any, now = Date.now()): Promise<number> {
  if (!jobs || typeof jobs.entries !== 'function') return 0
  const pending: Array<[string, DownloadJob]> = []
  for (const [id, record] of jobs.entries()) {
    const job = record as DownloadJob
    if (job?.status !== 'running' && job?.status !== 'queued') continue
    pending.push([id, { ...job, status: 'paused', error: '宿主重启', updatedAt: now }])
  }
  for (const [id, record] of pending) await jobs.put(id, record)
  return pending.length
}

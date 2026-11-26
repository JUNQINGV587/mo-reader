/**
 * 媒体离线下载协调器（#112）：漫画按章、音频/视频按单文件整章下载。
 *
 * 与文字下载（download.ts）共用 jobs 表、暂停/继续/取消/重试与重启恢复语义，
 * 但媒体作业有自己的 kind 与 mediaKind：同一本书同一媒体类型只允许一个活动作业，
 * 且只有整章文件全部落盘后才会发布可播放索引（见 service.ts 的 putMediaEntry）。
 */
import { randomUUID } from 'node:crypto'
import {
  CHAPTER_RETRY_LIMIT,
  DEFAULT_RETRY_BASE_MS,
  PROGRESS_FLUSH_MS,
  isActiveJob,
  type DownloadJob,
  type JobStatus,
} from './download.js'
import type { TocChapter } from '../core/source/analyze.js'

export const MEDIA_DOWNLOAD_KIND = 'media-download'
export const MEDIA_DOWNLOAD_CONCURRENCY = 2
export const MEDIA_SOURCE_CONCURRENCY = 2

export type MediaEntryKind = 'image' | 'audio' | 'video'

export interface MediaFileRecord {
  id: string
  name: string
  mime: string
  bytes: number
  /** 相对媒体缓存根目录的路径，形如 <storeId>/<序号>.<ext>。 */
  path: string
}

export interface MediaChapterDownload {
  bookId: string
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  sourceUrl: string
  kind: MediaEntryKind
  mime: string
  bytes: number
  files: MediaFileRecord[]
}

export type MediaJob = DownloadJob & { mediaKind: MediaEntryKind }

export interface MediaChapterResult {
  skipped: boolean
  reason?: string
  entry?: MediaChapterDownload
}

export interface MediaDownloadHost {
  db(): any
  loadToc(book: any): Promise<TocChapter[]>
  currentChapterIndex(bookId: string, book: any): number
  retryBaseMs(): number
  /** 这本书属于哪种媒体；文字书不允许建媒体作业。 */
  mediaKind(bookId: string, book: any): MediaEntryKind
  downloadChapterMedia(args: {
    bookId: string
    book: any
    chapterIndex: number
    chapterTitle: string
    chapterUrl: string
    sourceUrl: string
    kind: MediaEntryKind
    /** 暂停/取消/卸载时触发：在途大文件应尽快中断，别让关停等整部视频。 */
    signal?: AbortSignal
  }): Promise<MediaChapterResult>
  recordMediaDownload(entry: MediaChapterDownload): Promise<void>
  /** 可选：本章是否已完整落盘（续跑时跳过重复下载），返回字节数。 */
  chapterMediaBytes?(bookId: string, chapterIndex: number, kind: MediaEntryKind): Promise<number | null>
  /** 作业被暂停/取消时清掉刚下完但未发布索引的半成品目录（可选）。 */
  discardChapterMedia?(bookId: string, chapterIndex: number): Promise<void>
}

/**
 * 永久失败：重试没有意义（典型是 DRM 加密）。
 * 协调器遇到它直接让作业失败并保留原始文案，不再重试、不发布索引。
 */
export class PermanentMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentMediaError'
  }
}

/** 暂停/取消后抛给舞者，让整章下载立即停止且不落索引。 */
export class MediaDownloadInterrupted extends Error {
  constructor() {
    super('媒体下载已中断')
    this.name = 'MediaDownloadInterrupted'
  }
}

export interface StartMediaOptions {
  fromIndex?: number
  toIndex?: number
  all?: boolean
}

export interface MediaJobFilter {
  bookId?: string
  kind?: string
  status?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clampIndex(value: number | undefined, fallback: number, max: number): number {
  const raw = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(0, raw), Math.max(0, max))
}

/** 同源并发限制：整章下载最多 2 个任务同时进行，避免把书源打爆。 */
class SourceLimiter {
  private readonly globalLimit: number
  private readonly sourceLimit: number
  private active = 0
  private readonly perSource = new Map<string, number>()
  private readonly waiters: Array<() => void> = []

  constructor(globalLimit: number, sourceLimit: number) {
    this.globalLimit = Math.max(1, globalLimit)
    this.sourceLimit = Math.max(1, sourceLimit)
  }

  async acquire(source: string): Promise<void> {
    for (;;) {
      const sourceActive = this.perSource.get(source) ?? 0
      if (this.active < this.globalLimit && sourceActive < this.sourceLimit) {
        this.active += 1
        this.perSource.set(source, sourceActive + 1)
        return
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  release(source: string): void {
    this.active = Math.max(0, this.active - 1)
    const next = Math.max(0, (this.perSource.get(source) ?? 0) - 1)
    if (next === 0) this.perSource.delete(source)
    else this.perSource.set(source, next)
    const waiter = this.waiters.shift()
    if (waiter) waiter()
  }
}

export class MediaDownloadCoordinator {
  private readonly host: MediaDownloadHost
  private readonly live = new Map<string, MediaJob>()
  private readonly runners = new Map<string, Promise<void>>()
  private pendingFlush: ReturnType<typeof setTimeout> | null = null
  private lastFlush = 0
  private readonly writeChains = new Map<string, Promise<void>>()
  /** 每个运行中的作业一个中断器：暂停/取消/卸载时断掉在途媒体流。 */
  private readonly aborts = new Map<string, AbortController>()
  private readonly limiter = new SourceLimiter(MEDIA_DOWNLOAD_CONCURRENCY, MEDIA_SOURCE_CONCURRENCY)

  constructor(host: MediaDownloadHost) {
    this.host = host
  }

  /** 开始一个媒体下载作业；同一本书同一媒体类型已有活动作业时直接返回它。 */
  async start(
    bookId: string,
    options: StartMediaOptions = {},
  ): Promise<{ job: MediaJob; existing: boolean }> {
    const db = this.host.db()
    const book = db.books.get(bookId)
    if (!book) throw new Error('书不存在')
    const origin = String(book.origin ?? '').trim()
    if (book.origin === 'local') throw new Error('本地书无需下载')
    if (!origin) throw new Error('书缺少来源地址')
    const toc = await this.host.loadToc(book)
    if (!toc.length) throw new Error('目录为空')

    const kind = this.host.mediaKind(bookId, book)
    if (kind !== 'image' && kind !== 'audio' && kind !== 'video') {
      throw new Error('这本书没有可下载的媒体')
    }

    const existing = this.findActive(bookId, kind)
    if (existing) return { job: { ...existing }, existing: true }

    const last = toc.length - 1
    const fromIndex = clampIndex(options.fromIndex, 0, last)
    const toIndex = clampIndex(options.toIndex, last, last)
    if (toIndex < fromIndex) throw new Error('起止章节无效')

    const now = Date.now()
    const job: MediaJob = {
      id: randomUUID(),
      kind: MEDIA_DOWNLOAD_KIND,
      bookId,
      bookName: String(book.name ?? bookId),
      status: 'queued',
      fromIndex,
      toIndex,
      all: options.all === true,
      total: toIndex - fromIndex + 1,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      error: '',
      createdAt: now,
      updatedAt: now,
      mediaKind: kind,
    }
    this.live.set(job.id, job)
    await this.write(job, true)
    this.launch(job.id)
    return { job: { ...job }, existing: false }
  }

  async pause(id: string): Promise<{ job: MediaJob }> {
    return this.stop(id, 'paused')
  }

  async cancel(id: string): Promise<{ job: MediaJob }> {
    return this.stop(id, 'cancelled')
  }

  async resume(id: string): Promise<{ job: MediaJob }> {
    return this.restart(id)
  }

  async retry(id: string): Promise<{ job: MediaJob }> {
    return this.restart(id)
  }

  /** 只读快照：活动作业优先，否则读持久化记录。 */
  get(id: string): { job: MediaJob } {
    const job = this.requireJob(id)
    return { job: { ...job } }
  }

  peek(id: string): MediaJob | null {
    const job = this.live.get(id)
    return job ? { ...job } : null
  }

  list(filter: MediaJobFilter = {}): MediaJob[] {
    const db = this.host.db()
    const found: MediaJob[] = []
    for (const [id, record] of db.jobs.entries()) {
      if (record?.kind !== MEDIA_DOWNLOAD_KIND) continue
      const job = (this.live.get(id) ?? record) as MediaJob
      if (filter.bookId && job.bookId !== filter.bookId) continue
      if (filter.kind && job.kind !== filter.kind) continue
      if (filter.status && job.status !== filter.status) continue
      found.push({ ...job })
    }
    found.sort((a, b) => b.updatedAt - a.updatedAt)
    return found
  }

  async waitIdle(): Promise<void> {
    for (;;) {
      if (!this.runners.size) return
      await Promise.allSettled([...this.runners.values()])
    }
  }

  async shutdown(): Promise<void> {
    const now = Date.now()
    for (const job of this.live.values()) {
      if (job.status !== 'running' && job.status !== 'queued') continue
      job.status = 'paused'
      job.error = '宿主重启'
      job.updatedAt = now
      this.aborts.get(job.id)?.abort()
      await this.write(job, true)
    }
    await this.waitIdle()
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush)
      this.pendingFlush = null
    }
  }

  private findActive(bookId: string, kind: MediaEntryKind): MediaJob | null {
    const db = this.host.db()
    const candidates: MediaJob[] = []
    for (const [id, record] of db.jobs.entries()) {
      if (record?.kind !== MEDIA_DOWNLOAD_KIND) continue
      if (record.bookId !== bookId) continue
      const job = (this.live.get(id) ?? record) as MediaJob
      if (job.mediaKind !== kind) continue
      if (!isActiveJob(job.status)) continue
      candidates.push(job)
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt)
    return candidates[0] ?? null
  }

  private async stop(id: string, status: JobStatus): Promise<{ job: MediaJob }> {
    const job = this.requireJob(id)
    if (!isActiveJob(job.status) || job.status === status) return { job: { ...job } }
    job.status = status
    job.updatedAt = Date.now()
    // 在途的大文件立刻断流，不等它下完；半成品目录由 service 在中断后清掉。
    this.aborts.get(id)?.abort()
    await this.write(job, true)
    return { job: { ...job } }
  }

  private async restart(id: string): Promise<{ job: MediaJob }> {
    const running = this.runners.get(id)
    if (running) await running.catch(() => {})
    const job = this.requireJob(id)
    job.status = 'queued'
    job.error = ''
    job.updatedAt = Date.now()
    await this.write(job, true)
    this.launch(id)
    return { job: { ...job } }
  }

  private requireJob(id: string): MediaJob {
    const job = this.live.get(id) ?? ((this.host.db().jobs.get(id) as MediaJob | undefined) ?? null)
    if (!job) throw new Error('作业不存在')
    const typed = job as MediaJob
    this.live.set(id, typed)
    return typed
  }

  private launch(id: string): void {
    if (this.runners.has(id)) return
    const runner = this.run(id)
      .catch(() => {})
      .finally(() => {
        this.runners.delete(id)
      })
    this.runners.set(id, runner)
  }

  private async run(id: string): Promise<void> {
    const job = this.requireJob(id)
    if (job.status !== 'queued') return
    const db = this.host.db()
    const book = db.books.get(job.bookId)
    if (!book) {
      job.status = 'failed'
      job.error = '书不存在'
      job.updatedAt = Date.now()
      await this.write(job, true)
      this.live.delete(id)
      return
    }

    let toc: TocChapter[]
    try {
      toc = await this.host.loadToc(book)
    } catch (error) {
      job.status = 'failed'
      job.error = errorMessage(error)
      job.updatedAt = Date.now()
      await this.write(job, true)
      this.live.delete(id)
      return
    }

    const last = toc.length - 1
    const fromIndex = clampIndex(job.fromIndex, 0, last)
    const toIndex = clampIndex(job.toIndex, last, last)
    job.fromIndex = fromIndex
    job.toIndex = toIndex
    job.status = 'running'
    job.error = ''
    job.total = Math.max(0, toIndex - fromIndex + 1)
    job.completed = 0
    job.failed = 0
    job.skipped = 0
    job.bytes = 0
    job.updatedAt = Date.now()
    await this.write(job, true)
    this.aborts.set(id, new AbortController())

    try {
      await this.downloadRange(job, book, toc, fromIndex, toIndex)
    } catch (error) {
      if (job.status === 'running') {
        job.status = 'failed'
        job.error = errorMessage(error)
      }
    } finally {
      if (job.status === 'running') {
        // 全是 HLS 等「主动跳过」的章节也算正常结束，不是失败。
        if (job.completed > 0 || (job.skipped > 0 && job.failed === 0)) job.status = 'done'
        else if (job.failed > 0) {
          job.status = 'failed'
          job.error = '全部章节下载失败'
        } else {
          job.status = 'failed'
          job.error = '没有可下载的章节'
        }
      }
      job.updatedAt = Date.now()
      await this.write(job, true)
      this.aborts.delete(id)
      this.live.delete(id)
    }
  }

  private async downloadRange(
    job: MediaJob,
    book: any,
    toc: TocChapter[],
    fromIndex: number,
    toIndex: number,
  ): Promise<void> {
    let nextIndex = fromIndex
    // 永久失败（DRM 等）要中断整批章节：等已开工的章节收尾后把原因抛给 run()，
    // 由它把作业置 failed 并写原始文案，而不是落成「全部章节下载失败」。
    let permanentError: PermanentMediaError | null = null
    const workerCount = Math.max(1, Math.min(MEDIA_DOWNLOAD_CONCURRENCY, toIndex - fromIndex + 1))
    const worker = async (): Promise<void> => {
      for (;;) {
        if (job.status !== 'running' || permanentError) return
        const index = nextIndex
        nextIndex += 1
        if (index > toIndex) return
        const chapter = toc[index]
        if (!chapter || chapter.isVolume || !String(chapter.url ?? '').trim()) {
          job.skipped += 1
          this.touch(job)
          continue
        }
        // 续跑：整章文件都还在时直接计完成，不重复抓取已离线的内容。
        const readyBytes = await this.chapterReadyBytes(job, index)
        if (readyBytes !== null) {
          job.completed += 1
          job.bytes += readyBytes
          this.touch(job)
          continue
        }
        const sourceUrl = String(book.origin ?? '')
        await this.limiter.acquire(sourceUrl)
        try {
          if (job.status !== 'running') return
          const result = await this.downloadChapterWithRetry(job, book, index, chapter, sourceUrl)
          if (result.skipped) {
            job.skipped += 1
          } else if (result.entry) {
            job.completed += 1
            job.bytes += result.entry.bytes
          }
        } catch (error) {
          if (error instanceof MediaDownloadInterrupted) return
          if (error instanceof PermanentMediaError) {
            permanentError = permanentError ?? error
            return
          }
          job.failed += 1
        } finally {
          this.limiter.release(sourceUrl)
          this.touch(job)
        }
      }
    }
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    if (permanentError) throw permanentError
  }

  private async chapterReadyBytes(job: MediaJob, index: number): Promise<number | null> {
    if (!this.host.chapterMediaBytes) return null
    try {
      return await this.host.chapterMediaBytes(job.bookId, index, job.mediaKind)
    } catch {
      // 索引检查失败按未下载处理，照常抓取，不因续跑优化阻塞作业。
      return null
    }
  }

  /** 单章失败重试：媒体流可能中途断开，重试前 service 会清掉半成品目录。 */
  private async downloadChapterWithRetry(
    job: MediaJob,
    book: any,
    index: number,
    chapter: TocChapter,
    sourceUrl: string,
  ): Promise<MediaChapterResult> {
    const kind = job.mediaKind
    let lastError: unknown = null
    for (let attempt = 0; attempt <= CHAPTER_RETRY_LIMIT; attempt++) {
      if (job.status !== 'running') throw new MediaDownloadInterrupted()
      try {
        const result = await this.host.downloadChapterMedia({
          bookId: job.bookId,
          book,
          chapterIndex: index,
          chapterTitle: String(chapter.title ?? ''),
          chapterUrl: String(chapter.url ?? ''),
          sourceUrl,
          kind,
          signal: this.aborts.get(job.id)?.signal,
        })
        if (result.skipped) return result
        if (!result.entry) throw new Error('媒体下载未产生条目')
        // 下载期间可能被暂停/取消：绝不发布索引；取消清半成品，暂停保留断点清单。
        if (job.status !== 'running') {
          await this.discardIfCancelled(job, index)
          throw new MediaDownloadInterrupted()
        }
        await this.host.recordMediaDownload(result.entry)
        return result
      } catch (error) {
        if (error instanceof MediaDownloadInterrupted) throw error
        // DRM 等永久失败不重试：直接把原始原因抛给作业。
        if (error instanceof PermanentMediaError) throw error
        // 暂停/取消/卸载断流导致的失败不算重试次数：状态已不是 running 就直接收尾。
        if (job.status !== 'running') {
          await this.discardIfCancelled(job, index)
          throw new MediaDownloadInterrupted()
        }
        lastError = error
        if (attempt < CHAPTER_RETRY_LIMIT) {
          await sleep(this.retryBase() * 2 ** attempt)
        }
      }
    }
    throw lastError ?? new Error('媒体下载失败')
  }

  /** 暂停保留已下分片供续传；取消意味着不再继续，清掉本章目录。 */
  private async discardIfCancelled(job: MediaJob, index: number): Promise<void> {
    if (job.status !== 'cancelled') return
    await this.host.discardChapterMedia?.(job.bookId, index).catch(() => {})
  }

  private retryBase(): number {
    const base = this.host.retryBaseMs()
    return typeof base === 'number' && Number.isFinite(base) && base >= 0 ? base : DEFAULT_RETRY_BASE_MS
  }

  private touch(job: MediaJob): void {
    job.updatedAt = Date.now()
    this.scheduleWrite(job)
  }

  private scheduleWrite(job: MediaJob): void {
    if (this.pendingFlush) return
    const elapsed = Date.now() - this.lastFlush
    const wait = PROGRESS_FLUSH_MS - elapsed
    if (wait <= 0) {
      void this.write(job)
      return
    }
    this.pendingFlush = setTimeout(() => {
      this.pendingFlush = null
      void this.write(job)
    }, wait)
    this.pendingFlush.unref?.()
  }

  private async write(job: MediaJob, force = false): Promise<void> {
    if (force) {
      if (this.pendingFlush) {
        clearTimeout(this.pendingFlush)
        this.pendingFlush = null
      }
    } else {
      if (this.pendingFlush) return
      const elapsed = Date.now() - this.lastFlush
      if (elapsed < PROGRESS_FLUSH_MS) {
        this.scheduleWrite(job)
        return
      }
    }
    this.lastFlush = Date.now()
    const snapshot = { ...job }
    const db = this.host.db()
    const previous = this.writeChains.get(job.id) ?? Promise.resolve()
    const chain = previous
      .catch(() => {})
      .then(() => db.jobs.put(job.id, snapshot))
      .catch(() => {})
    this.writeChains.set(job.id, chain)
    await chain
  }
}

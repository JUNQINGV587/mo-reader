/**
 * 搜索作业（#150）：把一次搜索做成可轮询、可取消、可恢复的作业。
 *
 * - 作业复用 jobs 表，kind=search；每完成一个书源就刷新一次快照（去重合并后的书目、失败项、进度）；
 * - 快照里的 books 始终是「截至当前全部完成源」的合并结果，轮询只覆盖不追加；
 * - 取消会中断在途请求、不再启动未开始的书源，已得书目保留；
 * - 完成/取消后快照保留下一次搜索或 24 小时；服务重启后残留的进行中作业标为已中断。
 */
import { randomUUID } from 'node:crypto'
import type { BookSource } from '../core/model/source.js'
import type { SearchBook } from '../core/source/analyze.js'
import { dedupeSearchResults, type MergedSearchBook } from '../core/source/search-results.js'
import type { JobStatus } from './download.js'

/** jobs 表里的作业类型。 */
export const SEARCH_JOB_KIND = 'search'
/** 搜索作业快照保留时长：下一次搜索或 24 小时。 */
export const SEARCH_JOB_TTL_MS = 24 * 60 * 60 * 1000
/** 每次源完成后的写盘节流；轮询读内存态，不受节流影响。 */
const SEARCH_JOB_FLUSH_MS = 500
/** 搜索作业的内部并发，沿用整批搜索的上限。 */
const SEARCH_JOB_CONCURRENCY = 8

export interface SearchJobFailure {
  /** 源在本次搜索里的下标；按它升序展示，失败顺序不随完成时序跳。旧快照可能没有该字段。 */
  sourceIndex?: number
  sourceName: string
  bookSourceUrl: string
  error: string
}

/** 范围内已停用或已删除、本次没有参与抓取的书源。 */
export interface SearchJobSkipped {
  bookSourceUrl: string
  /** 书源已不存在时用 URL 兜底。 */
  sourceName: string
  reason: string
}

export interface SearchJob {
  id: string
  kind: typeof SEARCH_JOB_KIND
  bookId: string
  bookName: string
  status: JobStatus
  /** 机器可读阶段：searching/done/cancelled/failed。 */
  stage: string
  stageText: string
  key: string
  scope: string[] | null
  doneSources: number
  totalSources: number
  bookCount: number
  books: MergedSearchBook[]
  failures: SearchJobFailure[]
  skippedSources: SearchJobSkipped[]
  cancelled: boolean
  error: string
  createdAt: number
  updatedAt: number
}

/** 客户端轮询看到的快照：书目是截至当前的合并结果。 */
export interface SearchJobSnapshot {
  jobId: string
  status: JobStatus
  stageText: string
  key: string
  scope: string[] | null
  doneSources: number
  totalSources: number
  bookCount: number
  books: MergedSearchBook[]
  failures: SearchJobFailure[]
  /** 范围里已停用或已删除、本次没有参与抓取的书源。 */
  skippedSources: SearchJobSkipped[]
  cancelled: boolean
  error: string
  createdAt: number
  updatedAt: number
}

export interface SearchJobHost {
  db(): any
  /** 参与本次搜索的启用书源；scope 为 null 表示全部。 */
  listSources(scope: string[] | null): BookSource[]
  /** 抓取并解析一个书源；取消信号会中断在途请求。 */
  searchSource(source: BookSource, key: string, signal: AbortSignal): Promise<SearchBook[]>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

function isActiveStatus(status: string): boolean {
  return status === 'running' || status === 'queued' || status === 'paused'
}

/** 用函数读取状态，避免控制流收窄后把取消分支判成不可达。 */
function isCancelled(job: SearchJob): boolean {
  return job.status === 'cancelled'
}

function snapshotOf(job: SearchJob): SearchJobSnapshot {
  return {
    jobId: job.id,
    status: job.status,
    stageText: job.stageText,
    key: job.key,
    scope: job.scope ? [...job.scope] : null,
    doneSources: job.doneSources,
    totalSources: job.totalSources,
    bookCount: job.bookCount,
    books: job.books.map((book) => ({ ...book, sources: book.sources.map((source) => ({ ...source })) })),
    // 按源下标升序：失败顺序固定为搜索源顺序，不随完成时序跳；旧快照缺下标时按原顺序稳定展示。
    failures: [...job.failures]
      .sort((left, right) => (left.sourceIndex ?? 0) - (right.sourceIndex ?? 0))
      .map((failure) => ({ ...failure })),
    skippedSources: (job.skippedSources ?? []).map((item) => ({ ...item })),
    cancelled: job.cancelled,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

/** 搜索作业协调器：一个宿主一个实例，内存态负责实时轮询，jobs 表负责跨页/重启恢复。 */
export class SearchJobCoordinator {
  private readonly host: SearchJobHost
  private readonly live = new Map<string, SearchJob>()
  /** 每个源最近一次抓到的原始书目，按源下标存放；合并时按同一顺序重算，保证结果与整批搜索一致。 */
  private readonly raw = new Map<string, Array<SearchBook[] | undefined>>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly flushMs: number
  private lastPutAt = 0
  private shuttingDown = false

  constructor(host: SearchJobHost, options: { flushMs?: number } = {}) {
    this.host = host
    this.flushMs = options.flushMs ?? SEARCH_JOB_FLUSH_MS
  }

  /** 开始一次搜索：立刻返回作业号，抓取在后台进行。 */
  async start(input: { key: string; scope?: string[] | null }): Promise<SearchJobSnapshot> {
    const db = this.host.db()
    try {
      await cleanupExpiredSearchJobs(db.jobs)
    } catch {
      // 清理失败不影响本次搜索。
    }
    await this.dropFinished(db.jobs)
    // 去重后再比：范围里同一个 URL 出现多次不算多个书源。
    const scope = input.scope ? [...new Set(input.scope)] : null
    const sources = this.host.listSources(scope)
    const now = Date.now()
    const job: SearchJob = {
      id: randomUUID(),
      kind: SEARCH_JOB_KIND,
      bookId: '',
      bookName: '',
      status: 'running',
      stage: 'searching',
      stageText: '搜索中',
      key: input.key,
      scope,
      doneSources: 0,
      totalSources: sources.length,
      bookCount: 0,
      books: [],
      failures: [],
      skippedSources: this.collectSkippedSources(scope, sources),
      cancelled: false,
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    this.live.set(job.id, job)
    this.raw.set(job.id, new Array(sources.length))
    await this.put(job)
    this.launch(job, sources)
    return snapshotOf(job)
  }

  /** 读作业：内存优先，其次 jobs 表；不是搜索作业返回 null。不传 id 返回最近一次。 */
  async get(id?: string): Promise<SearchJobSnapshot | null> {
    if (id) {
      const live = this.live.get(id)
      if (live) return snapshotOf(live)
      const stored = await this.host.db()?.jobs?.get?.(id)
      if (!stored || stored.kind !== SEARCH_JOB_KIND) return null
      return snapshotOf(stored as SearchJob)
    }
    const list = await this.list()
    return list[0] ? snapshotOf(list[0]) : null
  }

  async list(): Promise<SearchJob[]> {
    const db = this.host.db()
    const records: SearchJob[] = []
    const seen = new Set<string>()
    const entries = (await (db.jobs?.entries?.() ?? [])) as Iterable<[string, SearchJob]>
    for (const [, job] of entries) {
      if (job.kind !== SEARCH_JOB_KIND) continue
      seen.add(job.id)
      records.push(this.live.get(job.id) ?? job)
    }
    for (const [id, job] of this.live) {
      if (!seen.has(id)) records.push(job)
    }
    records.sort((left, right) => right.createdAt - left.createdAt)
    return records.map((job) => ({ ...job }))
  }

  /** 取消搜索：中断在途、不再启动未开始的源，保留已得书目与快照。 */
  async cancel(id: string): Promise<SearchJobSnapshot> {
    const job = await this.requireJob(id)
    if (!isActiveStatus(job.status)) return snapshotOf(job)
    job.status = 'cancelled'
    job.stage = 'cancelled'
    job.stageText = '已取消搜索'
    job.cancelled = true
    this.live.set(job.id, job)
    await this.put(job)
    this.controllers.get(id)?.abort()
    const runner = this.runners.get(id)
    if (runner) await runner.catch(() => undefined)
    await this.put(job)
    return snapshotOf(job)
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.allSettled([...this.runners.values()])
    }
  }

  /** 宿主关闭：进行中的搜索记为已中断，保留已得快照。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const pending = [...this.live.values()].filter((job) => isActiveStatus(job.status))
    for (const job of pending) {
      job.status = 'failed'
      job.stage = 'failed'
      job.stageText = '已中断'
      job.error = '服务已关闭，搜索已中断'
      job.updatedAt = Date.now()
      this.controllers.get(job.id)?.abort()
      try {
        await this.put(job)
      } catch {
        // 关闭阶段写盘失败不再抛。
      }
    }
    await this.waitIdle()
    this.live.clear()
    this.raw.clear()
    this.runners.clear()
    this.controllers.clear()
  }

  private launch(job: SearchJob, sources: BookSource[]): void {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    const runner = this.run(job, sources, controller.signal).finally(() => {
      this.runners.delete(job.id)
      this.controllers.delete(job.id)
    })
    this.runners.set(job.id, runner)
  }

  private async run(job: SearchJob, sources: BookSource[], signal: AbortSignal): Promise<void> {
    const slots = this.raw.get(job.id) ?? new Array<SearchBook[] | undefined>(sources.length)
    this.raw.set(job.id, slots)
    let cancelled = false
    let cursor = 0
    const worker = async () => {
      for (;;) {
        // 每取一个源之前检查取消：未开始的书源不再发请求。
        if (isCancelled(job) || signal.aborted) {
          cancelled = true
          return
        }
        const index = cursor
        cursor += 1
        if (index >= sources.length) return
        const source = sources[index]!
        try {
          slots[index] = await this.host.searchSource(source, job.key, signal)
        } catch (error) {
          if (isCancelled(job) || signal.aborted || isAbortError(error)) {
            cancelled = true
            return
          }
          slots[index] = []
          job.failures.push({
            sourceIndex: index,
            sourceName: source.bookSourceName || source.bookSourceUrl,
            bookSourceUrl: source.bookSourceUrl,
            error: errorMessage(error),
          })
        }
        job.doneSources += 1
        this.refresh(job, slots)
        try {
          await this.progress(job)
        } catch {
          // 中途写盘失败不打断搜索，完成时还会再写一次。
        }
      }
    }

    try {
      if (sources.length > 0) {
        await Promise.all(
          Array.from({ length: Math.min(SEARCH_JOB_CONCURRENCY, sources.length) }, () => worker()),
        )
      }
      this.refresh(job, slots)
      if (cancelled || signal.aborted || isCancelled(job)) {
        if (!this.shuttingDown) {
          job.status = 'cancelled'
          job.stage = 'cancelled'
          job.stageText = '已取消搜索'
          job.cancelled = true
        }
      } else {
        job.status = 'done'
        job.stage = 'done'
        job.stageText = job.failures.length > 0 ? `搜索完成，失败 ${job.failures.length} 源` : '搜索完成'
        job.cancelled = false
      }
      await this.put(job)
    } catch (error) {
      if (!isCancelled(job) && !signal.aborted) {
        job.status = 'failed'
        job.stage = 'failed'
        job.stageText = '搜索失败'
        job.error = errorMessage(error)
        job.cancelled = false
        this.refresh(job, slots)
        await this.put(job).catch(() => undefined)
      }
    } finally {
      this.raw.delete(job.id)
    }
  }

  /** 按源下标顺序合并，保证与一次性整批搜索的去重顺序和结果一致。 */
  private refresh(job: SearchJob, slots: Array<SearchBook[] | undefined>): void {
    const books: SearchBook[] = []
    for (const slot of slots) {
      if (slot) books.push(...slot)
    }
    job.books = dedupeSearchResults(books)
    job.bookCount = job.books.length
  }

  /** 范围里已停用或已删除的书源：只记入 skipped 提示，不参与抓取也不计入总源数。 */
  private collectSkippedSources(scope: string[] | null, sources: BookSource[]): SearchJobSkipped[] {
    if (!scope) return []
    const available = new Set(sources.map((source) => source.bookSourceUrl))
    const skipped: SearchJobSkipped[] = []
    for (const url of scope) {
      if (!url || available.has(url)) continue
      skipped.push({ bookSourceUrl: url, sourceName: url, reason: '书源已停用或已删除' })
    }
    return skipped
  }

  private async dropFinished(jobs: any): Promise<void> {
    if (!jobs || typeof jobs.entries !== 'function') return
    const expired: string[] = []
    for (const [id, job] of (await jobs.entries()) as Iterable<[string, any]>) {
      if (job?.kind !== SEARCH_JOB_KIND) continue
      if (isActiveStatus(String(job.status))) continue
      expired.push(id)
    }
    for (const id of expired) {
      await jobs.delete(id)
      this.live.delete(id)
      this.raw.delete(id)
    }
  }

  private async requireJob(id: string): Promise<SearchJob> {
    const live = this.live.get(id)
    if (live) return live
    const stored = await this.host.db()?.jobs?.get?.(id)
    if (!stored) throw new Error('搜索作业不存在')
    if (stored.kind !== SEARCH_JOB_KIND) throw new Error('作业不是搜索作业')
    return { ...(stored as SearchJob) }
  }

  private async put(job: SearchJob): Promise<void> {
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.host.db().jobs.put(job.id, { ...job })
    this.lastPutAt = job.updatedAt
  }

  private async progress(job: SearchJob, force = false): Promise<void> {
    if (!force && Date.now() - this.lastPutAt < this.flushMs) return
    await this.put(job)
  }
}

/** 宿主重启后把残留的进行中搜索标为已中断；保留已得书目。 */
export async function recoverInterruptedSearchJobs(jobs: any, now = Date.now()): Promise<number> {
  if (!jobs || typeof jobs.entries !== 'function') return 0
  let recovered = 0
  for (const [id, job] of (await jobs.entries()) as Iterable<[string, any]>) {
    if (job?.kind !== SEARCH_JOB_KIND) continue
    if (!isActiveStatus(String(job.status))) continue
    await jobs.put(id, {
      ...job,
      status: 'failed',
      stage: 'failed',
      stageText: '已中断',
      cancelled: false,
      error: '服务重启，搜索已中断',
      updatedAt: now,
    })
    recovered += 1
  }
  return recovered
}

/** 清理超过保留时长的搜索作业快照；进行中的不清理。 */
export async function cleanupExpiredSearchJobs(jobs: any, now = Date.now()): Promise<number> {
  if (!jobs || typeof jobs.entries !== 'function') return 0
  const cutoff = now - SEARCH_JOB_TTL_MS
  const expired: string[] = []
  for (const [id, job] of (await jobs.entries()) as Iterable<[string, any]>) {
    if (job?.kind !== SEARCH_JOB_KIND) continue
    if (isActiveStatus(String(job.status))) continue
    if ((Number(job.updatedAt) || 0) >= cutoff) continue
    expired.push(id)
  }
  for (const id of expired) await jobs.delete(id)
  return expired.length
}
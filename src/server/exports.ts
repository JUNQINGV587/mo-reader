import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ChapterLimiter, isActiveJob, type JobStatus } from './download.js'
import { buildEpub, type EpubCover } from './epub-export.js'
import { buildPdf, type PdfCover } from './pdf-export.js'

/** 导出作业的 kind：与下载作业共用 jobs 表，靠它区分。 */
export const EXPORT_KIND = 'export'
/** 产物保留 24 小时，过期在服务启动时与每次导出前清理。 */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000
/** 导出并发：与下载共用上限思路，单源更保守。 */
export const EXPORT_CONCURRENCY = 4
export const EXPORT_SOURCE_CONCURRENCY = 2
/** 进度落盘的节流窗口；没有定时器，只在章节收尾时按需写一次。 */
export const EXPORT_FLUSH_MS = 500
/** 界面直接列出的失败章节条数上限；超过这个数的完整清单另存文件。 */
export const EXPORT_FAILED_LIMIT = 100
/** 章节级临时状态目录后缀：<jobId>.parts/，暂停后继续时用它跳过已抓到的章节。 */
export const EXPORT_PARTS_SUFFIX = '.parts'
/** 失败章节完整清单的文件后缀：<jobId>.failed.txt。 */
export const EXPORT_FAILED_FILE_SUFFIX = '.failed.txt'

export type ExportFormat = 'txt' | 'epub' | 'pdf'

export interface ExportJob {
  id: string
  kind: string
  bookId: string
  bookName: string
  status: JobStatus
  format: ExportFormat
  /** 浏览器下载时展示的文件名，不含路径。 */
  fileName: string
  /** 相对导出目录的文件名，受保护路由只认它；未完成时为空。 */
  filePath: string
  /** 产物字节数；导出过程中是已拼正文的累计字节。 */
  size: number
  /** 导出失败的章节名（最多 EXPORT_FAILED_LIMIT 条），完成后供界面列出「哪些章没导出」。 */
  failedChapters: string[]
  /** 失败章节数超过展示上限时为真：界面据此说明清单被截断，完整清单在 failedListFile。 */
  failedTruncated: boolean
  /** 完整失败清单（相对导出目录的单段文件名）；只有失败数超过展示上限时才写。 */
  failedListFile: string
  /** 字体预留字段：#107 起排版类导出按它取字体。 */
  fontId: string
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

export interface ExportChapter {
  title?: string
  url?: string
  isVolume?: boolean
}

export interface ExportHost {
  db(): any
  loadToc(book: Record<string, unknown>): Promise<ExportChapter[]>
  /** 取一章正文：缓存优先，未缓存时在线抓取；非文本或空正文应抛错，由协调器计失败。 */
  readChapter(book: Record<string, unknown>, chapterIndex: number, chapter: ExportChapter): Promise<string>
  /** 可选：取封面用于嵌入 EPUB / PDF；返回 null 或抛错都按无封面继续导出。 */
  loadCover?(book: Record<string, unknown>): Promise<EpubCover | null>
  /** 可选：按字体 id 取用户已上传的中文字体，PDF 导出必须在启动前校验可嵌入。 */
  loadFont?(fontId: string): Promise<{ data: Buffer; format: string }>
}

export interface ExportListFilter {
  bookId?: string
  kind?: string
  status?: string
}

/** 导出目录：环境变量优先，默认与文字缓存并列放在读者数据目录下。 */
export function exportRoot(): string {
  const configured = process.env.MO_READER_EXPORT_ROOT
  if (configured && configured.trim()) return configured.trim()
  return join(homedir(), '.dsh', 'reader', 'exports')
}

export async function ensureExportRoot(): Promise<string> {
  const root = exportRoot()
  await mkdir(root, { recursive: true })
  return root
}

/** 产物落在导出目录里的唯一文件名（只含巴斯名，路由据此做穿越检查）。 */
export function exportArtifactName(jobId: string, format: ExportFormat): string {
  return `${jobId}.${format}`
}

/** 章节级临时状态目录：每次导出按作业 id 隔离，暂停后继续时先查它。 */
export function exportPartsDir(jobId: string): string {
  return join(exportRoot(), `${jobId}${EXPORT_PARTS_SUFFIX}`)
}

/** 失败章节完整清单的文件名（相对导出目录）。 */
export function exportFailedFileName(jobId: string): string {
  return `${jobId}${EXPORT_FAILED_FILE_SUFFIX}`
}

/** 单章临时状态：标题、正文与章节地址，够续跑时直接复用，不必回读缓存或联网。 */
interface ExportPart {
  title: string
  text: string
  /** 抓取时的章节地址；续跑时用来确认目录没换，避免按序号串章。 */
  url: string
}

/**
 * 读已抓到的章节；没有、损坏、形状不对或章节地址已经变了都当没抓到，本次重新抓。
 * 地址对不上说明这一轮的目录和落盘时不同，宁可重抓也不能把别人的正文拼进去。
 */
async function readChapterPart(jobId: string, index: number, url: string): Promise<ExportPart | null> {
  try {
    const raw = await readFile(join(exportPartsDir(jobId), `${index}.json`), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ExportPart>
    if (typeof parsed?.text !== 'string' || !parsed.text) return null
    if (parsed.url !== url) return null
    return { title: String(parsed.title ?? ''), text: parsed.text, url }
  } catch {
    return null
  }
}

async function writeChapterPart(jobId: string, index: number, part: ExportPart): Promise<void> {
  const dir = exportPartsDir(jobId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${index}.json`), JSON.stringify(part), 'utf8')
}

async function removeFailedList(jobId: string): Promise<void> {
  try {
    await rm(join(exportRoot(), exportFailedFileName(jobId)), { force: true })
  } catch {
    // 删不掉就交给 24 小时过期清理。
  }
}

async function removeChapterParts(jobId: string): Promise<void> {
  try {
    await rm(exportPartsDir(jobId), { recursive: true, force: true })
  } catch {
    // 删不掉就交给 24 小时过期清理。
  }
}

/** 下载名的公共清洗：去掉路径分隔符与非法字符，保留中文书名。 */
function cleanDownloadName(bookName: string): string {
  const cleaned = String(bookName || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
  return (cleaned || '未命名').slice(0, 80)
}

/** 浏览器下载名：去掉路径分隔符与非法字符，保留中文书名。 */
export function exportFileName(bookName: string, format: ExportFormat): string {
  return `${cleanDownloadName(bookName)}.${format}`
}

/** 失败清单的下载名：和主产物一样用书名，别把作业 id 甩给用户。 */
export function exportFailedDisplayName(bookName: string): string {
  return `${cleanDownloadName(bookName)}-失败章节.txt`
}

export function contentTypeOf(format: string): string {
  if (format === 'txt') return 'text/plain; charset=utf-8'
  if (format === 'epub') return 'application/epub+zip'
  if (format === 'pdf') return 'application/pdf'
  return 'application/octet-stream'
}

/** 产物文件名必须是导出目录下的单段文件名，任何分隔符都视为非法。 */
export function isArtifactFileName(filePath: string): boolean {
  if (!filePath || filePath === '.' || filePath === '..') return false
  if (filePath.includes('/') || filePath.includes('\\') || filePath.includes('\0')) return false
  if (filePath.length > 200) return false
  return /^[0-9a-zA-Z._-]+$/.test(filePath)
}

export async function exportArtifactExists(filePath: string): Promise<boolean> {
  if (!isArtifactFileName(filePath)) return false
  try {
    const info = await stat(join(exportRoot(), filePath))
    return info.isFile()
  } catch {
    return false
  }
}

/**
 * 清掉过期产物与过期作业记录（已完成/失败/取消且超过 24 小时）。
 * 由服务 init 调一次、每次导出前再调一次；不启后台定时器，不拖住宿主退出。
 */
export async function cleanupExpiredExports(jobs?: any, now = Date.now()): Promise<{ files: number; jobs: number }> {
  const cutoff = now - EXPORT_TTL_MS
  let files = 0
  let removedJobs = 0
  try {
    const root = exportRoot()
    const entries = await readdir(root)
    for (const name of entries) {
      const target = join(root, name)
      try {
        const info = await stat(target)
        if (info.mtimeMs >= cutoff) continue
        await rm(target, { recursive: true, force: true })
        files += 1
      } catch {
        // 单个产物删不掉不影响其余清理。
      }
    }
  } catch {
    // 还没导出过：目录不存在，无需清理。
  }
  if (jobs && typeof jobs.entries === 'function') {
    const expired: string[] = []
    for (const [id, record] of jobs.entries()) {
      const job = record as ExportJob
      if (job?.kind !== EXPORT_KIND) continue
      if (isActiveJob(job.status)) continue
      if (Number(job.updatedAt ?? 0) >= cutoff) continue
      expired.push(id)
    }
    for (const id of expired) {
      try {
        await jobs.delete(id)
        removedJobs += 1
      } catch {
        // 作业记录删不掉就留给下一轮清理。
      }
    }
  }
  return { files, jobs: removedJobs }
}

export class ExportCoordinator {
  private readonly live = new Map<string, ExportJob>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly lastPut = new Map<string, number>()

  constructor(private readonly host: ExportHost) {}

  async start(
    bookId: string,
    format: ExportFormat,
    options: { fontId?: string } = {},
  ): Promise<{ job: ExportJob; existing: boolean }> {
    const db = this.host.db()
    const book = db.books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    const existing = this.findActive(bookId, format)
    if (existing) return { job: { ...existing }, existing: true }
    // 顺手清理过期产物：不需要额外定时器，导出频率就是清理频率。
    try {
      await cleanupExpiredExports(db.jobs)
    } catch {
      // 清理失败不影响本次导出。
    }
    const now = Date.now()
    const job: ExportJob = {
      id: randomUUID(),
      kind: EXPORT_KIND,
      bookId,
      bookName: String(book.name ?? ''),
      status: 'queued',
      format,
      fileName: exportFileName(String(book.name ?? ''), format),
      filePath: '',
      size: 0,
      failedChapters: [],
      failedTruncated: false,
      failedListFile: '',
      fontId: format === 'pdf' ? String(options.fontId ?? '') : '',
      fromIndex: 0,
      toIndex: 0,
      all: true,
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    this.live.set(job.id, job)
    await this.put(job)
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

  /** 运行中的内存快照；finished 后会从内存移除，故返回 undefined。 */
  peek(id: string): ExportJob | undefined {
    return this.live.get(id)
  }

  get(id: string) {
    return { job: { ...this.requireJob(id) } }
  }

  list(filter: ExportListFilter = {}): ExportJob[] {
    const jobs: ExportJob[] = []
    for (const [id, record] of this.host.db().jobs.entries()) {
      const job = (this.live.get(id) ?? record) as ExportJob
      if (job?.kind !== EXPORT_KIND) continue
      if (filter.bookId && job.bookId !== filter.bookId) continue
      if (filter.kind && filter.kind !== EXPORT_KIND) continue
      if (filter.status && job.status !== filter.status) continue
      jobs.push({ ...job })
    }
    jobs.sort((left, right) => (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0))
    return jobs
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size) {
      await Promise.allSettled([...this.runners.values()])
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
      await this.put(job)
    }
    await this.waitIdle()
  }

  private async stop(id: string, status: 'paused' | 'cancelled') {
    const job = this.requireJob(id)
    if (!isActiveJob(job.status) || job.status === status) return { job: { ...job } }
    job.status = status
    job.updatedAt = Date.now()
    if (status === 'cancelled') {
      // 取消是终态：暂停留下的章节级临时状态没有「继续」可用了，就地清掉。
      // 还在跑的协程收尾时会再清一次，重复删除是幂等的。
      await this.removeArtifactFile(job)
      await removeChapterParts(id)
      await removeFailedList(id)
    }
    await this.put(job)
    return { job: { ...job } }
  }

  private async restart(id: string) {
    const job = this.requireJob(id)
    if (job.status === 'running' || job.status === 'queued') return { job: { ...job } }
    const runner = this.runners.get(id)
    if (runner) await runner.catch(() => {})
    const current = this.requireJob(id)
    current.status = 'queued'
    current.error = ''
    current.updatedAt = Date.now()
    await this.put(current)
    this.launch(id)
    return { job: { ...current } }
  }

  private requireJob(id: string): ExportJob {
    const existing = this.live.get(id) ?? (this.host.db().jobs.get(id) as ExportJob | undefined)
    if (!existing) throw new Error('作业不存在')
    if (existing.kind !== EXPORT_KIND) throw new Error('作业不是导出作业')
    this.live.set(id, existing)
    return existing
  }

  private findActive(bookId: string, format: ExportFormat): ExportJob | undefined {
    const candidates: ExportJob[] = []
    for (const [id, record] of this.host.db().jobs.entries()) {
      const job = (this.live.get(id) ?? record) as ExportJob
      if (job?.kind !== EXPORT_KIND || job.bookId !== bookId) continue
      if (String(job.format ?? 'txt') !== format) continue
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
    const job = this.live.get(id)
    if (!job || job.status !== 'queued') return
    const db = this.host.db()
    const book = db.books.get(job.bookId) as Record<string, unknown> | undefined
    if (!book) {
      await this.finish(job, 'failed', '书不存在')
      return
    }
    let chapters: ExportChapter[]
    try {
      chapters = await this.host.loadToc(book)
    } catch (error) {
      await this.finish(job, 'failed', errorMessage(error))
      return
    }
    // 重新开始（继续/重试）时先删掉上一次的产物与失败清单，避免新旧内容混淆；
    // 清掉记录里的文件名后，磁盘上的旧清单就成了没人引用的孤儿，只等 24 小时清理。
    await this.removeArtifactFile(job)
    await removeFailedList(job.id)
    job.status = 'running'
    job.error = ''
    job.total = chapters.length
    job.fromIndex = 0
    job.toIndex = Math.max(0, chapters.length - 1)
    job.completed = 0
    job.failed = 0
    job.failedChapters = []
    job.failedTruncated = false
    job.failedListFile = ''
    job.skipped = 0
    job.bytes = 0
    job.updatedAt = Date.now()
    await this.put(job)

    const sourceUrl = String(book.origin ?? '')
    const limiter = new ChapterLimiter(EXPORT_CONCURRENCY, EXPORT_SOURCE_CONCURRENCY)
    const texts: Array<{ title: string; text: string } | null> = new Array(chapters.length).fill(null)
    /** 全部失败章节（按目录序号）；超过展示上限时收尾写进失败清单文件。 */
    const failedAll: Array<{ index: number; title: string }> = []
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        if (job.status !== 'running') return
        const index = nextIndex
        nextIndex += 1
        if (index >= chapters.length) return
        const chapter = chapters[index]!
        if (!chapter || chapter.isVolume || !chapter.url) {
          job.skipped += 1
          await this.progress(job)
          continue
        }
        // 续跑：上一轮抓到的章节已在章节级临时状态里，直接复用，不联网也不再占并发名额。
        const reused = await readChapterPart(job.id, index, chapter.url)
        if (reused) {
          texts[index] = reused
          job.completed += 1
          job.bytes += Buffer.byteLength(reused.text, 'utf8')
          await this.progress(job)
          continue
        }
        await limiter.acquire(sourceUrl)
        try {
          if (job.status !== 'running') return
          const text = await this.host.readChapter(book, index, chapter)
          if (job.status !== 'running') return
          const entry = { title: String(chapter.title ?? ''), text, url: chapter.url }
          texts[index] = entry
          job.completed += 1
          job.bytes += Buffer.byteLength(text, 'utf8')
          // 写临时状态是续跑的依据；写失败只影响续跑，不能让这一章计失败。
          try {
            await writeChapterPart(job.id, index, entry)
          } catch {
            // 磁盘写不进去时照常导出，下次从头抓。
          }
        } catch {
          // 单章失败只计数，不中止整本导出；记下章节名，完成后界面能说清哪些章没导出。
          const title = String(chapter.title || `第 ${index + 1} 章`)
          job.failed += 1
          failedAll.push({ index, title })
          if (job.failedChapters.length < EXPORT_FAILED_LIMIT) job.failedChapters.push(title)
        } finally {
          limiter.release(sourceUrl)
        }
        await this.progress(job)
      }
    }
    const workers: Array<Promise<void>> = []
    const workerCount = Math.max(1, Math.min(EXPORT_CONCURRENCY, Math.max(1, chapters.length)))
    for (let index = 0; index < workerCount; index += 1) workers.push(worker())
    try {
      await Promise.all(workers)
      if (job.status === 'running') await this.assemble(job, book, texts)
    } catch (error) {
      if (job.status === 'running') {
        job.status = 'failed'
        job.error = errorMessage(error)
      }
    }
    await this.recordFailedList(job, failedAll)
    await this.finish(job)
  }

  /**
   * 失败章节超过展示上限时，把完整清单落成导出目录里的一个文本文件：
   * jobs 表里的 failedChapters 保持有限条数，界面靠 failedListFile 给出可定位的完整清单。
   * 只有 done / failed 这两个终态写：暂停还要继续、取消已经没有产物可对照。
   */
  private async recordFailedList(job: ExportJob, failed: Array<{ index: number; title: string }>): Promise<void> {
    if (job.status !== 'done' && job.status !== 'failed') return
    if (failed.length <= EXPORT_FAILED_LIMIT) {
      job.failedTruncated = false
      job.failedListFile = ''
      // 上一次导出可能留下过清单：重导出后失败数没超上限，旧清单必须一起清掉。
      await removeFailedList(job.id)
      return
    }
    const name = exportFailedFileName(job.id)
    // 一行一章，按目录顺序排：失败是按完成先后记的，不排序的话清单顺序随并发变化。
    // 章节名里的换行与制表符会把清单解析错位，落盘前统一压成空格。
    const body =
      [...failed]
        .sort((left, right) => left.index - right.index)
        .map((entry) => `${entry.index + 1}\t${String(entry.title).replace(/[\t\r\n]+/g, ' ')}`)
        .join('\n') + '\n'
    try {
      await ensureExportRoot()
      await writeFile(join(exportRoot(), name), body, 'utf8')
      job.failedTruncated = true
      job.failedListFile = name
    } catch {
      // 清单落盘失败只是少了一份定位材料，导出本身照常收尾。
      job.failedTruncated = false
      job.failedListFile = ''
    }
    job.updatedAt = Date.now()
  }

  /** 按格式构建产物：TXT 与旧 exportBook 的产物保持一致，EPUB 见 assembleEpub。 */
  private async assemble(
    job: ExportJob,
    book: Record<string, unknown>,
    texts: Array<{ title: string; text: string } | null>,
  ): Promise<void> {
    if (job.format === 'epub') return this.assembleEpub(job, book, texts)
    if (job.format === 'pdf') return this.assemblePdf(job, book, texts)
    return this.assembleTxt(job, book, texts)
  }

  /** 按目录顺序拼接正文并落盘；格式与旧 exportBook 的 TXT 产物保持一致。 */
  private async assembleTxt(
    job: ExportJob,
    book: Record<string, unknown>,
    texts: Array<{ title: string; text: string } | null>,
  ): Promise<void> {
    const parts: string[] = []
    for (const entry of texts) {
      if (!entry) continue
      const title = entry.title || `第${parts.length + 1}章`
      parts.push(`${title}\n\n${entry.text}`)
    }
    if (!parts.length) {
      job.status = 'failed'
      job.error = job.failed > 0 ? '全部章节导出失败' : '没有可导出的章节'
      return
    }
    const body = `${String(book.name || '未命名')}\n作者：${String(book.author || '')}\n\n${parts.join('\n\n')}`
    const root = await ensureExportRoot()
    const relative = exportArtifactName(job.id, job.format)
    const absolute = join(root, relative)
    await writeFile(absolute, body, 'utf8')
    const info = await stat(absolute)
    job.filePath = relative
    job.fileName = exportFileName(String(book.name || ''), job.format)
    job.size = info.size
    job.bytes = info.size
    job.status = 'done'
    job.error = ''
  }

  /** EPUB3 全本：导航只列有正文的章节，能取到封面就嵌入，取不到照常成书。 */
  private async assembleEpub(
    job: ExportJob,
    book: Record<string, unknown>,
    texts: Array<{ title: string; text: string } | null>,
  ): Promise<void> {
    const chapters: Array<{ title: string; text: string }> = []
    for (const entry of texts) {
      if (!entry) continue
      chapters.push({ title: entry.title || `第${chapters.length + 1}章`, text: entry.text })
    }
    if (!chapters.length) {
      job.status = 'failed'
      job.error = job.failed > 0 ? '全部章节导出失败' : '没有可导出的章节'
      return
    }
    let cover: EpubCover | null = null
    if (this.host.loadCover) {
      try {
        cover = await this.host.loadCover(book)
      } catch {
        // 封面只是加分项：抓取失败按无封面继续导出。
        cover = null
      }
    }
    const data = await buildEpub({
      title: String(book.name || '未命名'),
      author: String(book.author || ''),
      chapters,
      cover,
    })
    const root = await ensureExportRoot()
    const relative = exportArtifactName(job.id, job.format)
    const absolute = join(root, relative)
    await writeFile(absolute, data)
    const info = await stat(absolute)
    job.filePath = relative
    job.fileName = exportFileName(String(book.name || ''), job.format)
    job.size = info.size
    job.bytes = info.size
    job.status = 'done'
    job.error = ''
  }

  /**
   * PDF 全本：A5 版心、章节标题与页码、中文字体子集内嵌；
   * 封面可选（PDFKit 只认 JPEG/PNG，webp 直接跳过），无封面不影响成书。
   */
  private async assemblePdf(
    job: ExportJob,
    book: Record<string, unknown>,
    texts: Array<{ title: string; text: string } | null>,
  ): Promise<void> {
    const chapters: Array<{ title: string; text: string }> = []
    for (const entry of texts) {
      if (!entry) continue
      chapters.push({ title: entry.title || `第${chapters.length + 1}章`, text: entry.text })
    }
    if (!chapters.length) {
      job.status = 'failed'
      job.error = job.failed > 0 ? '全部章节导出失败' : '没有可导出的章节'
      return
    }
    if (!this.host.loadFont) {
      job.status = 'failed'
      job.error = '请先上传中文字体'
      return
    }
    let font: { data: Buffer; format: string }
    try {
      font = await this.host.loadFont(job.fontId)
    } catch {
      // 字体在排队期间被删掉时也不生成半成品。
      job.status = 'failed'
      job.error = '请先上传中文字体'
      return
    }
    let cover: PdfCover | null = null
    if (this.host.loadCover) {
      try {
        cover = await this.host.loadCover(book)
      } catch {
        // 封面只是加分项：抓取失败按无封面继续导出。
        cover = null
      }
    }
    const data = await buildPdf({
      title: String(book.name || '未命名'),
      author: String(book.author || ''),
      chapters,
      font: font.data,
      cover,
    })
    const root = await ensureExportRoot()
    const relative = exportArtifactName(job.id, job.format)
    const absolute = join(root, relative)
    await writeFile(absolute, data)
    const info = await stat(absolute)
    job.filePath = relative
    job.fileName = exportFileName(String(book.name || ''), job.format)
    job.size = info.size
    job.bytes = info.size
    job.status = 'done'
    job.error = ''
  }

  private async finish(job: ExportJob, status?: JobStatus, error?: string): Promise<void> {
    if (status) {
      job.status = status
      if (error !== undefined) job.error = error
    }
    if (job.status === 'running') {
      job.status = 'failed'
      job.error = job.error || '导出未完成'
    }
    job.updatedAt = Date.now()
    await this.put(job)
    // 暂停要把章节级临时状态留给「继续」；其它终态一律清掉，导出目录不留残留。
    if (job.status !== 'paused') await removeChapterParts(job.id)
    this.live.delete(job.id)
    this.lastPut.delete(job.id)
  }

  private async progress(job: ExportJob): Promise<void> {
    const last = this.lastPut.get(job.id) ?? 0
    if (Date.now() - last < EXPORT_FLUSH_MS) return
    job.updatedAt = Date.now()
    await this.put(job)
  }

  private async put(job: ExportJob): Promise<void> {
    this.lastPut.set(job.id, Date.now())
    try {
      await this.host.db().jobs.put(job.id, { ...job })
    } catch {
      // 进度落盘失败不打断导出，下一次落盘会带上最新进度。
    }
  }

  private async removeArtifactFile(job: ExportJob): Promise<void> {
    const relative = job.filePath
    job.filePath = ''
    job.size = 0
    if (!relative || !isArtifactFileName(relative)) return
    try {
      await rm(join(exportRoot(), relative), { force: true })
    } catch {
      // 删不掉就交给 24 小时过期清理。
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '未知错误')
}

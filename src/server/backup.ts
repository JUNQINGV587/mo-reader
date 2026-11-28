/**
 * 整包备份导出（#130）：把书架数据与封面打成单个 zip，经一次性链接下载。
 *
 * 复用 jobs 表承载阶段进度与取消，产物与临时目录都在导出目录下：
 * - 阶段进度按 stage/completed/total 记录，前端直接展示；
 * - 每类数据先逐条写进临时 JSON 文件，再流式压进 zip，避免把整个书架拼成大字符串；
 * - 取消会删掉半成品 zip 与临时目录，不留残余；
 * - 下载 token 只能用一次，10 分钟过期，URL 里不含作业 id。
 *
 * 导入（#132）只需复用 ../core/reader/backup.js 的 manifest 校验与合并函数。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import JSZip from 'jszip'
import {
  BACKUP_COVERS_DIR,
  BACKUP_MANIFEST_FILE,
  BACKUP_MAX_COVER_BYTES,
  BACKUP_MAX_COVERS_TOTAL_BYTES,
  BACKUP_SECTION_FILES,
  BACKUP_TOKEN_TTL_MS,
  backupCoverEntry,
  backupFileName,
  backupSectionsFor,
  buildBackupManifest,
  coverBudgetAllows,
  type BackupCoverSummary,
  type BackupSection,
  type BackupSectionCounts,
} from '../core/reader/backup.js'
import { VERSION } from '../core/version.js'
import type { EpubCover } from './epub-export.js'
import type { JobStatus } from './download.js'
import { ensureExportRoot, exportRoot, isArtifactFileName } from './exports.js'

/** jobs 表里的作业类型。 */
export const BACKUP_KIND = 'backup'
/** 产物扩展名；落盘文件名是 <jobId>.zip，展示名带日期。 */
export const BACKUP_ARTIFACT_SUFFIX = '.zip'
/** 章节式临时目录后缀，与导出的 .parts 区分开，互不影响。 */
export const BACKUP_TEMP_SUFFIX = '.backup.parts'
/** 进度落盘节流间隔。 */
const BACKUP_FLUSH_MS = 500
/** 备份作业记录保留时长；产物由导出目录的统一定时清理负责。 */
export const BACKUP_JOB_TTL_MS = 24 * 60 * 60 * 1000

const BACKUP_CONTENT_TYPE = 'application/zip'

export interface BackupHost {
  db(): any
  loadCover(book: any): Promise<EpubCover | null>
}

export interface BackupJob {
  id: string
  kind: typeof BACKUP_KIND
  bookId: string
  bookName: string
  status: JobStatus
  /** true = 只导书目与进度。 */
  light: boolean
  /** 机器可读的阶段名，如 'bookshelf'、'covers'、'packing'。 */
  stage: string
  /** 阶段的人话说明，界面直接展示。 */
  stageText: string
  /** 阶段总数；每完成一个阶段 completed +1。 */
  total: number
  completed: number
  failed: number
  skipped: number
  /** 产物字节数。 */
  bytes: number
  /** 已写入的记录条数。 */
  records: number
  covers: number
  skippedCovers: number
  coverBytes: number
  /** 下载时展示的文件名（带日期）。 */
  fileName: string
  /** 相对导出目录的产物文件名（jobId.zip）。 */
  filePath: string
  error: string
  createdAt: number
  updatedAt: number
}

interface Ticket {
  jobId: string
  filePath: string
  fileName: string
  expiresAt: number
  used: boolean
}

export interface BackupDownloadTicket {
  token: string
  expiresAt: number
}

export type BackupTicketResult =
  | { descriptor: { filePath: string; fileName: string; contentType: string } }
  | { error: { status: number; message: string } }

/** 一次性下载链接：内存里记 token，取一次即失效。 */
export class BackupTicketStore {
  private readonly tickets = new Map<string, Ticket>()

  /** 给已完成的作业发新 token；同一作业只会有一个有效 token。 */
  issue(job: BackupJob, now = Date.now()): BackupDownloadTicket | null {
    if (job.status !== 'done' || !job.filePath) return null
    this.dropForJob(job.id)
    const token = randomBytes(32).toString('hex')
    this.tickets.set(token, {
      jobId: job.id,
      filePath: job.filePath,
      fileName: job.fileName || backupFileName(new Date(job.createdAt)),
      expiresAt: now + BACKUP_TOKEN_TTL_MS,
      used: false,
    })
    return { token, expiresAt: now + BACKUP_TOKEN_TTL_MS }
  }

  /** 校验并消费 token：先到先得，用过一次就再也不能下载。 */
  consume(token: string, now = Date.now()): BackupTicketResult {
    const entry = this.tickets.get(String(token ?? ''))
    if (!entry) return { error: { status: 404, message: '下载链接无效' } }
    if (entry.used) return { error: { status: 410, message: '下载链接已使用，请重新生成' } }
    if (entry.expiresAt <= now) return { error: { status: 410, message: '下载链接已过期，请重新生成' } }
    entry.used = true
    return { descriptor: { filePath: entry.filePath, fileName: entry.fileName, contentType: BACKUP_CONTENT_TYPE } }
  }

  /** 清掉过期条目，避免无限增长。 */
  sweep(now = Date.now()): void {
    for (const [token, entry] of this.tickets) {
      if (entry.expiresAt + BACKUP_TOKEN_TTL_MS <= now) this.tickets.delete(token)
    }
  }

  clear(): void {
    this.tickets.clear()
  }

  /** 删产物后立刻作废该作业的旧下载链接，避免点旧链接打开半份文件。 */
  revoke(jobId: string): void {
    this.dropForJob(jobId)
  }

  private dropForJob(jobId: string): void {
    for (const [token, entry] of this.tickets) {
      if (entry.jobId === jobId) this.tickets.delete(token)
    }
  }
}

/** 取消信号：不是错误，收尾时不需要展示成失败。 */
class BackupAbort extends Error {
  constructor(readonly status: JobStatus) {
    super('备份已取消')
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running'
}

function backupArtifactName(jobId: string): string {
  return `${jobId}${BACKUP_ARTIFACT_SUFFIX}`
}

function backupTempDir(jobId: string): string {
  return join(exportRoot(), `${jobId}${BACKUP_TEMP_SUFFIX}`)
}

export interface BackupCoordinatorOptions {
  /** 进度落盘节流，测试可调小。 */
  flushMs?: number
}

/** 备份协调器：一个宿主一个实例，作业状态都落在 jobs 表。 */
export class BackupCoordinator {
  readonly tickets = new BackupTicketStore()
  private readonly host: BackupHost
  private readonly live = new Map<string, BackupJob>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly flushMs: number
  private lastPutAt = 0
  private lastPutJob: BackupJob | null = null
  private shuttingDown = false

  constructor(host: BackupHost, options: BackupCoordinatorOptions = {}) {
    this.host = host
    this.flushMs = options.flushMs ?? BACKUP_FLUSH_MS
  }

  /** 开始一次备份；已有进行中的备份时返回 existing，不重复开工。 */
  async start(input: { light?: boolean } = {}): Promise<{ job: BackupJob; existing: boolean }> {
    const db = this.host.db()
    const active = this.findActive()
    if (active) return { job: { ...active }, existing: true }
    try {
      await cleanupExpiredBackups(db.jobs)
    } catch {
      // 清理失败不影响本次备份。
    }
    const now = Date.now()
    const light = input.light === true
    const job: BackupJob = {
      id: randomUUID(),
      kind: BACKUP_KIND,
      bookId: '',
      bookName: '',
      status: 'queued',
      light,
      stage: 'prepare',
      stageText: '准备数据',
      total: backupSectionsFor(light).length + (light ? 0 : 1) + 2,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      records: 0,
      covers: 0,
      skippedCovers: 0,
      coverBytes: 0,
      fileName: backupFileName(new Date(now)),
      filePath: '',
      error: '',
      createdAt: now,
      updatedAt: now,
    }
    this.live.set(job.id, job)
    await this.put(job)
    this.launch(job)
    return { job: { ...job }, existing: false }
  }

  peek(id: string): BackupJob | null {
    const job = this.live.get(id)
    return job ? { ...job } : null
  }

  /** 读作业：内存里优先，其次 jobs 表；不是备份作业返回 null。 */
  async get(id?: string): Promise<BackupJob | null> {
    if (id) {
      const live = this.live.get(id)
      if (live) return { ...live }
      const stored = await this.host.db()?.jobs?.get?.(id)
      if (!stored || stored.kind !== BACKUP_KIND) return null
      return { ...(stored as BackupJob) }
    }
    return this.list()[0] ?? null
  }

  list(): BackupJob[] {
    const db = this.host.db()
    const records: BackupJob[] = []
    const seen = new Set<string>()
    for (const [, job] of db.jobs.entries() as [string, BackupJob][]) {
      if (job.kind !== BACKUP_KIND) continue
      seen.add(job.id)
      records.push(this.live.get(job.id) ?? job)
    }
    for (const [id, job] of this.live) {
      if (!seen.has(id)) records.push(job)
    }
    records.sort((left, right) => right.createdAt - left.createdAt)
    return records.map((job) => ({ ...job }))
  }

  /** 取消：停掉打包、删半成品，作业记为已取消。 */
  async cancel(id: string): Promise<{ job: BackupJob }> {
    const job = await this.requireJob(id)
    if (isActiveStatus(job.status)) {
      job.status = 'cancelled'
      job.stage = 'cancelled'
      job.stageText = '已取消'
      job.updatedAt = Date.now()
      this.live.set(job.id, job)
      await this.put(job)
      this.aborts.get(id)?.abort()
      const runner = this.runners.get(id)
      if (runner) await runner.catch(() => undefined)
      await this.removePartial(job.id)
      job.filePath = ''
      job.bytes = 0
      job.updatedAt = Date.now()
      this.live.set(job.id, job)
      await this.put(job)
      this.live.delete(id)
      this.aborts.delete(id)
      this.runners.delete(id)
    }
    return { job: { ...job } }
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.allSettled([...this.runners.values()])
    }
  }

  /** 宿主关闭：进行中的备份一律记账为失败，避免留下假的「进行中」。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const pending = [...this.live.values()].filter((job) => isActiveStatus(job.status))
    for (const job of pending) {
      job.status = 'failed'
      job.stage = 'failed'
      job.stageText = '已中断'
      job.error = '宿主重启，备份已中断，请重新导出'
      job.updatedAt = Date.now()
      try {
        await this.put(job)
      } catch {
        // 关闭阶段写盘失败不再抛。
      }
      this.aborts.get(job.id)?.abort()
    }
    await this.waitIdle()
    for (const job of pending) await this.removePartial(job.id)
    this.tickets.clear()
    this.live.clear()
    this.runners.clear()
    this.aborts.clear()
  }

  private launch(job: BackupJob): void {
    const runner = this.run(job).finally(() => {
      this.runners.delete(job.id)
      this.aborts.delete(job.id)
      if (job.status !== 'paused') this.live.delete(job.id)
    })
    this.runners.set(job.id, runner)
  }

  private findActive(): BackupJob | null {
    for (const job of this.live.values()) {
      if (isActiveStatus(job.status)) return job
    }
    return null
  }

  private async requireJob(id: string): Promise<BackupJob> {
    const job = this.live.get(id)
    if (job) return job
    const stored = await this.host.db()?.jobs?.get?.(id)
    if (!stored) throw new Error('作业不存在')
    if (stored.kind !== BACKUP_KIND) throw new Error('作业不是备份作业')
    return { ...(stored as BackupJob) }
  }

  private async put(job: BackupJob): Promise<void> {
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.host.db().jobs.put(job.id, { ...job })
    this.lastPutAt = job.updatedAt
    this.lastPutJob = job
  }

  /** 阶段推进后才落盘，避免每写一条记录都写 jobs 表。 */
  private async progress(job: BackupJob, force = false): Promise<void> {
    if (!force && Date.now() - this.lastPutAt < this.flushMs && this.lastPutJob?.id === job.id) return
    await this.put(job)
  }

  private assertRunning(job: BackupJob): void {
    if (job.status !== 'running') throw new BackupAbort(job.status)
  }

  private async run(job: BackupJob): Promise<void> {
    const abort = new AbortController()
    this.aborts.set(job.id, abort)
    const tempDir = backupTempDir(job.id)
    const counts: BackupSectionCounts = {}
    let files: string[] = []
    const covers: BackupCoverSummary = {
      total: 0,
      bytes: 0,
      skipped: 0,
      maxBytes: 0,
      maxTotalBytes: 0,
    }
    try {
      job.status = 'running'
      job.stage = 'prepare'
      job.stageText = '准备数据'
      await this.put(job)
      await mkdir(tempDir, { recursive: true })
      const db = this.host.db()
      const sections = backupSectionsFor(job.light)
      const coverStage = !job.light
      const sources = this.sectionsOf(db, sections)
      for (let index = 0; index < sections.length; index += 1) {
        this.assertRunning(job)
        const section = sections[index]
        const items = await sources[section]()
        const name = BACKUP_SECTION_FILES[section]
        await writeJsonArray(join(tempDir, name), items)
        counts[section] = items.length
        job.records += items.length
        files.push(name)
        job.stage = section
        job.stageText = `打包${sectionLabel(section)}`
        job.completed = index + 1
        await this.progress(job, true)
      }
      if (coverStage) {
        this.assertRunning(job)
        job.stage = 'covers'
        job.stageText = '抓取封面'
        await this.collectCovers(job, db, tempDir, covers, files)
        job.completed += 1
        await this.progress(job, true)
      }
      this.assertRunning(job)
      job.stage = 'manifest'
      job.stageText = '生成清单'
      const manifest = buildBackupManifest({
        appVersion: VERSION,
        light: job.light,
        counts,
        covers,
        files: [BACKUP_MANIFEST_FILE, ...files],
      })
      await writeText(join(tempDir, BACKUP_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
      files = [BACKUP_MANIFEST_FILE, ...files]
      job.covers = covers.total
      job.coverBytes = covers.bytes
      job.skippedCovers = covers.skipped
      job.completed += 1
      this.assertRunning(job)
      job.stage = 'packing'
      job.stageText = '压缩备份文件'
      await this.put(job)
      const root = await ensureExportRoot()
      const relative = backupArtifactName(job.id)
      const output = join(root, relative)
      await this.pack(tempDir, files, output, job, abort.signal)
      const info = await stat(output)
      this.assertRunning(job)
      // 压缩阶段也占一格进度：打包完成前不显示 100%。
      job.completed += 1
      job.filePath = relative
      job.fileName = backupFileName(new Date(job.createdAt))
      job.bytes = info.size
      job.status = 'done'
      job.stage = 'done'
      job.stageText = '备份完成'
      job.completed = job.total
      job.error = ''
      this.tickets.issue(job)
      await this.put(job)
    } catch (error) {
      if (error instanceof BackupAbort || job.status === 'cancelled') {
        // 取消已经由 cancel() 记账，这里只负责清理。
      } else if (!this.shuttingDown) {
        job.status = 'failed'
        job.stage = 'failed'
        job.stageText = '备份失败'
        job.error = errorMessage(error)
        try {
          await this.put(job)
        } catch {
          // 落盘失败就只能留在内存里供本次进程展示。
        }
      }
    } finally {
      if (job.status !== 'done') {
        job.filePath = ''
        job.bytes = 0
        try {
          await rm(join(exportRoot(), backupArtifactName(job.id)), { force: true })
        } catch {
          // 文件可能没生成。
        }
      }
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch {
        // 临时目录可能没建出来。
      }
      if (job.status === 'cancelled' || job.status === 'failed') await this.put(job)
    }
  }

  private sectionsOf(db: any, sections: readonly BackupSection[]): Record<BackupSection, () => Promise<any[]>> {
    const settings = () => (typeof db.settings?.get === 'function' ? db.settings.get() ?? {} : {})
    const subscriptions = () => recordsOf(db.subscriptions)
    const all: Record<BackupSection, () => Promise<any[]>> = {
      bookshelf: () => recordsOf(db.books),
      bookSource: () => recordsOf(db.sources),
      bookGroup: async () => {
        const groups = await recordsOf(db.groups)
        const known = new Set(groups.map((group) => String(group.id)))
        for (const book of await recordsOf(db.books)) {
          const name = String(book.group ?? '').trim()
          if (name && !known.has(name)) {
            known.add(name)
            groups.push({ id: name, name })
          }
        }
        return groups
      },
      bookmark: () => recordsOf(db.bookmarks),
      note: () => recordsOf(db.notes),
      readRecord: () => recordsOf(db.readRecords),
      readConfig: () => recordsOf(db.readConfigs),
      settings: async () => {
        // 备份包会被拷走、上传网盘或转发，WebDAV 密码不能跟着走；
        // 地址、账号与私网开关保留，恢复后只需重填密码。
        const snapshot: Record<string, any> = { ...settings() }
        delete snapshot.webdavPassword
        return [snapshot]
      },
      themeConfig: async () => {
        const current = settings()
        return [{ theme: current.theme, customThemes: current.customThemes ?? [] }]
      },
      replaceRule: async () => {
        const rules = settings().replaceRules
        return Array.isArray(rules) ? rules : []
      },
      dictRule: () => recordsOf(db.dictRules),
      rssSource: async () => (await subscriptions()).filter((record) => Boolean(record.sourceUrl)),
      subscription: async () => (await subscriptions()).filter((record) => !record.sourceUrl),
    }
    const picked: Record<string, () => Promise<any[]>> = {}
    for (const section of sections) picked[section] = all[section]
    return picked as Record<BackupSection, () => Promise<any[]>>
  }

  private async collectCovers(
    job: BackupJob,
    db: any,
    tempDir: string,
    covers: BackupCoverSummary,
    files: string[],
  ): Promise<void> {
    const books = await recordsOf(db.books)
    const coversDir = join(tempDir, BACKUP_COVERS_DIR)
    await mkdir(coversDir, { recursive: true })
    const maxCoversBytes = BACKUP_MAX_COVERS_TOTAL_BYTES
    let index = 0
    for (const book of books) {
      this.assertRunning(job)
      index += 1
      const coverUrl = String(book.coverUrl ?? '').trim()
      if (!coverUrl) continue
      let cover: EpubCover | null = null
      try {
        cover = await this.host.loadCover(book)
      } catch {
        cover = null
      }
      const data = cover?.data
      const entry = data ? backupCoverEntry(String(book.id ?? ''), cover?.extension ?? '') : ''
      const size = data?.length ?? 0
      if (!data || !entry || !coverBudgetAllows(covers.bytes, size, maxCoversBytes)) {
        covers.skipped += 1
        job.skippedCovers = covers.skipped
        continue
      }
      await writeBuffer(join(coversDir, entry.slice(BACKUP_COVERS_DIR.length + 1)), data)
      covers.total += 1
      covers.bytes += size
      job.covers = covers.total
      job.coverBytes = covers.bytes
      files.push(entry)
      if (index % 20 === 0) {
        job.stageText = `抓取封面 ${index}/${books.length}`
        await this.progress(job)
      }
    }
    covers.maxBytes = BACKUP_MAX_COVER_BYTES
    covers.maxTotalBytes = maxCoversBytes
  }

  private async pack(
    tempDir: string,
    files: string[],
    output: string,
    job: BackupJob,
    signal: AbortSignal,
  ): Promise<void> {
    const zip = new JSZip()
    const date = new Date(job.createdAt)
    for (const name of files) {
      zip.file(name, createReadStream(join(tempDir, name)), { binary: true, date })
    }
    const stream = zip.generateNodeStream(
      { type: 'nodebuffer', streamFiles: true, compression: 'STORE' },
      (meta) => {
        void this.progress(job)
        const percent = Math.max(0, Math.min(100, Math.round(Number(meta.percent) || 0)))
        job.stageText = `压缩备份文件 ${percent}%`
      },
    ) as unknown as Readable
    await pipeline(stream, createWriteStream(output), { signal })
  }

  private async removePartial(jobId: string): Promise<void> {
    await rm(join(exportRoot(), backupArtifactName(jobId)), { force: true }).catch(() => undefined)
    await rm(backupTempDir(jobId), { recursive: true, force: true }).catch(() => undefined)
  }
}

/** 取表里的全部记录；表实现提供 entries()。 */
async function recordsOf(table: any): Promise<any[]> {
  if (!table) return []
  if (typeof table.entries === 'function') {
    const entries = await table.entries()
    return [...(entries as Iterable<[string, any]>)].map(([, record]) => record)
  }
  if (typeof table.values === 'function') return [...(await table.values())]
  return []
}

async function writeJsonArray(path: string, items: any[]): Promise<void> {
  const handle = await open(path, 'w')
  try {
    if (items.length === 0) {
      await handle.write('[]\n')
      return
    }
    await handle.write('[\n')
    for (let index = 0; index < items.length; index += 1) {
      const body = JSON.stringify(items[index], null, 2).split('\n').join('\n  ')
      await handle.write(`  ${body}${index === items.length - 1 ? '' : ','}\n`)
    }
    await handle.write(']\n')
  } finally {
    await handle.close()
  }
}

async function writeText(path: string, body: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.write(body)
  } finally {
    await handle.close()
  }
}

async function writeBuffer(path: string, data: Buffer): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.write(data)
  } finally {
    await handle.close()
  }
}

function sectionLabel(section: BackupSection): string {
  const labels: Record<BackupSection, string> = {
    bookshelf: '书目',
    bookSource: '书源',
    bookGroup: '分组',
    bookmark: '书签',
    note: '笔记',
    readRecord: '阅读进度',
    readConfig: '阅读设置',
    settings: '全局设置',
    themeConfig: '主题',
    replaceRule: '替换规则',
    dictRule: '字典规则',
    rssSource: 'RSS 源',
    subscription: '订阅',
  }
  return labels[section] ?? section
}

/** 宿主重启后把中断的备份记为失败并清掉半成品。 */
export async function recoverInterruptedBackups(jobs: any): Promise<void> {
  if (!jobs || typeof jobs.entries !== 'function') return
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== BACKUP_KIND) continue
    if (!isActiveStatus(String(job.status))) continue
    try {
      await rm(join(exportRoot(), backupArtifactName(id)), { force: true })
      await rm(backupTempDir(id), { recursive: true, force: true })
    } catch {
      // 清理失败不影响记账。
    }
    await jobs.put(id, {
      ...job,
      status: 'failed',
      stage: 'failed',
      stageText: '已中断',
      error: '宿主重启，备份已中断，请重新导出',
      updatedAt: Date.now(),
    })
  }
}

/** 过期的备份作业记录与残留文件；产物目录由导出侧统一定时清理。 */
export async function cleanupExpiredBackups(jobs: any, now = Date.now()): Promise<{ jobs: number }> {
  if (!jobs || typeof jobs.entries !== 'function') return { jobs: 0 }
  const cutoff = now - BACKUP_JOB_TTL_MS
  let removed = 0
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== BACKUP_KIND) continue
    if (isActiveStatus(String(job.status))) continue
    if ((Number(job.updatedAt) || 0) >= cutoff) continue
    await jobs.delete(id)
    await rm(join(exportRoot(), backupArtifactName(id)), { force: true }).catch(() => undefined)
    await rm(backupTempDir(id), { recursive: true, force: true }).catch(() => undefined)
    removed += 1
  }
  return { jobs: removed }
}

/** 路由定位用：产物文件必须仍在导出目录里。 */
export async function backupArtifactAvailable(filePath: string): Promise<boolean> {
  if (!isArtifactFileName(filePath)) return false
  try {
    const info = await stat(join(exportRoot(), filePath))
    return info.isFile()
  } catch {
    return false
  }
}

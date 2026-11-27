/**
 * 备份导入（#132）：两阶段——先预览，用户确认后再写库。
 *
 * - 作业复用 jobs 表，kind=backupImport，进度与取消沿用导出的那套字段；
 * - 预览阶段把上传包落到导出目录下的 <jobId>.import.parts，解压校验与合并计划在内存完成；
 * - 确认后逐条写库，每条先记旧值；写库失败或中途取消按逆序回滚；
 * - 预览取消、失败、完成都会删掉临时目录，不留残余；
 * - 失败后可用同一文件重新 preview，不残留半份数据。
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assertImportArchiveSize,
  mergeBackupImport,
  parseBackupImport,
  type BackupImportExisting,
  type BackupImportOperation,
  type BackupImportPlan,
  type BackupImportPreview,
  type ImportedBackup,
} from '../core/reader/backup-import.js'
import type { JobStatus } from './download.js'
import { ensureExportRoot, exportRoot } from './exports.js'

/** jobs 表里的作业类型。 */
export const BACKUP_IMPORT_KIND = 'backupImport'
/** 上传包与预览中间文件的临时目录后缀。 */
export const BACKUP_IMPORT_TEMP_SUFFIX = '.import.parts'
/** 导入作业记录保留时长。 */
export const BACKUP_IMPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000
const BACKUP_IMPORT_FLUSH_MS = 500
const UPLOAD_FILE = 'upload.bin'

export interface BackupImportHost {
  db(): any
}

export interface BackupImportJob {
  id: string
  kind: typeof BACKUP_IMPORT_KIND
  bookId: string
  bookName: string
  status: JobStatus
  /** 机器可读阶段：receive/inspect/preview/apply/done/failed/cancelled。 */
  stage: string
  stageText: string
  total: number
  completed: number
  failed: number
  skipped: number
  /** 上传包字节数。 */
  bytes: number
  /** 已写入（或计划写入）的记录条数。 */
  records: number
  fileName: string
  importKind: string
  preview: BackupImportPreview | null
  warnings: string[]
  error: string
  createdAt: number
  updatedAt: number
}

interface ImportSession {
  plan: BackupImportPlan
  backup: ImportedBackup
  tempDir: string
  abort: AbortController
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isActiveStatus(status: string): boolean {
  return status === 'queued' || status === 'running'
}

function backupImportTempDir(jobId: string): string {
  return join(exportRoot(), `${jobId}${BACKUP_IMPORT_TEMP_SUFFIX}`)
}

const BASE64_SCAN_CHUNK = 1 << 20

/**
 * 分段校验 base64 字符集（#136）：整串正则会在数 MB 输入上触发 V8 回溯栈溢出。
 */
function isBase64Text(text: string): boolean {
  for (let start = 0; start < text.length; start += BASE64_SCAN_CHUNK) {
    const end = Math.min(text.length, start + BASE64_SCAN_CHUNK)
    for (let i = start; i < end; i += 1) {
      const code = text.charCodeAt(i)
      const ok =
        (code >= 65 && code <= 90) ||
        (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) ||
        code === 43 ||
        code === 47 ||
        code === 61 ||
        code === 32 ||
        code === 10 ||
        code === 13 ||
        code === 9 ||
        code === 12
      if (!ok) return false
    }
  }
  return true
}

export function decodeArchive(dataBase64: string): Buffer {
  const text = String(dataBase64 ?? '').trim()
  if (!text) throw new Error('没有选择备份文件')
  assertImportArchiveSize(Math.ceil((text.length * 3) / 4))
  if (!isBase64Text(text)) throw new Error('备份文件内容不完整，请重新选择')
  const buffer = Buffer.from(text, 'base64')
  if (buffer.length === 0) throw new Error('备份文件是空的')
  assertImportArchiveSize(buffer.length)
  return buffer
}

/** 读一整张表；表实现提供 entries()。 */
async function recordsOf(table: any): Promise<Record<string, unknown>[]> {
  if (!table) return []
  if (typeof table.entries === 'function') {
    const entries = await table.entries()
    return [...(entries as Iterable<[string, any]>)].map(([, record]) => record)
  }
  if (typeof table.values === 'function') return [...(await table.values())]
  return []
}

async function snapshotOf(db: any): Promise<BackupImportExisting> {
  return {
    books: await recordsOf(db.books),
    sources: await recordsOf(db.sources),
    groups: await recordsOf(db.groups),
    bookmarks: await recordsOf(db.bookmarks),
    notes: await recordsOf(db.notes),
    progress: await recordsOf(db.readRecords),
    readConfigs: await recordsOf(db.readConfigs),
    dictRules: await recordsOf(db.dictRules),
    subscriptions: await recordsOf(db.subscriptions),
    settings: (db.settings?.get?.() ?? {}) as Record<string, unknown>,
  }
}

function skippedTotal(preview: BackupImportPreview): number {
  const categories = [
    preview.books,
    preview.sources,
    preview.groups,
    preview.bookmarks,
    preview.notes,
    preview.progress,
    preview.readConfigs,
    preview.dictRules,
    preview.subscriptions,
    preview.replaceRules,
  ]
  return categories.reduce((sum, item) => sum + item.skipped, 0) + preview.themes.skipped + preview.settings.skipped
}

interface UndoEntry {
  table: any
  key: string
  previous: Record<string, unknown> | null
}

/** 导入协调器：一个宿主一个实例，预览计划只留在内存，作业状态落在 jobs 表。 */
export class BackupImportCoordinator {
  private readonly host: BackupImportHost
  private readonly live = new Map<string, BackupImportJob>()
  private readonly sessions = new Map<string, ImportSession>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly flushMs: number
  private lastPutAt = 0
  private shuttingDown = false

  constructor(host: BackupImportHost, options: { flushMs?: number } = {}) {
    this.host = host
    this.flushMs = options.flushMs ?? BACKUP_IMPORT_FLUSH_MS
  }

  /** 上传一个备份并生成预览；返回后作业先排队，等 waitIdle()/轮询到 paused 即预览就绪。 */
  async start(input: { fileName?: string; dataBase64: string }): Promise<{ job: BackupImportJob }> {
    const db = this.host.db()
    try {
      await cleanupExpiredBackupImports(db.jobs)
    } catch {
      // 清理失败不影响本次导入。
    }
    const job = this.buildJob(input.fileName)
    this.live.set(job.id, job)
    await this.put(job)
    this.launchPreview(job, input)
    return { job: { ...job } }
  }

  /**
   * 从磁盘上的备份文件发起导入（#133 下载后走这里）：文件先移进导入自己的临时目录，
   * 之后的校验、预览、确认与回滚和本地上传完全同一条通路。
   */
  async startFromFile(input: { fileName?: string; filePath: string }): Promise<{ job: BackupImportJob }> {
    const db = this.host.db()
    try {
      await cleanupExpiredBackupImports(db.jobs)
    } catch {
      // 清理失败不影响本次导入。
    }
    const job = this.buildJob(input.fileName)
    const tempDir = backupImportTempDir(job.id)
    const target = join(tempDir, UPLOAD_FILE)
    try {
      await ensureExportRoot()
      await mkdir(tempDir, { recursive: true })
      await rename(input.filePath, target)
      const info = await stat(target)
      assertImportArchiveSize(info.size)
      job.bytes = info.size
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    this.live.set(job.id, job)
    await this.put(job)
    this.launchPreview(job, { fileName: job.fileName, sourcePath: target })
    return { job: { ...job } }
  }

  private buildJob(fileName?: string): BackupImportJob {
    const now = Date.now()
    return {
      id: randomUUID(),
      kind: BACKUP_IMPORT_KIND,
      bookId: '',
      bookName: '',
      status: 'queued',
      stage: 'receive',
      stageText: '读取备份文件',
      total: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      bytes: 0,
      records: 0,
      fileName: String(fileName ?? '').trim() || 'backup.zip',
      importKind: '',
      preview: null,
      warnings: [],
      error: '',
      createdAt: now,
      updatedAt: now,
    }
  }

  peek(id: string): BackupImportJob | null {
    const job = this.live.get(id)
    return job ? { ...job } : null
  }

  /** 读作业：内存优先，其次 jobs 表；不是导入作业返回 null。 */
  async get(id?: string): Promise<BackupImportJob | null> {
    if (id) {
      const live = this.live.get(id)
      if (live) return { ...live }
      const stored = await this.host.db()?.jobs?.get?.(id)
      if (!stored || stored.kind !== BACKUP_IMPORT_KIND) return null
      return { ...(stored as BackupImportJob) }
    }
    return this.list()[0] ?? null
  }

  list(): BackupImportJob[] {
    const db = this.host.db()
    const records: BackupImportJob[] = []
    const seen = new Set<string>()
    for (const [, job] of (db.jobs?.entries?.() ?? []) as Iterable<[string, BackupImportJob]>) {
      if (job.kind !== BACKUP_IMPORT_KIND) continue
      seen.add(job.id)
      records.push(this.live.get(job.id) ?? job)
    }
    for (const [id, job] of this.live) {
      if (!seen.has(id)) records.push(job)
    }
    records.sort((left, right) => right.createdAt - left.createdAt)
    return records.map((job) => ({ ...job }))
  }

  /** 预览阶段取消：不写任何数据；写库阶段取消：停手并回滚已写条目。 */
  async cancel(id: string): Promise<{ job: BackupImportJob }> {
    const job = await this.requireJob(id)
    if (job.status !== 'paused' && !isActiveStatus(job.status)) return { job: { ...job } }
    job.status = 'cancelled'
    job.stage = 'cancelled'
    job.stageText = '已取消'
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.put(job)
    this.sessions.get(id)?.abort.abort()
    const runner = this.runners.get(id)
    if (runner) await runner.catch(() => undefined)
    await rm(backupImportTempDir(id), { recursive: true, force: true }).catch(() => undefined)
    this.sessions.delete(id)
    this.runners.delete(id)
    job.updatedAt = Date.now()
    await this.put(job)
    this.live.delete(id)
    return { job: { ...job } }
  }

  /** 用户确认后写库；同步等到结束，失败自动回滚。 */
  async apply(id: string): Promise<{ job: BackupImportJob }> {
    const job = await this.requireJob(id)
    if (job.status === 'done') return { job: { ...job } }
    if (job.status !== 'paused') throw new Error('导入预览已失效，请重新选择文件')
    const session = this.sessions.get(id)
    if (!session) throw new Error('导入预览已失效，请重新选择文件')
    const total = session.plan.operations.length + (session.plan.settings ? 1 : 0)
    job.status = 'running'
    job.stage = 'apply'
    job.stageText = total > 0 ? '写入数据' : '数据已是最新'
    job.total = total
    job.completed = 0
    job.records = 0
    await this.put(job)
    const runner = this.runApply(job, session)
    this.runners.set(id, runner)
    try {
      await runner
    } finally {
      this.runners.delete(id)
    }
    return { job: { ...job } }
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.allSettled([...this.runners.values()])
    }
  }

  /** 宿主关闭：进行中的导入记为失败并清掉临时目录。 */
  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const pending = [...this.live.values()].filter(
      (job) => isActiveStatus(job.status) || job.status === 'paused',
    )
    for (const job of pending) {
      job.status = isActiveStatus(job.status) ? 'failed' : 'cancelled'
      job.stage = job.status === 'failed' ? 'failed' : 'cancelled'
      job.stageText = job.status === 'failed' ? '已中断' : '已取消'
      if (job.status === 'failed') job.error = '宿主重启，导入已中断，请重新选择文件'
      job.updatedAt = Date.now()
      this.sessions.get(job.id)?.abort.abort()
      try {
        await this.put(job)
      } catch {
        // 关闭阶段写盘失败不再抛。
      }
    }
    await this.waitIdle()
    for (const job of pending) {
      await rm(backupImportTempDir(job.id), { recursive: true, force: true }).catch(() => undefined)
    }
    this.sessions.clear()
    this.live.clear()
    this.runners.clear()
  }

  private launchPreview(
    job: BackupImportJob,
    input: { fileName?: string; dataBase64?: string; sourcePath?: string },
  ): void {
    const abort = new AbortController()
    const runner = this.runPreview(job, input, abort).finally(() => {
      this.runners.delete(job.id)
      // 预览失败、取消后不再保留内存态；paused 留给 apply。
      if (job.status !== 'paused') this.live.delete(job.id)
    })
    this.runners.set(job.id, runner)
  }

  private async runPreview(
    job: BackupImportJob,
    input: { fileName?: string; dataBase64?: string; sourcePath?: string },
    abort: AbortController,
  ): Promise<void> {
    const tempDir = backupImportTempDir(job.id)
    try {
      job.status = 'running'
      job.stage = 'inspect'
      job.stageText = '校验备份文件'
      await this.put(job)
      let data: Buffer
      if (input.sourcePath) {
        // 下载通路：文件已由 startFromFile 移进临时目录，读回来走同一套解析。
        data = await readFile(input.sourcePath)
        assertImportArchiveSize(data.length)
        job.bytes = data.length
      } else {
        data = decodeArchive(input.dataBase64 ?? '')
        job.bytes = data.length
        await ensureExportRoot()
        await mkdir(tempDir, { recursive: true })
        await writeFile(join(tempDir, UPLOAD_FILE), data)
      }
      if (abort.signal.aborted) throw new Error('已取消')
      const backup = parseBackupImport({ data, fileName: job.fileName })
      job.importKind = backup.kind
      job.stage = 'preview'
      job.stageText = '生成导入预览'
      await this.progress(job, true)
      const existing = await snapshotOf(this.host.db())
      if (abort.signal.aborted) throw new Error('已取消')
      const plan = mergeBackupImport({ backup, existing })
      this.sessions.set(job.id, { plan, backup, tempDir, abort })
      job.status = 'paused'
      job.stage = 'preview'
      job.stageText = '等待确认'
      job.total = plan.preview.books.total
      job.completed = 0
      job.skipped = skippedTotal(plan.preview)
      job.preview = plan.preview
      job.warnings = plan.warnings
      job.updatedAt = Date.now()
      this.live.set(job.id, job)
      await this.put(job)
    } catch (error) {
      const cancelled = job.status === 'cancelled' || abort.signal.aborted
      job.status = cancelled ? 'cancelled' : 'failed'
      job.stage = cancelled ? 'cancelled' : 'failed'
      job.stageText = cancelled ? '已取消' : '导入失败'
      job.error = cancelled ? '' : errorMessage(error)
      job.updatedAt = Date.now()
      this.sessions.delete(job.id)
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      try {
        await this.put(job)
      } catch {
        // 记录失败本身不再抛出。
      }
      this.live.delete(job.id)
    }
  }

  private async runApply(job: BackupImportJob, session: ImportSession): Promise<void> {
    const db = this.host.db()
    const undo: UndoEntry[] = []
    let settingsBefore: Record<string, unknown> | null = null
    let settingsWritten = false
    try {
      for (const operation of session.plan.operations) {
        this.assertRunning(job, session.abort.signal)
        await this.applyOperation(job, operation, undo)
      }
      if (session.plan.settings) {
        this.assertRunning(job, session.abort.signal)
        settingsBefore = (db.settings.get?.() ?? {}) as Record<string, unknown>
        settingsWritten = true
        await db.settings.set(session.plan.settings)
        job.completed += 1
        await this.progress(job, true)
      }
      job.status = 'done'
      job.stage = 'done'
      job.stageText = '导入完成'
      job.records = session.plan.operations.length
      job.skipped = skippedTotal(session.plan.preview)
      job.error = ''
      await rm(session.tempDir, { recursive: true, force: true }).catch(() => undefined)
      this.sessions.delete(job.id)
      this.live.delete(job.id)
      job.updatedAt = Date.now()
      await this.put(job)
    } catch (error) {
      const cancelled = job.status === 'cancelled' || session.abort.signal.aborted
      await this.rollback(undo, db, settingsWritten ? settingsBefore : null, settingsWritten)
      job.status = cancelled ? 'cancelled' : 'failed'
      job.stage = cancelled ? 'cancelled' : 'failed'
      job.stageText = cancelled ? '已取消' : '导入失败'
      job.error = cancelled ? '' : errorMessage(error)
      job.records = 0
      await rm(session.tempDir, { recursive: true, force: true }).catch(() => undefined)
      this.sessions.delete(job.id)
      this.live.delete(job.id)
      job.updatedAt = Date.now()
      try {
        await this.put(job)
      } catch {
        // 失败记账不再抛。
      }
    }
  }

  private async applyOperation(
    job: BackupImportJob,
    operation: BackupImportOperation,
    undo: UndoEntry[],
  ): Promise<void> {
    const db = this.host.db()
    const table = db[operation.table]
    if (!table || typeof table.put !== 'function') throw new Error(`缺少数据表 ${operation.table}`)
    const previous = typeof table.get === 'function' ? table.get(operation.key) : undefined
    undo.push({
      table,
      key: operation.key,
      previous: previous === undefined || previous === null ? null : structuredClone(previous),
    })
    await table.put(operation.key, operation.record)
    job.completed += 1
    job.records += 1
    job.stageText = `写入数据 ${job.completed}/${job.total}`
    await this.progress(job)
  }

  private async rollback(
    undo: UndoEntry[],
    db: any,
    settingsBefore: Record<string, unknown> | null,
    settingsWritten: boolean,
  ): Promise<void> {
    for (let index = undo.length - 1; index >= 0; index -= 1) {
      const entry = undo[index]
      try {
        if (entry.previous) await entry.table.put(entry.key, entry.previous)
        else if (typeof entry.table.delete === 'function') await entry.table.delete(entry.key)
      } catch {
        // 回滚尽力而为，单条失败不阻断其余条目。
      }
    }
    if (settingsWritten && settingsBefore) {
      try {
        await db.settings.set(settingsBefore)
      } catch {
        // 同上。
      }
    }
  }

  private assertRunning(job: BackupImportJob, signal: AbortSignal): void {
    if (signal.aborted || job.status !== 'running') throw new Error('已取消')
  }

  private async requireJob(id: string): Promise<BackupImportJob> {
    const job = this.live.get(id)
    if (job) return job
    const stored = await this.host.db()?.jobs?.get?.(id)
    if (!stored) throw new Error('作业不存在')
    if (stored.kind !== BACKUP_IMPORT_KIND) throw new Error('作业不是导入作业')
    return { ...(stored as BackupImportJob) }
  }

  private async put(job: BackupImportJob): Promise<void> {
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.host.db().jobs.put(job.id, { ...job })
    this.lastPutAt = job.updatedAt
  }

  private async progress(job: BackupImportJob, force = false): Promise<void> {
    if (!force && Date.now() - this.lastPutAt < this.flushMs) return
    await this.put(job)
  }
}

/** 宿主重启后把中断的导入记为失败并清掉临时目录。 */
export async function recoverInterruptedBackupImports(jobs: any): Promise<void> {
  if (!jobs || typeof jobs.entries !== 'function') return
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== BACKUP_IMPORT_KIND) continue
    if (!isActiveStatus(String(job.status)) && job.status !== 'paused') continue
    try {
      await rm(backupImportTempDir(id), { recursive: true, force: true })
    } catch {
      // 清理失败不影响记账。
    }
    await jobs.put(id, {
      ...job,
      status: 'failed',
      stage: 'failed',
      stageText: '已中断',
      error: '宿主重启，导入已中断，请重新选择文件',
      preview: null,
      updatedAt: Date.now(),
    })
  }
}

/** 过期的导入作业与临时目录。 */
export async function cleanupExpiredBackupImports(
  jobs: any,
  now = Date.now(),
): Promise<{ jobs: number }> {
  if (!jobs || typeof jobs.entries !== 'function') return { jobs: 0 }
  const cutoff = now - BACKUP_IMPORT_JOB_TTL_MS
  let removed = 0
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== BACKUP_IMPORT_KIND) continue
    if (isActiveStatus(String(job.status)) || job.status === 'paused') continue
    if ((Number(job.updatedAt) || 0) >= cutoff) continue
    await jobs.delete(id)
    await rm(backupImportTempDir(id), { recursive: true, force: true }).catch(() => undefined)
    removed += 1
  }
  return { jobs: removed }
}

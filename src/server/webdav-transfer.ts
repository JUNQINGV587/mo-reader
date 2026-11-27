/**
 * WebDAV 上传与下载（#133）：复用 jobs 表承载进度与取消，上传走 PUT、下载走 GET。
 *
 * - 上传：只写远端目录下的目标备份文件，覆盖前先 HEAD 探测并暂停等确认；
 *   远端目录不存在时与 #131 一致地逐级 MKCOL；取消时若目标文件是本次新写的，尽力删掉半成品。
 * - 下载：先落到导出目录下的临时文件，再交给 #132 的导入协调器（预览→确认→写库全复用）；
 *   临时目录在交棒、取消、失败后都删掉。
 * - 错误统一映射成可读文案并脱敏密码；进度按字节累计，节流写 jobs 表。
 */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { assertImportArchiveSize } from '../core/reader/backup-import.js'
import { redactWebdavPassword, type WebdavConfig } from '../core/webdav/config.js'
import {
  assertWebdavFileName,
  toWebdavRequestError,
  webdavFailureFromStatus,
  WebdavRequestError,
  type WebdavClient,
} from '../core/webdav/client.js'
import { isActiveJob, type JobStatus } from './download.js'
import { ensureExportRoot, exportRoot } from './exports.js'

/** jobs 表里的作业类型：与下载/导出/备份共用一张表。 */
export const WEBDAV_TRANSFER_KIND = 'webdavTransfer'
/** 下载临时目录后缀：<jobId>.webdav.parts/ */
export const WEBDAV_TRANSFER_TEMP_SUFFIX = '.webdav.parts'
/** 作业记录保留 24 小时。 */
export const WEBDAV_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000
const WEBDAV_TRANSFER_FLUSH_MS = 500
const DOWNLOAD_FILE = 'remote.zip'

export type WebdavTransferDirection = 'upload' | 'download'

export interface WebdavTransferJob {
  id: string
  kind: typeof WEBDAV_TRANSFER_KIND
  bookId: string
  bookName: string
  status: JobStatus
  /** 机器可读阶段：prepare/upload/confirm/download/done/failed/cancelled。 */
  stage: string
  stageText: string
  direction: WebdavTransferDirection
  /** 远端备份文件名（上传时取自备份产物）。 */
  fileName: string
  /** 上传来源的备份作业 id。 */
  backupJobId: string
  /** 字节数：total 是预期大小，completed 是已传输字节。 */
  total: number
  completed: number
  bytes: number
  remoteUrl: string
  /** 下载交接给导入协调器后的导入作业 id。 */
  importJobId: string
  /** 已确认覆盖远端同名文件。 */
  overwrite: boolean
  /** 远端已有同名文件，等待确认覆盖。 */
  remoteExists: boolean
  createdDirs: number
  error: string
  createdAt: number
  updatedAt: number
}

export interface WebdavTransferHost {
  db(): any
  /** 每次作业开始时读最新配置，保存后不用重启服务。 */
  config(): WebdavConfig
  client(config: WebdavConfig): WebdavClient
  /** 传输的超时（毫秒），与连通测试共用同一设置。 */
  timeoutMs(): number
  /** 当前（或指定）备份作业的产物；没有可上传的备份时抛可读错误。 */
  backupArtifact(jobId?: string): Promise<{ id: string; fileName: string; filePath: string; size: number }>
  /** 把下载好的临时文件交给本地导入（导入侧接管文件，不再复制）。 */
  importFromFile(input: { fileName: string; filePath: string }): Promise<{ job: { id: string } }>
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function webdavTransferTempDir(jobId: string): string {
  return join(exportRoot(), `${jobId}${WEBDAV_TRANSFER_TEMP_SUFFIX}`)
}

/** 远端报的或已收的字节数超限时，借用导入的同一句文案。 */
function assertRemoteSize(bytes: number): void {
  assertImportArchiveSize(bytes)
}

/** 一个宿主一个实例；作业状态落 jobs 表，临时文件落导出目录。 */
export class WebdavTransferCoordinator {
  private readonly host: WebdavTransferHost
  private readonly live = new Map<string, WebdavTransferJob>()
  private readonly runners = new Map<string, Promise<void>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly flushMs: number
  private lastPutAt = 0

  constructor(host: WebdavTransferHost, options: { flushMs?: number } = {}) {
    this.host = host
    this.flushMs = options.flushMs ?? WEBDAV_TRANSFER_FLUSH_MS
  }

  /** 发起上传：status=queued，后台准备目录并 PUT；远端已有同名文件时停在 paused/confirm。 */
  async startUpload(input: { backupJobId?: string } = {}): Promise<{ job: WebdavTransferJob }> {
    const db = this.host.db()
    try {
      await cleanupExpiredWebdavTransfers(db.jobs)
    } catch {
      // 清理失败不影响本次传输。
    }
    const job = this.createJob({ direction: 'upload', backupJobId: String(input.backupJobId ?? '').trim() })
    this.live.set(job.id, job)
    await this.put(job)
    this.launch(job.id, this.runUpload(job))
    return { job: { ...job } }
  }

  /** 覆盖确认：paused/confirm 的作业继续上传；已经不在等确认时原样返回。 */
  async confirmUpload(id: string): Promise<{ job: WebdavTransferJob }> {
    const job = await this.requireJob(id)
    if (job.status !== 'paused' || job.stage !== 'confirm') return { job: { ...job } }
    job.overwrite = true
    job.status = 'queued'
    job.stage = 'prepare'
    job.stageText = '准备覆盖上传'
    job.error = ''
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.put(job)
    this.launch(job.id, this.runUpload(job))
    return { job: { ...job } }
  }

  /** 发起下载：先落临时文件，完成后交给导入协调器生成预览。 */
  async startDownload(input: { fileName?: string } = {}): Promise<{ job: WebdavTransferJob }> {
    const db = this.host.db()
    try {
      await cleanupExpiredWebdavTransfers(db.jobs)
    } catch {
      // 同上。
    }
    const fileName = String(input.fileName ?? '').trim()
    if (!fileName) {
      const latest = await this.host.backupArtifact().catch(() => null)
      if (!latest) throw new Error('请填写远端备份文件名')
      return this.startDownload({ fileName: latest.fileName })
    }
    const job = this.createJob({ direction: 'download', fileName })
    this.live.set(job.id, job)
    await this.put(job)
    this.launch(job.id, this.runDownload(job))
    return { job: { ...job } }
  }

  peek(id: string): WebdavTransferJob | null {
    const job = this.live.get(id)
    return job ? { ...job } : null
  }

  /** 读作业：内存优先，其次 jobs 表；不传 id 返回最近一次。 */
  async get(id?: string): Promise<WebdavTransferJob | null> {
    if (id) {
      const live = this.live.get(id)
      if (live) return { ...live }
      const stored = await this.host.db()?.jobs?.get?.(id)
      if (!stored || stored.kind !== WEBDAV_TRANSFER_KIND) return null
      return { ...(stored as WebdavTransferJob) }
    }
    return this.list()[0] ?? null
  }

  list(): WebdavTransferJob[] {
    const db = this.host.db()
    const records: WebdavTransferJob[] = []
    const seen = new Set<string>()
    for (const [, job] of (db.jobs?.entries?.() ?? []) as Iterable<[string, WebdavTransferJob]>) {
      if (job.kind !== WEBDAV_TRANSFER_KIND) continue
      seen.add(job.id)
      records.push(this.live.get(job.id) ?? job)
    }
    for (const [id, job] of this.live) {
      if (!seen.has(id)) records.push(job)
    }
    records.sort((left, right) => right.createdAt - left.createdAt)
    return records.map((job) => ({ ...job }))
  }

  /** 取消：覆盖确认阶段直接终结；传输中先记取消再中断请求并清临时文件。 */
  async cancel(id: string): Promise<{ job: WebdavTransferJob }> {
    const job = await this.requireJob(id)
    if (!isActiveJob(job.status) && job.status !== 'paused') return { job: { ...job } }
    job.status = 'cancelled'
    job.stage = 'cancelled'
    job.stageText = '已取消'
    job.error = ''
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.put(job)
    this.controllers.get(id)?.abort()
    const runner = this.runners.get(id)
    if (runner) await runner.catch(() => undefined)
    await rm(webdavTransferTempDir(id), { recursive: true, force: true }).catch(() => undefined)
    this.controllers.delete(id)
    this.runners.delete(id)
    this.live.delete(id)
    return { job: { ...job } }
  }

  async waitIdle(): Promise<void> {
    while (this.runners.size > 0) {
      await Promise.allSettled([...this.runners.values()])
    }
  }

  /** 宿主关闭：进行中的传输记失败并中断，临时文件清掉；已暂停等确认的保留。 */
  async shutdown(): Promise<void> {
    const pending = [...this.live.values()].filter((job) => isActiveJob(job.status))
    for (const job of pending) {
      job.status = 'failed'
      job.stage = 'failed'
      job.stageText = '已中断'
      job.error = '宿主重启，上传下载已中断，请重新操作'
      job.updatedAt = Date.now()
      this.controllers.get(job.id)?.abort()
      try {
        await this.put(job)
      } catch {
        // 关闭阶段写盘失败不再抛。
      }
    }
    await this.waitIdle()
    for (const job of pending) {
      await rm(webdavTransferTempDir(job.id), { recursive: true, force: true }).catch(() => undefined)
    }
    this.controllers.clear()
    this.runners.clear()
    this.live.clear()
  }

  private createJob(input: {
    direction: WebdavTransferDirection
    fileName?: string
    backupJobId?: string
  }): WebdavTransferJob {
    const now = Date.now()
    return {
      id: randomUUID(),
      kind: WEBDAV_TRANSFER_KIND,
      bookId: '',
      bookName: '',
      status: 'queued',
      stage: 'prepare',
      stageText: input.direction === 'upload' ? '准备上传' : '准备取回',
      direction: input.direction,
      fileName: String(input.fileName ?? '').trim(),
      backupJobId: String(input.backupJobId ?? ''),
      total: 0,
      completed: 0,
      bytes: 0,
      remoteUrl: '',
      importJobId: '',
      overwrite: false,
      remoteExists: false,
      createdDirs: 0,
      error: '',
      createdAt: now,
      updatedAt: now,
    }
  }

  private launch(id: string, runner: Promise<void>): void {
    const wrapped = runner
      .catch(() => undefined)
      .finally(() => {
        if (this.runners.get(id) === wrapped) this.runners.delete(id)
      })
    this.runners.set(id, wrapped)
  }

  /** 上传：探测（覆盖确认）→ PUT 流式上传；取消时尽力删掉本次新写的半成品。 */
  private async runUpload(job: WebdavTransferJob): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    let stream: ReturnType<typeof createReadStream> | null = null
    let client: WebdavClient | null = null
    let config: WebdavConfig | null = null
    let putStarted = false
    try {
      job.status = 'running'
      job.stage = 'prepare'
      job.stageText = '检查远端目录'
      await this.put(job)
      config = this.host.config()
      if (!config.url) throw new Error('还没配置 WebDAV，请先填写地址并保存')
      client = this.host.client(config)
      const artifact = await this.host.backupArtifact(job.backupJobId)
      const fileName = assertWebdavFileName(artifact.fileName)
      job.fileName = fileName
      job.backupJobId = artifact.id
      job.total = artifact.size
      const prepared = await client.prepareDirectory()
      job.createdDirs = prepared.createdDirs
      job.remoteUrl = client.fileUrl(fileName)
      if (!job.overwrite) {
        const head = await client.headFile(job.remoteUrl)
        if (isSuccess(head.status)) {
          job.remoteExists = true
          job.status = 'paused'
          job.stage = 'confirm'
          job.stageText = '远端已有同名文件，确认覆盖'
          await this.put(job)
          return
        }
        // 404 表示全新写入；405/501 是服务器不支持 HEAD，只能按未知继续。
        if (head.status !== 404 && head.status !== 405 && head.status !== 501) {
          throw webdavFailureFromStatus(head.status, '检查远端文件')
        }
      }
      job.stage = 'upload'
      job.stageText = '上传备份'
      job.completed = 0
      await this.put(job)
      stream = createReadStream(artifact.filePath)
      stream.on('data', (chunk: Buffer | string) => {
        job.completed += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        void this.progress(job)
      })
      // 只对「发出请求到收到响应头」计时；响应头之后由调用方取消。
      const timer = this.headerTimer(controller)
      try {
        putStarted = true
        const response = await client.send('PUT', job.remoteUrl, {
          headers: { 'Content-Type': 'application/zip', 'Content-Length': String(artifact.size) },
          body: stream,
          signal: controller.signal,
        })
        if (!isSuccess(response.status)) {
          putStarted = false
          throw webdavFailureFromStatus(response.status, '上传')
        }
      } finally {
        if (timer) clearTimeout(timer)
      }
      job.status = 'done'
      job.stage = 'done'
      job.stageText = `已上传：${fileName}`
      job.bytes = artifact.size
      job.completed = artifact.size
      job.error = ''
      job.updatedAt = Date.now()
      await this.put(job)
    } catch (error) {
      const cancelled = (job.status as JobStatus) === 'cancelled'
      if (cancelled && client && job.remoteUrl && putStarted && !job.remoteExists) {
        // 本次新写、还没确认覆盖的远端文件才是半成品；删失败就留给用户自己处理。
        try {
          await client.send('DELETE', job.remoteUrl)
        } catch {
          // 尽力而为。
        }
      }
      await this.fail(job, error, config, cancelled, '上传失败')
    } finally {
      this.controllers.delete(job.id)
      this.live.delete(job.id)
      stream?.destroy()
    }
  }

  /** 下载：GET 到临时文件 → 交棒导入协调器；任何终结态都清临时目录。 */
  private async runDownload(job: WebdavTransferJob): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    let config: WebdavConfig | null = null
    const tempDir = webdavTransferTempDir(job.id)
    const tempFile = join(tempDir, DOWNLOAD_FILE)
    try {
      job.status = 'running'
      job.stage = 'prepare'
      job.stageText = '检查远端目录'
      await this.put(job)
      config = this.host.config()
      if (!config.url) throw new Error('还没配置 WebDAV，请先填写地址并保存')
      const client = this.host.client(config)
      const fileName = assertWebdavFileName(job.fileName)
      job.fileName = fileName
      job.remoteUrl = client.fileUrl(fileName)
      const prepared = await client.prepareDirectory()
      job.createdDirs = prepared.createdDirs
      job.stage = 'download'
      job.stageText = '取回备份'
      job.completed = 0
      await this.put(job)

      const timer = this.headerTimer(controller)
      let response: Response
      try {
        response = await client.downloadFile(job.remoteUrl, controller.signal)
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (response.status === 404) {
        throw new WebdavRequestError('http', '远端没有这个备份文件（404）', 404)
      }
      if (!isSuccess(response.status)) throw webdavFailureFromStatus(response.status, '取回')
      const declared = Number(response.headers.get('content-length') ?? '')
      if (Number.isFinite(declared) && declared > 0) {
        assertRemoteSize(declared)
        job.total = declared
      }
      await ensureExportRoot()
      await mkdir(tempDir, { recursive: true })
      const sink = createWriteStream(tempFile)
      try {
        const body = response.body ? (Readable.fromWeb(response.body as any) as Readable) : null
        if (!body) throw new Error('远端返回了空文件')
        for await (const chunk of body) {
          if ((job.status as JobStatus) === 'cancelled' || controller.signal.aborted) {
            throw new Error('已取消')
          }
          const buffer = Buffer.from(chunk as any)
          job.completed += buffer.length
          assertRemoteSize(job.completed)
          if (!sink.write(buffer)) await once(sink, 'drain')
          await this.progress(job)
        }
        await new Promise<void>((resolve, reject) => {
          sink.once('error', reject)
          sink.end(() => resolve())
        })
      } catch (error) {
        sink.destroy()
        throw error
      }
      const info = await stat(tempFile)
      assertRemoteSize(info.size)
      job.bytes = info.size
      job.completed = info.size
      job.total = Math.max(job.total, info.size)
      const started = await this.host.importFromFile({ fileName, filePath: tempFile })
      job.importJobId = started.job.id
      job.status = 'done'
      job.stage = 'done'
      job.stageText = `已取回：${fileName}，请确认导入`
      job.error = ''
      job.updatedAt = Date.now()
      await this.put(job)
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    } catch (error) {
      // cancel() 会在另一个调用里改写作业状态，这里不能被 TS 的窄化骗过去。
      const cancelled = (job.status as JobStatus) === 'cancelled'
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      await this.fail(job, error, config, cancelled, '取回失败')
    } finally {
      this.controllers.delete(job.id)
      this.live.delete(job.id)
    }
  }

  /**
   * 只给「发请求到收到响应头」计时；传输本身由用户取消。
   * 宿主没给出有效超时（例如测试里手工造的服务对象没跑字段初始化）就按不限时处理。
   */
  private headerTimer(controller: AbortController): NodeJS.Timeout | null {
    const ms = Number(this.host.timeoutMs())
    if (!Number.isFinite(ms) || ms <= 0) return null
    return setTimeout(() => controller.abort(), ms)
  }

  private async fail(
    job: WebdavTransferJob,
    error: unknown,
    config: WebdavConfig | null,
    cancelled: boolean,
    failureText: string,
  ): Promise<void> {
    job.status = cancelled ? 'cancelled' : 'failed'
    job.stage = cancelled ? 'cancelled' : 'failed'
    job.stageText = cancelled ? '已取消' : failureText
    if (cancelled) {
      job.error = ''
    } else {
      const failure = toWebdavRequestError(error)
      job.error = redactWebdavPassword(failure.message, config?.password ?? '')
    }
    job.updatedAt = Date.now()
    try {
      await this.put(job)
    } catch {
      // 失败记账不再抛。
    }
  }

  private async requireJob(id: string): Promise<WebdavTransferJob> {
    const live = this.live.get(id)
    if (live) return live
    const stored = await this.host.db()?.jobs?.get?.(id)
    if (!stored) throw new Error('作业不存在')
    if (stored.kind !== WEBDAV_TRANSFER_KIND) throw new Error('作业不是上传下载作业')
    return { ...(stored as WebdavTransferJob) }
  }

  private async put(job: WebdavTransferJob): Promise<void> {
    job.updatedAt = Date.now()
    this.live.set(job.id, job)
    await this.host.db().jobs.put(job.id, { ...job })
    this.lastPutAt = job.updatedAt
  }

  private async progress(job: WebdavTransferJob): Promise<void> {
    if (Date.now() - this.lastPutAt < this.flushMs) return
    await this.put(job)
  }
}

/** 宿主重启后把中断的传输记为失败，并清掉下载临时目录。 */
export async function recoverInterruptedWebdavTransfers(jobs: any): Promise<void> {
  if (!jobs || typeof jobs.entries !== 'function') return
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== WEBDAV_TRANSFER_KIND) continue
    if (!isActiveJob(String(job.status))) continue
    try {
      await rm(webdavTransferTempDir(id), { recursive: true, force: true })
    } catch {
      // 清理失败不影响记账。
    }
    await jobs.put(id, {
      ...job,
      status: 'failed',
      stage: 'failed',
      stageText: '已中断',
      error: '宿主重启，上传下载已中断，请重新操作',
      updatedAt: Date.now(),
    })
  }
}

/** 过期的传输作业与临时目录。 */
export async function cleanupExpiredWebdavTransfers(
  jobs: any,
  now = Date.now(),
): Promise<{ jobs: number }> {
  if (!jobs || typeof jobs.entries !== 'function') return { jobs: 0 }
  const cutoff = now - WEBDAV_TRANSFER_TTL_MS
  let removed = 0
  for (const [id, job] of (await jobs.entries()) as [string, any][]) {
    if (job?.kind !== WEBDAV_TRANSFER_KIND) continue
    if (isActiveJob(String(job.status))) continue
    if ((Number(job.updatedAt) || 0) >= cutoff) continue
    await jobs.delete(id)
    await rm(webdavTransferTempDir(id), { recursive: true, force: true }).catch(() => undefined)
    removed += 1
  }
  return { jobs: removed }
}

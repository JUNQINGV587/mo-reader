/**
 * 导出成品清理（#143）：存储页列出导出目录里的成品文件并逐个删除。
 *
 * 只认导出目录下「UUID + 已知后缀」的单段文件名（备份 zip、导出 txt/epub/pdf、
 * 失败清单 .failed.txt），并在删除前再按 resolve 结果校验一次没有越出导出根。
 * 临时目录（.parts）、符号链接、陌生文件都不在可删范围。
 */
import { lstat, readdir, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { isActiveJob } from './download.js'
import { exportRoot } from './exports.js'
import { WEBDAV_TRANSFER_KIND } from './webdav-transfer.js'

export type ExportFileKind = 'backup' | 'export' | 'failed'

export interface ExportFileEntry {
  /** 磁盘上的单段文件名，删除时也用它。 */
  name: string
  jobId: string
  kind: ExportFileKind
  size: number
  mtimeMs: number
  /** 界面上给人看的名字（备份带日期、导出带书名、失败清单带书名）。 */
  displayName: string
  /** 对应作业的当前状态；作业记录已丢时为空串。 */
  status: string
  deletable: boolean
  /** 不能删的原因（进行中、正在上传）；能删时为空串。 */
  reason: string
}

export interface ExportFileList {
  files: ExportFileEntry[]
  total: { bytes: number; files: number }
}

export interface ExportFileDeleteResult {
  name: string
  jobId: string
  kind: ExportFileKind
  bytes: number
}

export interface ExportFileOptions {
  /** 协调器内存里刚建、还没落盘的作业也算占用，避免删掉正在写的产物。 */
  isBusy?: (jobId: string) => boolean
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** 成品名：jobId.zip / jobId.txt / jobId.epub / jobId.pdf。 */
const ARTIFACT_NAME = new RegExp(`^(${UUID})\\.(zip|txt|epub|pdf)$`)
/** 失败章节清单：jobId.failed.txt。 */
const FAILED_LIST_NAME = new RegExp(`^(${UUID})\\.failed\\.txt$`)

/** 解析可删的成品名；不是导出产物一律返回 null（临时目录、陌生文件走这里）。 */
export function parseExportFileName(name: string): { jobId: string; kind: ExportFileKind } | null {
  const value = String(name ?? '')
  const failed = FAILED_LIST_NAME.exec(value)
  if (failed) return { jobId: failed[1], kind: 'failed' }
  const artifact = ARTIFACT_NAME.exec(value)
  if (!artifact) return null
  return { jobId: artifact[1], kind: artifact[2] === 'zip' ? 'backup' : 'export' }
}

async function jobOf(jobs: any, jobId: string): Promise<Record<string, any> | null> {
  const job = jobs?.get ? await jobs.get(jobId) : null
  return job && typeof job === 'object' ? job : null
}

/** 作业记录在的话以记录为准（备份/导出的后缀相同也能分清），否则按后缀猜。 */
function classify(parsed: { kind: ExportFileKind }, job: Record<string, any> | null): ExportFileKind {
  if (parsed.kind === 'failed') return 'failed'
  const kind = String(job?.kind ?? '')
  if (kind === 'backup') return 'backup'
  if (kind === 'export') return 'export'
  return parsed.kind
}

const LABELS: Record<ExportFileKind, string> = { backup: '备份', export: '导出', failed: '失败清单' }

function displayNameOf(kind: ExportFileKind, job: Record<string, any> | null, name: string): string {
  if (kind === 'failed') return `${String(job?.bookName ?? '') || '导出'}（失败清单）`
  return String(job?.fileName ?? '') || name
}

/** 正在上传这个备份的 WebDAV 作业；传完才允许删。 */
async function activeUploadOf(jobs: any, jobId: string): Promise<Record<string, any> | null> {
  if (!jobs || typeof jobs.entries !== 'function') return null
  for (const [, record] of (await jobs.entries()) as Iterable<[string, any]>) {
    if (!record || record.kind !== WEBDAV_TRANSFER_KIND) continue
    if (String(record.backupJobId ?? '') !== jobId) continue
    if (!isActiveJob(String(record.status ?? ''))) continue
    return record
  }
  return null
}

/** 不能删的原因；空串表示可以删。 */
async function busyReasonOf(
  jobs: any,
  job: Record<string, any> | null,
  jobId: string,
  kind: ExportFileKind,
  options: ExportFileOptions,
): Promise<string> {
  if (job && isActiveJob(String(job.status ?? ''))) return `${LABELS[kind]}还在进行，完成后再删`
  if (options.isBusy?.(jobId)) return `${LABELS[kind]}还在进行，完成后再删`
  if (await activeUploadOf(jobs, jobId)) return '正在上传备份，完成后再删'
  return ''
}

/** 存储页列表：只收导出根下真实存在的普通成品文件，按修改时间倒序。 */
export async function listExportArtifacts(jobs: any, options: ExportFileOptions = {}): Promise<ExportFileList> {
  const root = exportRoot()
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return { files: [], total: { bytes: 0, files: 0 } }
  }
  const files: ExportFileEntry[] = []
  for (const name of names) {
    const parsed = parseExportFileName(name)
    if (!parsed) continue
    const absolute = join(root, name)
    let info
    try {
      info = await lstat(absolute)
    } catch {
      continue
    }
    if (!info.isFile() || info.isSymbolicLink()) continue
    const job = await jobOf(jobs, parsed.jobId)
    const kind = classify(parsed, job)
    const reason = await busyReasonOf(jobs, job, parsed.jobId, kind, options)
    files.push({
      name,
      jobId: parsed.jobId,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      displayName: displayNameOf(kind, job, name),
      status: String(job?.status ?? ''),
      deletable: !reason,
      reason,
    })
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name))
  return {
    files,
    total: { bytes: files.reduce((sum, file) => sum + file.size, 0), files: files.length },
  }
}

/** 删一个成品：校验名字、确认不是符号链接、进行中/正在上传一律拒绝，最后清作业里的路径。 */
export async function deleteExportArtifact(
  jobs: any,
  name: string,
  options: ExportFileOptions = {},
): Promise<ExportFileDeleteResult> {
  const parsed = parseExportFileName(name)
  if (!parsed) throw new Error('文件名无效，只能删导出文件')
  const absolute = join(exportRoot(), name)
  // 单段正则已经挡住 / 与 ..，这里再核一次解析后的绝对路径确在导出根内。
  if (!resolve(absolute).startsWith(resolve(exportRoot()) + sep)) throw new Error('文件名无效，只能删导出文件')
  let info
  try {
    info = await lstat(absolute)
  } catch {
    throw new Error('文件不存在')
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('文件不存在')

  const job = await jobOf(jobs, parsed.jobId)
  const kind = classify(parsed, job)
  const reason = await busyReasonOf(jobs, job, parsed.jobId, kind, options)
  if (reason) throw new Error(reason)

  await rm(absolute, { force: true })
  if (job) {
    const next = { ...job }
    if (kind === 'failed') {
      next.failedListFile = ''
    } else {
      next.filePath = ''
      if (kind === 'backup') next.bytes = 0
      else {
        next.size = 0
        next.bytes = 0
      }
    }
    next.updatedAt = Date.now()
    await jobs?.put?.(parsed.jobId, next)
  }
  return { name, jobId: parsed.jobId, kind, bytes: info.size }
}

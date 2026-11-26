import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { cacheRoot } from './cache.js'
import { exportRoot } from './exports.js'
import { mediaRoot } from './media-cache.js'

/** 媒体缓存默认配额 50GB（按 GiB 计，50 * 1024^3 字节）。 */
export const DEFAULT_MEDIA_QUOTA_BYTES = 50 * 1024 ** 3
/** 配额上限 10TB：拦住误输入的超大数字，避免把限制设成实际上没有上限。 */
export const MAX_MEDIA_QUOTA_BYTES = 10 * 1024 ** 4

export interface UsageCount {
  bytes: number
  files: number
}

export interface MediaUsage extends UsageCount {
  /** 章节目录数：一章一个目录，等于「已缓存多少章媒体」。 */
  dirs: number
}

export type QuotaSource = 'env' | 'settings' | 'default'

export interface MediaQuota {
  bytes: number
  source: QuotaSource
  /** 设置里存的值，0 表示没设置；界面展示与重置都用它。 */
  settingsBytes: number
}

/** 目录读不到（不存在、无权限）时按空目录处理，用量统计不抛错。 */
async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 递归累加目录内普通文件：符号链接与不存在的目录一律跳过，避免统计跑到缓存根以外。 */
export async function pathSize(dir: string): Promise<UsageCount> {
  const entries = await readDirSafe(dir)
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const child = await pathSize(full)
      bytes += child.bytes
      files += child.files
      continue
    }
    if (!entry.isFile()) continue
    try {
      const info = await stat(full)
      bytes += info.size
      files += 1
    } catch {
      // 扫描期间被删掉的文件直接跳过。
    }
  }
  return { bytes, files }
}

/** 文字缓存用量：缓存根下的 .txt 文件；媒体与文字同根时跳过媒体目录，避免重复计算。 */
export async function textCacheUsage(): Promise<UsageCount> {
  const skipDir = path.resolve(mediaRoot())
  return countTextFiles(cacheRoot(), skipDir)
}

async function countTextFiles(dir: string, skipDir: string): Promise<UsageCount> {
  const entries = await readDirSafe(dir)
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path.resolve(full) === skipDir) continue
      const child = await countTextFiles(full, skipDir)
      bytes += child.bytes
      files += child.files
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.txt')) continue
    try {
      const info = await stat(full)
      bytes += info.size
      files += 1
    } catch {
      // 同上：扫描期间被删掉的文件跳过。
    }
  }
  return { bytes, files }
}

/** 媒体缓存用量：媒体根下每个子目录是一章，聚合字节数与文件数。 */
export async function mediaUsage(): Promise<MediaUsage> {
  const root = mediaRoot()
  const entries = await readDirSafe(root)
  let bytes = 0
  let files = 0
  let dirs = 0
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    dirs += 1
    const child = await pathSize(path.join(root, entry.name))
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files, dirs }
}

/** 导出产物用量：产物保留 24 小时自动清理，不进配额淘汰。 */
export async function exportUsage(): Promise<UsageCount> {
  return pathSize(exportRoot())
}

/** 环境变量优先，只认正整数；非法值忽略，回落到设置或默认。 */
function envQuotaBytes(): number | null {
  const raw = (process.env.MO_READER_MEDIA_QUOTA_BYTES ?? '').trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/** 生效配额：环境变量 > 设置（>0 才算设置过）> 默认 50GB。 */
export function resolveMediaQuota(settings: { mediaQuotaBytes?: unknown } | null | undefined): MediaQuota {
  const raw = Number(settings?.mediaQuotaBytes)
  const settingsBytes = Number.isSafeInteger(raw) && raw > 0 ? raw : 0
  const env = envQuotaBytes()
  if (env !== null) return { bytes: env, source: 'env', settingsBytes }
  if (settingsBytes > 0) return { bytes: settingsBytes, source: 'settings', settingsBytes }
  return { bytes: DEFAULT_MEDIA_QUOTA_BYTES, source: 'default', settingsBytes }
}

/** 配额文案：整 GiB 不显示小数，否则保留一位。 */
export function formatQuotaBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3
  return Number.isInteger(gib) ? `${gib} GiB` : `${gib.toFixed(1)} GiB`
}

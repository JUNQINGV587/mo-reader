import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 文字缓存根目录：存储页统计与测试需要它，环境变量优先。 */
export function cacheRoot(): string {
  return process.env.MO_READER_CACHE_ROOT || path.join(homedir(), '.dsh', 'reader', 'cache')
}

function keyOf(sourceUrl: string, chapterUrl: string): string {
  return createHash('sha1').update(`${sourceUrl}|${chapterUrl}`).digest('hex')
}

function fileOf(sourceUrl: string, chapterUrl: string): string {
  return path.join(cacheRoot(), `${keyOf(sourceUrl, chapterUrl)}.txt`)
}

export async function readCachedChapter(sourceUrl: string, chapterUrl: string): Promise<string | null> {
  try {
    return await readFile(fileOf(sourceUrl, chapterUrl), 'utf8')
  } catch {
    return null
  }
}

export async function writeCachedChapter(sourceUrl: string, chapterUrl: string, text: string): Promise<number> {
  await mkdir(cacheRoot(), { recursive: true })
  const file = fileOf(sourceUrl, chapterUrl)
  await writeFile(file, text, 'utf8')
  return Buffer.byteLength(text, 'utf8')
}

export async function cachedChapterSize(sourceUrl: string, chapterUrl: string): Promise<number> {
  try {
    const info = await stat(fileOf(sourceUrl, chapterUrl))
    return info.isFile() ? info.size : 0
  } catch {
    return 0
  }
}

export async function hasCachedChapter(sourceUrl: string, chapterUrl: string): Promise<boolean> {
  return (await cachedChapterSize(sourceUrl, chapterUrl)) > 0
}

export async function clearChapterCache(sourceUrl: string, chapterUrl?: string): Promise<number> {
  if (chapterUrl) {
    await rm(fileOf(sourceUrl, chapterUrl), { force: true })
    return 1
  }
  await clearAllChapterCache()
  return 0
}

/**
 * 清空全部文字缓存（含没有索引归属的历史文件）。
 * 媒体目录与文字缓存同根（默认 cache/media），传 keepDir 时保住它：
 * 否则「清空文字缓存」会把已下载的媒体文件一起删掉、媒体索引却还在。
 */
export async function clearAllChapterCache(keepDir?: string): Promise<void> {
  const root = path.resolve(cacheRoot())
  const keep = keepDir ? path.resolve(keepDir) : ''
  if (!keep) {
    await rm(root, { force: true, recursive: true })
    return
  }
  if (keep === root) {
    // 媒体根就是缓存根（显式配置或测试）：只清文字文件，媒体章节目录保留。
    await removeFilesOnly(root)
    return
  }
  if (!keep.startsWith(root + path.sep)) {
    // 媒体根不在缓存根里：整个文字缓存可以放心删。
    await rm(root, { force: true, recursive: true })
    return
  }
  await removeExcept(root, keep)
}

/** 缓存根即媒体根时，删掉根下的文件、保留子目录（媒体一章一个目录）。 */
async function removeFilesOnly(dir: string): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    if (entry.isDirectory()) continue
    await rm(path.join(dir, entry.name), { force: true, recursive: true })
  }
}

/** 递归删除除 keep 子树以外的内容；keep 的祖先目录继续下钻而不是整删。 */
async function removeExcept(dir: string, keep: string): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    const full = path.resolve(dir, entry.name)
    if (full === keep) continue
    if (keep.startsWith(full + path.sep)) {
      if (entry.isDirectory()) await removeExcept(full, keep)
      continue
    }
    await rm(full, { force: true, recursive: true })
  }
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

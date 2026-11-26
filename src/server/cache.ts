import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
  await rm(cacheRoot(), { force: true, recursive: true })
  return 0
}

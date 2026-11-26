import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * 媒体离线缓存：每章一个目录，目录名由书 id 与章序号派生，文件名固定为序号.ext。
 * 与文字缓存同属一个缓存根，但单独放 media/ 子目录，删除互不影响。
 */
const MEDIA_DIR_NAME = 'media'
/** 单个媒体文件上限 4GB：拦住误抓的超大文件，正常电影/整章漫画远低于它。 */
export const MEDIA_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
/** 暂停/取消/宿主卸载时中断在途下载的错误文案，调用方按「已中断」处理，不计失败次数。 */
export const MEDIA_ABORTED_MESSAGE = '媒体下载已中断'

/** 测试可用 MO_READER_MEDIA_ROOT 指向临时目录，避免写用户的真实缓存。 */
export function mediaRoot(): string {
  const explicit = (process.env.MO_READER_MEDIA_ROOT ?? '').trim()
  if (explicit) return explicit
  const cacheRoot = (process.env.MO_READER_CACHE_ROOT ?? '').trim() || join(homedir(), '.dsh', 'reader', 'cache')
  return join(cacheRoot, MEDIA_DIR_NAME)
}

/** 这本书所有章节目录的公共前缀；删书时用它扫出没有索引归属的半成品。 */
export function mediaStorePrefix(bookId: string): string {
  const digest = createHash('sha1').update(bookId).digest('hex').slice(0, 16)
  return `me-${digest}-`
}

/** 索引 key 与目录名同源：bookId 可能含任意字符，先哈希再拼章序号。 */
export function mediaEntryKey(bookId: string, chapterIndex: number): string {
  return `${mediaStorePrefix(bookId)}${Math.max(0, Math.floor(chapterIndex))}`
}

/** 单章目录：一章一个目录，下载失败时整体删掉，不留下半成品。 */
export function mediaStoreId(bookId: string, chapterIndex: number): string {
  return mediaEntryKey(bookId, chapterIndex)
}

/** 本地媒体文件 id：URL 里只出现这段不可猜测的摘要，文件路径永远由服务端拼。 */
export function mediaFileIdOf(storeId: string, index: number): string {
  return createHash('sha1').update(`${storeId}|${index}`).digest('hex').slice(0, 24)
}

/** 目录内文件名：序号 + 扩展名，扩展名由 media.ts 的 extFromUrl 归一化过。 */
export function mediaFileName(index: number, ext: string): string {
  const safe = /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'bin'
  return `${index}.${safe}`
}

/** 准备（或清空）一章的目录；重下时先删旧文件，避免旧图混进新索引。 */
export async function prepareMediaDir(storeId: string): Promise<string> {
  const dir = join(mediaRoot(), storeId)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  return dir
}

export async function clearMediaDir(storeId: string): Promise<void> {
  await rm(join(mediaRoot(), storeId), { recursive: true, force: true })
}

/** 删掉这本书名下所有媒体目录，包括暂停/失败后半成品这类没有索引归属的残留。 */
export async function clearBookMediaDirs(bookId: string): Promise<void> {
  const root = mediaRoot()
  const prefix = mediaStorePrefix(bookId)
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    await rm(join(root, entry.name), { recursive: true, force: true })
  }
}

/** 清空全部媒体缓存（测试与「清空下载」使用）。 */
export async function clearMediaRoot(): Promise<void> {
  await rm(mediaRoot(), { recursive: true, force: true })
}

export async function writeMediaFile(storeId: string, name: string, data: Uint8Array): Promise<number> {
  const dir = join(mediaRoot(), storeId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, name), data)
  const info = await stat(join(dir, name))
  return info.size
}

/**
 * 边流边落盘：视频可能有几百 MB，不能整个读进内存。
 * 写入前检查响应体上限，超限中断并保留部分文件（由调用方清理整章目录）。
 */
export async function saveMediaStream(
  storeId: string,
  name: string,
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<number> {
  const dir = join(mediaRoot(), storeId)
  await mkdir(dir, { recursive: true })
  const target = join(dir, name)
  if (!body) {
    await writeFile(target, Buffer.alloc(0))
    return 0
  }
  if (signal?.aborted) throw new Error(MEDIA_ABORTED_MESSAGE)
  let total = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > MEDIA_MAX_FILE_BYTES) {
        callback(new Error('媒体文件过大'))
        return
      }
      callback(null, chunk)
    },
  })
  // 暂停/宿主卸载时中断在途的大文件：否则关停要等整部视频下载完。
  const onAbort = () => counter.destroy(new Error(MEDIA_ABORTED_MESSAGE))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await pipeline(Readable.fromWeb(body as any), counter, createWriteStream(target))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return total
}

/** 本地文件大小；不存在或不是普通文件时返回 null。 */
export async function mediaFileSize(storeId: string, name: string): Promise<number | null> {
  try {
    const info = await stat(join(mediaRoot(), storeId, name))
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

/**
 * 索引记录的大小与实际文件是否可信：旧索引 bytes<=0 表示「未知」，只看文件非空；
 * 记录了大小的必须相等，非零截断会在这里被判失效。
 */
export function recordedBytesMatch(recorded: unknown, actual: number): boolean {
  if (!Number.isFinite(actual) || actual <= 0) return false
  const expected = Number(recorded)
  if (!Number.isFinite(expected) || expected <= 0) return true
  return actual === expected
}

export interface MediaFileOnDisk {
  name: string
  bytes: number
}

/**
 * 发布索引前的权威校验：每个文件都必须落盘、记录过正数大小、且 stat 与记录相等。
 * 校验不过就不写索引，避免把半份文件发布成「可离线播放」。
 */
export async function assertMediaFilesOnDisk(
  storeId: string,
  files: MediaFileOnDisk[],
): Promise<void> {
  if (files.length === 0) throw new Error('媒体文件校验失败：没有可发布的文件')
  for (const file of files) {
    const recorded = Number(file.bytes)
    if (!Number.isFinite(recorded) || recorded <= 0) {
      throw new Error(`媒体文件校验失败：${file.name} 未记录大小`)
    }
    const actual = await mediaFileSize(storeId, file.name)
    if (actual === null) throw new Error(`媒体文件校验失败：${file.name} 未落盘`)
    if (actual !== recorded) {
      throw new Error(
        `媒体文件校验失败：${file.name} 记录 ${recorded} 字节，实际 ${actual} 字节`,
      )
    }
  }
}

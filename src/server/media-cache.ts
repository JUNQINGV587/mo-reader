import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
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

/** 索引 key 与目录名同源：bookId 可能含任意字符，先哈希再拼章序号。 */
export function mediaEntryKey(bookId: string, chapterIndex: number): string {
  const digest = createHash('sha1').update(bookId).digest('hex').slice(0, 16)
  return `me-${digest}-${Math.max(0, Math.floor(chapterIndex))}`
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

/** 本地文件是否还在：索引存在但文件被删时，阅读要回退在线播放。 */
export async function mediaFilePresent(storeId: string, name: string): Promise<boolean> {
  try {
    const info = await stat(join(mediaRoot(), storeId, name))
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

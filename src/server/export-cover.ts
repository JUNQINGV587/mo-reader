/**
 * 封面抓取：能安全拿到就返回可直接嵌入 EPUB 的图片，拿不到一律返回 null。
 * 封面只是加分项，任何失败都不能影响整本导出。
 */
import { fetchBinary } from '../core/net/http.js'
import type { EpubCover } from './epub-export.js'

/** 封面体积上限，与 fetchBinary 默认值一致；超过就当没有封面。 */
const MAX_COVER_BYTES = 2 * 1024 * 1024
/** 封面抓取超时：慢站不能让整本导出卡住。 */
const COVER_TIMEOUT_MS = 10_000

const CONTENT_TYPE_EXTENSIONS: Record<string, EpubCover['extension']> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function coverOf(mediaType: string, data: Buffer): EpubCover | null {
  const normalized = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  const extension = CONTENT_TYPE_EXTENSIONS[normalized]
  if (!extension || !data.length || data.length > MAX_COVER_BYTES) return null
  return { data, mediaType: normalized, extension }
}

/** data: URL 直接内嵌，不去抓网络（书源自带的小封面常见这种写法）。 */
function decodeDataUrl(coverUrl: string): EpubCover | null {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is.exec(coverUrl)
  if (!match) return null
  try {
    const data = Buffer.from(match[2], 'base64')
    return coverOf(match[1], data)
  } catch {
    return null
  }
}

/**
 * 按书籍元数据里的 coverUrl 取封面：
 * - 空值、data: 非图片、抓取失败、非 2xx、非 image/*、体积超限都返回 null；
 * - 只有 http(s) 才走网络，且经过 fetchBinary 的 SSRF 守卫与重定向复检。
 */
export async function loadCoverImage(coverUrl: string | null | undefined): Promise<EpubCover | null> {
  const raw = coverUrl?.trim()
  if (!raw) return null
  if (raw.startsWith('data:')) return decodeDataUrl(raw)
  if (!/^https?:\/\//i.test(raw)) return null
  try {
    const result = await fetchBinary(raw, { maxBytes: MAX_COVER_BYTES, timeoutMs: COVER_TIMEOUT_MS })
    if (result.status < 200 || result.status >= 300) return null
    if (!/^image\//i.test(result.contentType.split(';')[0]?.trim() ?? '')) return null
    return coverOf(result.contentType, result.data)
  } catch {
    return null
  }
}

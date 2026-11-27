/**
 * per-record 存储的 key 会变成 `<unit>/<table>/<key>.json` 的路径段，
 * 只接受字母、数字、下划线与连字符；URL、中文名等都要先折叠。
 */
import { createHash } from 'node:crypto'

export const STORAGE_KEY_RE = /^[A-Za-z0-9_-]+$/

/** 兼容旧数据的书源 key 规则：本来就是安全小写串的直接沿用。 */
const LEGACY_SAFE_KEY = /^[a-z][a-z0-9_-]+$/

export function isStorageKey(value: unknown): value is string {
  return typeof value === 'string' && STORAGE_KEY_RE.test(value)
}

/** 书源的稳定存储 key：安全串原样用，完整 URL 转成 `src-<sha1 24>`。 */
export function bookSourceStorageKey(bookSourceUrl: string): string {
  return LEGACY_SAFE_KEY.test(bookSourceUrl)
    ? bookSourceUrl
    : `src-${createHash('sha1').update(bookSourceUrl).digest('hex').slice(0, 24)}`
}
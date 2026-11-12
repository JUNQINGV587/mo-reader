import { ReaderError } from './errors.js'

export function parseRangeHeader(value, size) {
  if (!Number.isSafeInteger(size) || size < 0) throw new ReaderError('reader/invalid-media', '媒体长度无效。')
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim()
  const match = /^bytes=(\d*)-(\d*)$/.exec(text)
  if (!match || (match[1] === '' && match[2] === '')) throw new ReaderError('reader/invalid-range', 'Range 头无效。')
  const [, rawStart, rawEnd] = match
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ReaderError('reader/invalid-range', 'Range 后缀无效。')
    const start = Math.max(0, size - suffix)
    if (size === 0) throw new ReaderError('reader/range-not-satisfiable', '媒体为空，无法提供 Range。')
    return { start, end: size - 1 }
  }
  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new ReaderError('reader/invalid-range', 'Range 头无效。')
  }
  if (start >= size) throw new ReaderError('reader/range-not-satisfiable', 'Range 超出媒体长度。')
  return { start, end: Math.min(end, size - 1) }
}

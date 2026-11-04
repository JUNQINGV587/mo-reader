import { createHash, randomUUID } from 'node:crypto'
import { ReaderError } from './errors.js'

export const MAX_TEXT_BYTES = 16 * 1024 * 1024
export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024

export function now() {
  return new Date().toISOString()
}

export function id(prefix = 'reader') {
  return `${prefix}-${randomUUID()}`
}

export function stableId(...parts) {
  return createHash('sha256').update(parts.map(part => String(part)).join('\0')).digest('hex').slice(0, 24)
}

export function requiredString(value, label, max = 1000) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ReaderError('reader/invalid-input', `${label} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

export function pageNumber(value) {
  const page = value ?? 1
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) {
    throw new ReaderError('reader/invalid-input', 'page must be an integer from 1 through 100000.')
  }
  return page
}

export function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

export function textToBuffer(text, maxBytes = MAX_TEXT_BYTES) {
  if (typeof text !== 'string') throw new ReaderError('reader/invalid-input', 'Expected text content.')
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length > maxBytes) throw new ReaderError('reader/too-large', `Text exceeds the ${maxBytes}-byte limit.`)
  return buffer
}

export function base64ToBuffer(base64, maxBytes = MAX_ARCHIVE_BYTES) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    throw new ReaderError('reader/too-large', 'Base64 input exceeds the configured size limit.')
  }
  if (!/^[A-Za-z0-9+/\s]*={0,2}\s*$/.test(base64)) {
    throw new ReaderError('reader/invalid-input', 'Invalid base64 input.')
  }
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > maxBytes) throw new ReaderError('reader/too-large', `Input exceeds the ${maxBytes}-byte limit.`)
  return buffer
}

export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function chapterId(bookId, key) {
  return `c-${stableId(bookId, key)}`
}

import { ReaderError } from './errors.js'

export const BOOK_CONTENT_TYPES = Object.freeze(['novel', 'comic', 'audio', 'video'])

const LEGADO_TYPES = new Map([
  [0, 'novel'],
  [1, 'audio'],
  [2, 'comic'],
  [4, 'video'],
])

export function contentTypeFromLegado(value) {
  const type = value === undefined || value === null || value === '' ? 0 : Number(value)
  const contentType = LEGADO_TYPES.get(type)
  if (!contentType) {
    const detail = type === 3 ? '网络文件书源' : `书源类型 ${Number.isFinite(type) ? type : String(value)}`
    throw new ReaderError('reader/unsupported-source', `不支持${detail}：请使用 Legado 类型 0/1/2/4 的书源。`)
  }
  return contentType
}

export function normalizeBookContentType(value) {
  return BOOK_CONTENT_TYPES.includes(value) ? value : 'novel'
}

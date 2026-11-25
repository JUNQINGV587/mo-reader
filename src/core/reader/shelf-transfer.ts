/**
 * 书架元数据迁移：Legado books.json 与墨读全量 JSON 的解析、去重和导出。
 * 这里只处理书目与阅读进度，不接触正文、章节缓存或封面文件。
 */

export const FULL_SHELF_FORMAT = 'mo-reader-books'
export const FULL_SHELF_VERSION = 1

export interface ShelfProgress {
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  position: number
  updatedAt: string | number
}

export interface TransferBook {
  name: string
  author: string
  bookUrl: string
  origin: string
  originName: string
  type: number
  group: string
  coverUrl: string
  intro: string
  totalChapterNum: number
  wordCount: string
  rating: string
  pinned: boolean
  latestChapterTitle: string
  lastReadAt: string | number
  createdAt: string | number
  updatedAt: string | number
  metadataOnly: boolean
  localMissing: boolean
  progress: ShelfProgress | null
  [key: string]: unknown
}

export interface ShelfImportResult {
  books: TransferBook[]
  source: 'mo-reader' | 'legado'
  duplicates: number
}

const MAX_BOOKS = 5000
const PRIVATE_COVER = /^data:/i
const BLOCKED_KEYS = new Set([
  'content',
  'contents',
  'chapter',
  'chapters',
  'chapterList',
  'text',
  'html',
  'body',
  'epub',
  'file',
  'fileData',
  'filePath',
  'buffer',
  'blob',
  'cache',
  'coverFile',
])
const SIMULATE_KEYS = [
  'simulateEnabled',
  'simulateStartDate',
  'simulateStartChapter',
  'simulateDailyChapters',
] as const

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function limitedText(value: unknown, limit: number, fallback = ''): string {
  return text(value, fallback).slice(0, limit)
}

function integer(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback
}

function typeValue(value: unknown): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= 4 ? number : 0
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

/** 保留时间戳原类型；数字与 ISO 字符串都能参与书架排序。 */
function timestamp(value: unknown, fallback: string | number = 0): string | number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 没有 origin/bookUrl 的 Legado 条目使用稳定的本地占位地址，重复导入仍能命中同一本。 */
function fallbackUrl(name: string, author: string): string {
  return `legado://${hashText(`${name.toLowerCase()}|${author.toLowerCase()}`)}`
}

function normalizeProgress(value: unknown): ShelfProgress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  return {
    chapterIndex: integer(source.chapterIndex ?? source.durChapterIndex),
    chapterTitle: limitedText(source.chapterTitle ?? source.durChapterTitle, 300),
    chapterUrl: limitedText(source.chapterUrl, 4096),
    position: integer(source.position ?? source.durChapterPos),
    updatedAt: timestamp(source.updatedAt ?? source.durChapterTime),
  }
}

function rawProgress(source: Record<string, unknown>): ShelfProgress | null {
  const explicit = normalizeProgress(source.progress)
  if (explicit) return explicit
  if (
    source.durChapterIndex !== undefined ||
    source.durChapterTitle !== undefined ||
    source.durChapterPos !== undefined ||
    source.durChapterTime !== undefined
  ) {
    return normalizeProgress(source)
  }
  return null
}

function sanitizeCover(value: unknown): string {
  const cover = limitedText(value, 4096)
  // 不把内嵌 base64 图片当作元数据导出，避免变相搬运封面文件。
  return PRIVATE_COVER.test(cover) ? '' : cover
}

function normalizeBook(raw: unknown, index: number): TransferBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`第 ${index + 1} 本不是对象`)
  }
  const source = raw as Record<string, unknown>
  const name = limitedText(source.name ?? source.bookName, 200)
  if (!name) throw new Error(`第 ${index + 1} 本缺少书名`)

  const author = limitedText(source.author, 200)
  let origin = limitedText(source.origin, 2048)
  let bookUrl = limitedText(source.bookUrl, 4096)
  if (!bookUrl) {
    origin = origin || 'legado'
    bookUrl = fallbackUrl(name, author)
  } else if (!origin) {
    origin = 'legado'
  }

  const book: TransferBook = {
    name,
    author,
    bookUrl,
    origin,
    originName: limitedText(source.originName, 200),
    type: typeValue(source.type),
    group: limitedText(source.group, 80),
    coverUrl: sanitizeCover(source.coverUrl),
    intro: limitedText(source.intro, 20_000),
    totalChapterNum: integer(source.totalChapterNum),
    wordCount: limitedText(source.wordCount, 80),
    rating: limitedText(source.rating, 80),
    pinned: boolean(source.pinned),
    latestChapterTitle: limitedText(source.latestChapterTitle, 300),
    lastReadAt: timestamp(source.lastReadAt),
    createdAt: timestamp(source.createdAt),
    updatedAt: timestamp(source.updatedAt),
    // 没有真实来源的书只能保留书目，避免被误认为可以直接阅读。
    metadataOnly: boolean(source.metadataOnly) || (origin === 'legado' && bookUrl.startsWith('legado://')),
    localMissing: boolean(source.localMissing),
    progress: rawProgress(source),
  }

  for (const key of SIMULATE_KEYS) {
    if (source[key] !== undefined) book[key] = source[key]
  }
  return book
}

/** 用于导入去重的稳定键：有 URL 用 URL，同时保留书名+作者键以兼容缺 URL 的数据。 */
export function shelfDedupKeys(book: Pick<TransferBook, 'name' | 'author' | 'origin' | 'bookUrl'>): string[] {
  const keys = [`meta:${book.name.toLowerCase()}|${book.author.toLowerCase()}`]
  if (book.origin && book.bookUrl) keys.push(`url:${book.origin}|${book.bookUrl}`)
  return keys
}

/** 一次解析整个书架文件；任意一本失败都整体拒绝，不产生半成品。 */
export function parseShelfImport(input: string): ShelfImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error('书架文件不是有效 JSON')
  }

  let list: unknown[]
  let source: ShelfImportResult['source']
  if (Array.isArray(parsed)) {
    list = parsed
    source = 'legado'
  } else if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const object = parsed as Record<string, unknown>
    if (!Array.isArray(object.books)) {
      throw new Error('书架文件应为 Legado books.json 数组，或墨读全量书架 JSON')
    }
    list = object.books
    source = object.format === FULL_SHELF_FORMAT ? 'mo-reader' : 'legado'
  } else {
    throw new Error('书架文件应为 Legado books.json 数组，或墨读全量书架 JSON')
  }

  if (list.length === 0) throw new Error('书架文件里没有书籍')
  if (list.length > MAX_BOOKS) throw new Error(`一次最多导入 ${MAX_BOOKS} 本书`)

  const books: TransferBook[] = []
  const errors: string[] = []
  list.forEach((item, index) => {
    try {
      books.push(normalizeBook(item, index))
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  })
  if (errors.length) throw new Error(`书架导入失败，未写入任何书籍：${errors.slice(0, 3).join('；')}`)

  const seen = new Set<string>()
  const unique: TransferBook[] = []
  let duplicates = 0
  for (const book of books) {
    const keys = shelfDedupKeys(book)
    if (keys.some((key) => seen.has(key))) {
      duplicates += 1
      continue
    }
    for (const key of keys) seen.add(key)
    unique.push(book)
  }
  return { books: unique, source, duplicates }
}

function sanitizeProgress(value: unknown): ShelfProgress | null {
  const progress = normalizeProgress(value)
  if (!progress) return null
  return {
    chapterIndex: progress.chapterIndex,
    chapterTitle: progress.chapterTitle,
    chapterUrl: progress.chapterUrl,
    position: progress.position,
    updatedAt: progress.updatedAt,
  }
}

function metaOf(book: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const fields = [
    'name',
    'author',
    'bookUrl',
    'origin',
    'originName',
    'type',
    'group',
    'coverUrl',
    'intro',
    'totalChapterNum',
    'wordCount',
    'rating',
    'pinned',
    'latestChapterTitle',
    'lastReadAt',
    'createdAt',
    'updatedAt',
    'metadataOnly',
    'localMissing',
  ]
  for (const field of fields) {
    if (book[field] !== undefined) result[field] = book[field]
  }
  if (typeof result.coverUrl === 'string') result.coverUrl = sanitizeCover(result.coverUrl)
  for (const key of SIMULATE_KEYS) {
    if (book[key] !== undefined) result[key] = book[key]
  }
  // 只保留简单的附加标量，彻底挡住正文/章节/文件字段。
  for (const [key, value] of Object.entries(book)) {
    if (result[key] !== undefined || BLOCKED_KEYS.has(key) || key === 'progress' || key === 'id') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value
    }
  }
  return result
}

function progressTime(value: string | number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

/** Legado 兼容版：只输出书目和阅读进度字段。 */
export function exportLegadoShelf(books: Record<string, unknown>[]): Record<string, unknown>[] {
  return books.map((book) => {
    const meta = metaOf(book)
    const progress = sanitizeProgress(book.progress)
    return {
      name: meta.name ?? '',
      author: meta.author ?? '',
      bookUrl: meta.bookUrl ?? '',
      origin: meta.origin ?? '',
      originName: meta.originName ?? '',
      type: meta.type ?? 0,
      group: meta.group ?? '',
      coverUrl: meta.coverUrl ?? '',
      intro: meta.intro ?? '',
      totalChapterNum: meta.totalChapterNum ?? 0,
      latestChapterTitle: meta.latestChapterTitle ?? '',
      lastReadAt: meta.lastReadAt ?? 0,
      durChapterIndex: progress?.chapterIndex ?? 0,
      durChapterTitle: progress?.chapterTitle ?? '',
      durChapterPos: progress?.position ?? 0,
      durChapterTime: progress ? progressTime(progress.updatedAt) : 0,
    }
  })
}

/** 墨读全量版：保留书目字段和阅读进度，不含任何正文/缓存/封面文件。 */
export function exportFullShelf(books: Record<string, unknown>[]): Record<string, unknown> {
  return {
    format: FULL_SHELF_FORMAT,
    version: FULL_SHELF_VERSION,
    exportedAt: new Date().toISOString(),
    books: books.map((book) => ({
      ...metaOf(book),
      progress: sanitizeProgress(book.progress),
    })),
  }
}

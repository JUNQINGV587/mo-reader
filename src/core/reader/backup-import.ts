/**
 * 备份导入（#132）：解析墨读备份 zip、旧书架 JSON 与「阅读」未加密 zip，
 * 再按合并规则算出「预览 + 写入计划」。这里全是纯函数，不碰文件系统与数据库。
 *
 * 安全性由本模块把关：zip 只读中央目录，先校验条目名与声明大小，再只解压清单声明的文件；
 * 路径穿越、绝对路径、盘符、符号链接、加密条目与超限都在解压前拒绝。
 */

import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import {
  BACKUP_COVERS_DIR,
  BACKUP_FORMAT,
  BACKUP_MANIFEST_FILE,
  BACKUP_MAX_COVER_BYTES,
  BACKUP_SECTION_FILES,
  FULL_BACKUP_SECTIONS,
  parseBackupManifest,
  type BackupSection,
} from './backup.js'
import {
  FULL_SHELF_FORMAT,
  FULL_SHELF_VERSION,
  parseShelfImport,
  type TransferBook,
} from './shelf-transfer.js'

/** 单条目解压上限：64 MB。 */
export const IMPORT_MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** 单次导入解压总量上限：512 MB。 */
export const IMPORT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
/** 单个备份最多多少个 zip 条目。 */
export const IMPORT_MAX_ENTRIES = 20000
/** 上传的备份文件上限；远程调用以 base64 传输，再大内存不可控。 */
export const IMPORT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024

/** 导入来源。 */
export type ImportKind = 'mo-reader-backup' | 'legado-backup' | 'shelf-json'

export interface ImportedBook {
  backupId: string
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
}

export interface ImportedProgress {
  bookId: string
  bookName: string
  bookAuthor: string
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  position: number
  updatedAt: string | number
}

export interface ImportedBookmark {
  bookId: string
  bookName: string
  bookAuthor: string
  type: string
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  page: number
  text: string
  note: string
  createdAt: string | number
}

export interface ImportedNote extends ImportedBookmark {
  quote: string
  content: string
}

export interface ImportedGroup {
  id: string
  name: string
}

export interface ImportedThemeConfig {
  theme: string
  customThemes: Record<string, unknown>[]
}

export interface ImportedBackup {
  kind: ImportKind
  version: number | null
  exportedAt: string | null
  appName: string
  light: boolean
  books: ImportedBook[]
  sources: Record<string, unknown>[]
  groups: ImportedGroup[]
  bookmarks: ImportedBookmark[]
  notes: ImportedNote[]
  progress: ImportedProgress[]
  readConfigs: Record<string, unknown>[]
  settings: Record<string, unknown> | null
  themes: ImportedThemeConfig | null
  replaceRules: Record<string, unknown>[]
  dictRules: Record<string, unknown>[]
  subscriptions: Record<string, unknown>[]
  /** 封面：备份里的书 id → data URL。 */
  covers: Record<string, string>
  warnings: string[]
  /** 备份里有、但这版暂不导入的数据文件。 */
  skippedSections: string[]
}

export interface BackupImportInput {
  data: Uint8Array | string
  fileName?: string
}

/** 导入预览里的一类数据计数。 */
export interface ImportCategoryCount {
  total: number
  added: number
  updated: number
  skipped: number
}

export interface BackupImportPreview {
  kind: ImportKind
  version: number | null
  exportedAt: string | null
  appName: string
  light: boolean
  books: ImportCategoryCount
  sources: ImportCategoryCount
  groups: ImportCategoryCount
  bookmarks: ImportCategoryCount
  notes: ImportCategoryCount
  progress: ImportCategoryCount
  readConfigs: ImportCategoryCount
  dictRules: ImportCategoryCount
  subscriptions: ImportCategoryCount
  replaceRules: ImportCategoryCount
  themes: { total: number; added: number; skipped: number }
  /** 实际会补进本机设置的字段（机器名，界面用 backupImportSettingLabel 显示）。 */
  settings: { added: string[]; skipped: number }
  covers: number
  warnings: string[]
}

export type ImportTable =
  | 'books'
  | 'sources'
  | 'groups'
  | 'bookmarks'
  | 'notes'
  | 'readRecords'
  | 'readConfigs'
  | 'dictRules'
  | 'subscriptions'

export interface BackupImportOperation {
  table: ImportTable
  key: string
  record: Record<string, unknown>
  existed: boolean
}

export interface BackupImportExisting {
  books: Record<string, unknown>[]
  sources: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  bookmarks: Record<string, unknown>[]
  notes: Record<string, unknown>[]
  progress: Record<string, unknown>[]
  readConfigs: Record<string, unknown>[]
  dictRules: Record<string, unknown>[]
  subscriptions: Record<string, unknown>[]
  settings: Record<string, unknown>
}

export interface BackupImportMergeInput {
  backup: ImportedBackup
  existing: BackupImportExisting
  /** 新增记录的创建时间；测试可固定。 */
  now?: string
}

export interface BackupImportPlan {
  preview: BackupImportPreview
  operations: BackupImportOperation[]
  /** 合并后的完整全局设置；没有变化时为 null。 */
  settings: Record<string, unknown> | null
  warnings: string[]
}

const SETTING_LABELS: Record<string, string> = {
  theme: '主题',
  fontId: '字体',
  fontFamily: '字体',
  fontSize: '字号',
  letterSpacing: '字距',
  lineSpacing: '行距',
  paragraphSpacing: '段距',
  indent: '首行缩进',
  bold: '加粗',
  titleMode: '标题样式',
  titleSize: '标题字号',
  align: '对齐',
  compressPunctuation: '标点压缩',
  kinsoku: '避头尾',
  padding: '页边距',
  headerMode: '页眉',
  footerMode: '页脚',
  showHeaderLine: '页眉线',
  showFooterLine: '页脚线',
  dualColumn: '双栏',
  inkMode: '墨水屏',
  pageAnimation: '翻页动画',
  tapZones: '点击区域',
  menuItems: '菜单项',
  autoPageSeconds: '自动翻页',
  ttsVoice: '朗读音色',
  ttsRate: '朗读速度',
  ttsContinuous: '连续朗读',
  mediaQuotaBytes: '缓存上限',
  webdavUrl: 'WebDAV 地址',
  webdavUsername: 'WebDAV 账号',
  webdavAllowPrivate: 'WebDAV 私网',
}

/** 设置字段的中文名；界面展示「将补设置项」时用。 */
export function backupImportSettingLabel(key: string): string {
  return SETTING_LABELS[key] ?? key
}

/** settings.json 里由专门区块处理、或绝不能落盘的字段。 */
const SKIP_SETTING_KEYS = new Set(['theme', 'customThemes', 'replaceRules', 'webdavPassword'])

const COVER_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

const KNOWN_SECTION_FILES = new Set(Object.values(BACKUP_SECTION_FILES))
const LEGADO_SECTION_FILES = new Set([
  'bookshelf.json',
  'bookSource.json',
  'bookGroup.json',
  'bookmark.json',
  'bookMark.json',
  'note.json',
  'notes.json',
  'readConfig.json',
  'readRecord.json',
  'settings.json',
  'themeConfig.json',
  'replaceRule.json',
  'dictRule.json',
  'rssSource.json',
  'subscription.json',
])

interface ZipEntry {
  name: string
  flags: number
  method: number
  compressedSize: number
  size: number
  localOffset: number
  externalAttrs: number
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function integer(value: unknown, fallback = 0): number {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback
}

function timestamp(value: unknown, fallback: string | number = 0): string | number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim()) return value.trim()
  return fallback
}

function boolean(value: unknown): boolean {
  return value === true || value === 1 || value === 'true'
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function recordsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
}

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function hashText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 没有 origin/bookUrl 的条目使用稳定的本地占位地址，重复导入仍能命中同一本。 */
function fallbackUrl(name: string, author: string): string {
  return `legado://${hashText(`${name.toLowerCase()}|${author.toLowerCase()}`)}`
}

function safeId(value: unknown): string {
  const id = text(value)
  return /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(id) ? id : ''
}

function meaningful(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'boolean') return value === true
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function sameRecord(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false
  }
  return true
}

function emptyCount(): ImportCategoryCount {
  return { total: 0, added: 0, updated: 0, skipped: 0 }
}

/** 上传的备份大小上限；超了直接拒绝，避免 base64 解码拖垮进程。 */
export function assertImportArchiveSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('备份文件大小无效')
  if (bytes > IMPORT_MAX_ARCHIVE_BYTES) {
    throw new Error(`备份文件过大（${Math.ceil(bytes / 1024 / 1024)} MB，最多 ${IMPORT_MAX_ARCHIVE_BYTES / 1024 / 1024} MB）`)
  }
}

function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 22 - 0xffff)
  for (let index = buffer.length - 22; index >= min; index -= 1) {
    if (buffer.readUInt32LE(index) !== 0x06054b50) continue
    const commentLength = buffer.readUInt16LE(index + 20)
    if (index + 22 + commentLength === buffer.length) return index
  }
  return -1
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new Error('备份压缩包不完整')
  const eocd = findEocd(buffer)
  if (eocd < 0) throw new Error('备份压缩包已损坏或不完整')
  const total = buffer.readUInt16LE(eocd + 10)
  const directorySize = buffer.readUInt32LE(eocd + 12)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (total === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
    throw new Error('备份使用了不支持的 zip64 格式')
  }
  if (directoryOffset + directorySize > buffer.length) throw new Error('备份压缩包已损坏或不完整')

  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('备份压缩包已损坏或不完整')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const size = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttrs = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('备份使用了不支持的 zip64 格式')
    }
    if (cursor + 46 + nameLength > buffer.length) throw new Error('备份压缩包已损坏或不完整')
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, flags, method, compressedSize, size, localOffset, externalAttrs })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function validateZipEntries(entries: ZipEntry[]): void {
  if (entries.length === 0) throw new Error('备份压缩包里没有文件')
  if (entries.length > IMPORT_MAX_ENTRIES) {
    throw new Error(`备份里的条目太多（${entries.length} 个，最多 ${IMPORT_MAX_ENTRIES} 个）`)
  }
  const seen = new Set<string>()
  let total = 0
  for (const entry of entries) {
    const rawName = entry.name
    if (!rawName) throw new Error('备份里有空文件名')
    if (rawName.length > 512) throw new Error('备份里的文件名太长')
    if (rawName.includes('\0')) throw new Error('备份里的文件名不合法')
    if ((entry.flags & 0x1) === 0x1 || entry.method === 99) {
      throw new Error('备份已加密，暂不支持导入加密备份；请在导出端取消密码后再试')
    }
    const name = rawName.replace(/\\/g, '/')
    if (name.startsWith('/')) throw new Error(`备份里有绝对路径条目：${rawName}`)
    if (/^[A-Za-z]:/.test(name)) throw new Error(`备份里有盘符路径条目：${rawName}`)
    const segments = name.split('/')
    if (segments.includes('..')) throw new Error(`备份里有越权路径条目：${rawName}`)
    if (segments.includes('.')) throw new Error(`备份里有非法路径条目：${rawName}`)
    if (!name.endsWith('/') && ((entry.externalAttrs >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`备份里有符号链接：${rawName}`)
    }
    if (entry.size > IMPORT_MAX_ENTRY_BYTES) {
      throw new Error(`备份里的 ${name} 解压后超过单条目上限（64 MB）`)
    }
    total += entry.size
    if (total > IMPORT_MAX_TOTAL_BYTES) {
      throw new Error('备份解压后超过 512 MB，请改用轻量备份')
    }
    if (seen.has(name)) throw new Error(`备份里有重复文件：${name}`)
    seen.add(name)
  }
}

function extractZipEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const cursor = entry.localOffset
  if (cursor + 30 > buffer.length || buffer.readUInt32LE(cursor) !== 0x04034b50) {
    throw new Error('备份压缩包已损坏或不完整')
  }
  const nameLength = buffer.readUInt16LE(cursor + 26)
  const extraLength = buffer.readUInt16LE(cursor + 28)
  const start = cursor + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > buffer.length) throw new Error('备份压缩包已损坏或不完整')
  const raw = buffer.subarray(start, end)
  let data: Buffer
  if (entry.method === 0) {
    data = Buffer.from(raw)
  } else if (entry.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) })
    } catch {
      throw new Error(`备份里的 ${entry.name} 解压失败`)
    }
  } else {
    throw new Error(`备份使用了不支持的压缩方式（${entry.method}）`)
  }
  if (data.length !== entry.size) throw new Error(`备份里的 ${entry.name} 解压后大小与记录不一致`)
  return data
}

function readZipJson(buffer: Buffer, entry: ZipEntry): unknown {
  const raw = extractZipEntry(buffer, entry).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`备份里的 ${entry.name} 不是合法的 JSON`)
  }
}

function normalizeBook(value: unknown): ImportedBook | null {
  const record = jsonRecord(value)
  const name = text(record.name ?? record.bookName)
  if (!name) return null
  const author = text(record.author ?? record.bookAuthor)
  const origin = text(record.origin)
  let bookUrl = text(record.bookUrl ?? record.url)
  if (!bookUrl) bookUrl = fallbackUrl(name, author)
  return {
    backupId: text(record.id) || text(record.bookId),
    name,
    author,
    bookUrl,
    origin,
    originName: text(record.originName),
    type: integer(record.type),
    group: text(record.group),
    coverUrl: text(record.coverUrl),
    intro: text(record.intro),
    totalChapterNum: integer(record.totalChapterNum),
    wordCount: text(String(record.wordCount ?? '')),
    rating: text(String(record.rating ?? '')),
    pinned: boolean(record.pinned),
    latestChapterTitle: text(record.latestChapterTitle),
    lastReadAt: timestamp(record.lastReadAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
    metadataOnly: boolean(record.metadataOnly),
    localMissing: boolean(record.localMissing),
  }
}

function progressOfBook(record: Record<string, unknown>): ImportedProgress | null {
  const nested = jsonRecord(record.progress)
  const chapterIndex = integer(nested.chapterIndex ?? record.durChapterIndex)
  const chapterTitle = text(nested.chapterTitle ?? record.durChapterTitle)
  const chapterUrl = text(nested.chapterUrl)
  const position = integer(nested.position ?? record.durChapterPos)
  const updatedAt = timestamp(nested.updatedAt ?? record.durChapterTime ?? record.lastReadAt)
  if (chapterIndex <= 0 && !chapterTitle && !chapterUrl && !position) return null
  return {
    bookId: text(record.id) || text(record.bookId),
    bookName: text(record.name ?? record.bookName),
    bookAuthor: text(record.author ?? record.bookAuthor),
    chapterIndex,
    chapterTitle,
    chapterUrl,
    position,
    updatedAt,
  }
}

function normalizeBookmark(value: unknown, type: string): ImportedBookmark | ImportedNote | null {
  const record = jsonRecord(value)
  const bookName = text(record.bookName ?? record.bookTitle)
  const bookAuthor = text(record.bookAuthor ?? record.author)
  if (!bookName && !record.bookId) return null
  const base = {
    bookId: text(record.bookId),
    bookName,
    bookAuthor,
    type,
    chapterIndex: integer(record.chapterIndex ?? record.chapterNum),
    chapterTitle: text(record.chapterTitle ?? record.chapterName),
    chapterUrl: text(record.chapterUrl),
    page: integer(record.page ?? record.position ?? record.chapterPos),
    createdAt: timestamp(record.createdAt ?? record.createTime),
  }
  if (type === 'note') {
    return {
      ...base,
      text: text(record.bookText ?? record.text),
      note: text(record.note),
      quote: text(record.quote ?? record.bookText ?? record.text),
      content: text(record.content ?? record.note),
    }
  }
  return {
    ...base,
    text: text(record.text ?? record.bookText),
    note: text(record.note ?? record.content),
  }
}

function normalizeGroup(value: unknown): ImportedGroup | null {
  const record = jsonRecord(value)
  const name = text(record.name ?? record.groupName ?? record.title)
  if (!name) return null
  return { id: text(record.id ?? record.groupId) || name, name }
}

function readMoReaderBackup(buffer: Buffer, entries: ZipEntry[]): ImportedBackup {
  const byName = new Map<string, ZipEntry>()
  for (const entry of entries) byName.set(entry.name.replace(/\\/g, '/'), entry)
  const manifestEntry = byName.get(BACKUP_MANIFEST_FILE)
  if (!manifestEntry) throw new Error('不是墨读备份文件：缺少 manifest.json')
  const parsed = parseBackupManifest(readZipJson(buffer, manifestEntry))
  if (!parsed.ok) throw new Error(parsed.error)
  const manifest = parsed.manifest
  const declared = Array.isArray(manifest.files) ? manifest.files.filter((name) => typeof name === 'string' && name) : []

  // 清单里声明的数据文件：缺失即报错，未声明的 zip 条目一律不读。
  const declaredSections = declared.filter((name) => KNOWN_SECTION_FILES.has(name))
  const sectionFiles = declaredSections.length
    ? declaredSections
    : FULL_BACKUP_SECTIONS.filter((section) => Number(manifest.counts?.[section] ?? 0) > 0).map(
        (section) => BACKUP_SECTION_FILES[section],
      )
  const sectionValues = new Map<string, unknown>()
  for (const file of sectionFiles) {
    const entry = byName.get(file)
    if (!entry) throw new Error(`备份缺少 ${file}`)
    sectionValues.set(file, readZipJson(buffer, entry))
  }

  const bySection = (section: BackupSection): unknown => sectionValues.get(BACKUP_SECTION_FILES[section])
  const bookRecords = recordsOf(bySection('bookshelf'))
  const books: ImportedBook[] = []
  const progress: ImportedProgress[] = []
  for (const record of bookRecords) {
    const book = normalizeBook(record)
    if (!book) continue
    books.push(book)
    const item = progressOfBook(record)
    if (item) {
      item.bookId = item.bookId || book.backupId
      progress.push(item)
    }
  }

  // readRecord.json：每本书一条进度，与书目里的嵌套进度按 updatedAt 取新。
  for (const record of recordsOf(bySection('readRecord'))) {
    const bookId = text(record.bookId ?? record.id)
    const chapterIndex = integer(record.chapterIndex)
    const chapterTitle = text(record.chapterTitle)
    const chapterUrl = text(record.chapterUrl)
    const position = integer(record.position)
    if (!bookId || (chapterIndex <= 0 && !chapterTitle && !chapterUrl && !position)) continue
    progress.push({
      bookId,
      bookName: '',
      bookAuthor: '',
      chapterIndex,
      chapterTitle,
      chapterUrl,
      position,
      updatedAt: timestamp(record.updatedAt),
    })
  }
  const progressByBook = new Map<string, ImportedProgress>()
  for (const item of progress) {
    const previous = progressByBook.get(item.bookId)
    if (!previous || timeOf(item.updatedAt) > timeOf(previous.updatedAt)) progressByBook.set(item.bookId, item)
  }
  progress.length = 0
  progress.push(...progressByBook.values())

  const bookmarks: ImportedBookmark[] = []
  for (const record of recordsOf(bySection('bookmark'))) {
    const bookmark = normalizeBookmark(record, 'bookmark')
    if (bookmark) bookmarks.push(bookmark as ImportedBookmark)
  }
  const notes: ImportedNote[] = []
  for (const record of recordsOf(bySection('note'))) {
    const note = normalizeBookmark(record, 'note')
    if (note) notes.push(note as ImportedNote)
  }

  const settingsRecord = recordsOf(bySection('settings'))[0] ?? null
  const themeRecord = recordsOf(bySection('themeConfig'))[0] ?? null
  const themes: ImportedThemeConfig | null = themeRecord
    ? { theme: text(themeRecord.theme), customThemes: recordsOf(themeRecord.customThemes) }
    : null

  const backup: ImportedBackup = {
    kind: 'mo-reader-backup',
    version: Number(manifest.version) || null,
    exportedAt: text(manifest.exportedAt) || null,
    appName: text(manifest.app?.name) || '墨读',
    light: Boolean(manifest.light),
    books,
    sources: recordsOf(bySection('bookSource')),
    groups: recordsOf(bySection('bookGroup'))
      .map(normalizeGroup)
      .filter((group): group is ImportedGroup => Boolean(group)),
    bookmarks,
    notes,
    progress,
    readConfigs: recordsOf(bySection('readConfig')),
    settings: settingsRecord ? { ...settingsRecord } : null,
    themes,
    replaceRules: recordsOf(bySection('replaceRule')),
    dictRules: recordsOf(bySection('dictRule')),
    subscriptions: recordsOf(bySection('rssSource')).concat(recordsOf(bySection('subscription'))),
    covers: {},
    warnings: [],
    skippedSections: [],
  }

  // 封面只认清单声明的、且书目里存在的；单张仍受 2 MB 上限约束。
  const bookIds = new Set(books.map((book) => book.backupId).filter(Boolean))
  let coverBytes = 0
  for (const name of declared) {
    const normalized = name.replace(/\\/g, '/')
    if (!normalized.startsWith(`${BACKUP_COVERS_DIR}/`)) continue
    const match = /^covers\/([^/]+)\.(jpg|png|webp)$/.exec(normalized)
    if (!match) continue
    const bookId = match[1]
    if (!bookIds.has(bookId)) continue
    const entry = byName.get(normalized)
    if (!entry) continue
    if (entry.size > BACKUP_MAX_COVER_BYTES) {
      backup.warnings.push(`封面 ${normalized} 超过 2 MB，已跳过`)
      continue
    }
    if (coverBytes + entry.size > 200 * 1024 * 1024) continue
    const data = extractZipEntry(buffer, entry)
    backup.covers[bookId] = `data:${COVER_TYPES[match[2]]};base64,${data.toString('base64')}`
    coverBytes += data.length
  }
  return backup
}

function readLegadoBackup(buffer: Buffer, entries: ZipEntry[]): ImportedBackup {
  const byName = new Map<string, ZipEntry>()
  for (const entry of entries) byName.set(entry.name.replace(/\\/g, '/'), entry)
  const known = [...byName.keys()].filter((name) => LEGADO_SECTION_FILES.has(name))
  if (known.length === 0) {
    throw new Error('不是墨读备份文件：压缩包里没有 manifest.json，也没有阅读备份的数据文件')
  }
  const readJson = (name: string): unknown => {
    const entry = byName.get(name)
    return entry ? readZipJson(buffer, entry) : undefined
  }

  const backup: ImportedBackup = {
    kind: 'legado-backup',
    version: null,
    exportedAt: null,
    appName: '阅读',
    light: false,
    books: [],
    sources: [],
    groups: [],
    bookmarks: [],
    notes: [],
    progress: [],
    readConfigs: [],
    settings: null,
    themes: null,
    replaceRules: [],
    dictRules: [],
    subscriptions: [],
    covers: {},
    warnings: [],
    skippedSections: [],
  }

  const bookshelf = recordsOf(readJson('bookshelf.json'))
  for (const record of bookshelf) {
    const book = normalizeBook(record)
    if (!book) continue
    backup.books.push(book)
    const item = progressOfBook(record)
    if (item) {
      item.bookId = item.bookId || book.backupId
      backup.progress.push(item)
    }
  }

  backup.sources = recordsOf(readJson('bookSource.json')).filter((record) => text(record.bookSourceUrl))
  backup.groups = recordsOf(readJson('bookGroup.json'))
    .map(normalizeGroup)
    .filter((group): group is ImportedGroup => Boolean(group))

  const bookmarkFile = byName.has('bookmark.json') ? 'bookmark.json' : 'bookMark.json'
  for (const record of recordsOf(readJson(bookmarkFile))) {
    const bookmark = normalizeBookmark(record, 'bookmark')
    if (bookmark) backup.bookmarks.push(bookmark as ImportedBookmark)
  }
  const noteFile = byName.has('note.json') ? 'note.json' : 'notes.json'
  for (const record of recordsOf(readJson(noteFile))) {
    const note = normalizeBookmark(record, 'note')
    if (note) backup.notes.push(note as ImportedNote)
  }

  // 阅读的书签/笔记只有书名与作者，按备份里的书目补上稳定的书 id。
  const titleToId = new Map<string, string>()
  for (const book of backup.books) {
    titleToId.set(`${book.name.toLowerCase()}|${book.author.toLowerCase()}`, book.backupId)
  }
  for (const item of [...backup.bookmarks, ...backup.notes]) {
    if (item.bookId) continue
    const key = `${item.bookName.toLowerCase()}|${item.bookAuthor.toLowerCase()}`
    item.bookId = titleToId.get(key) ?? ''
  }

  for (const name of known) {
    if (name === 'bookshelf.json' || name === 'bookSource.json' || name === 'bookGroup.json') continue
    if (name === 'bookmark.json' || name === 'bookMark.json' || name === 'note.json' || name === 'notes.json') continue
    backup.skippedSections.push(name)
  }
  return backup
}

function readShelfJson(textValue: string): ImportedBackup {
  let parsed: unknown
  try {
    parsed = JSON.parse(textValue)
  } catch {
    throw new Error('备份文件无法识别：请选择墨读备份 zip、旧书架 JSON 或阅读备份 zip')
  }
  const record = jsonRecord(parsed)
  if (record.format === BACKUP_FORMAT) throw new Error('墨读备份是 zip 包，请直接选择 zip 文件')
  if (record.format === FULL_SHELF_FORMAT) {
    const version = Number(record.version)
    if (Number.isInteger(version) && version > FULL_SHELF_VERSION) {
      throw new Error('书架文件来自更新版本的墨读，请先升级')
    }
  }

  let shelf: { books: TransferBook[]; source: 'mo-reader' | 'legado' }
  try {
    shelf = parseShelfImport(textValue)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : '书架文件无法识别')
  }

  const backup: ImportedBackup = {
    kind: 'shelf-json',
    version: Number.isInteger(Number(record.version)) ? Number(record.version) : null,
    exportedAt: text(record.exportedAt) || null,
    appName: record.format === FULL_SHELF_FORMAT ? '墨读' : '阅读',
    light: false,
    books: [],
    sources: [],
    groups: [],
    bookmarks: [],
    notes: [],
    progress: [],
    readConfigs: [],
    settings: null,
    themes: null,
    replaceRules: [],
    dictRules: [],
    subscriptions: [],
    covers: {},
    warnings: [],
    skippedSections: [],
  }
  for (const book of shelf.books) {
    const normalized = normalizeBook(book)
    if (!normalized) continue
    backup.books.push(normalized)
    const progress = book.progress as Record<string, unknown> | null
    if (progress) {
      const chapterIndex = integer(progress.chapterIndex)
      const chapterTitle = text(progress.chapterTitle)
      const chapterUrl = text(progress.chapterUrl)
      const position = integer(progress.position)
      if (chapterIndex > 0 || chapterTitle || chapterUrl || position) {
        backup.progress.push({
          bookId: normalized.backupId,
          bookName: normalized.name,
          bookAuthor: normalized.author,
          chapterIndex,
          chapterTitle,
          chapterUrl,
          position,
          updatedAt: timestamp(progress.updatedAt),
        })
      }
    }
  }
  return backup
}

/** 解析任意受支持的备份；坏文件与不支持的格式抛可读错误。 */
export function parseBackupImport(input: BackupImportInput): ImportedBackup {
  const raw = typeof input.data === 'string' ? Buffer.from(input.data, 'utf8') : Buffer.from(input.data)
  if (raw.length === 0) throw new Error('备份文件是空的')
  assertImportArchiveSize(raw.length)

  const isZip = raw.length >= 4 && raw.readUInt32LE(0) === 0x04034b50
  if (!isZip) {
    if (raw.length >= 4 && raw.readUInt32LE(0) === 0x02014b50) throw new Error('备份压缩包已损坏或不完整')
    // JSON 文本：旧书架或阅读 books.json。
    let textValue: string
    try {
      textValue = raw.toString('utf8')
    } catch {
      throw new Error('备份文件无法识别：请选择墨读备份 zip、旧书架 JSON 或阅读备份 zip')
    }
    if (!textValue.trim().startsWith('{') && !textValue.trim().startsWith('[')) {
      throw new Error('备份文件无法识别：请选择墨读备份 zip、旧书架 JSON 或阅读备份 zip')
    }
    return readShelfJson(textValue)
  }

  const entries = readZipEntries(raw)
  validateZipEntries(entries)
  const hasManifest = entries.some((entry) => entry.name.replace(/\\/g, '/') === BACKUP_MANIFEST_FILE)
  return hasManifest ? readMoReaderBackup(raw, entries) : readLegadoBackup(raw, entries)
}

function bookRecordFields(book: ImportedBook, base: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = { ...base }
  const fields: Array<keyof ImportedBook> = [
    'name',
    'author',
    'bookUrl',
    'origin',
    'originName',
    'type',
    'group',
    'intro',
    'totalChapterNum',
    'wordCount',
    'rating',
    'pinned',
    'latestChapterTitle',
    'lastReadAt',
    'metadataOnly',
    'localMissing',
  ]
  for (const field of fields) {
    const value = book[field]
    if (!meaningful(value)) continue
    // 更新已有书时，不让空/0 值覆盖本机字段。
    if (base[field] !== undefined && !meaningful(value)) continue
    record[field] = value
  }
  record.updatedAt = book.updatedAt || base.updatedAt || 0
  return record
}

function bookKeyOf(book: Record<string, unknown>): string {
  return text(book.bookUrl) || fallbackUrl(text(book.name), text(book.author))
}

function titleOf(name: unknown, author: unknown): string {
  return `${text(name).toLowerCase()}|${text(author).toLowerCase()}`
}

/** 合并导入数据与本机现状，得到预览与写入计划。 */
export function mergeBackupImport(input: BackupImportMergeInput): BackupImportPlan {
  const { backup, existing } = input
  const now = input.now ?? new Date().toISOString()
  const operations: BackupImportOperation[] = []
  const warnings = [...backup.warnings]
  const preview: BackupImportPreview = {
    kind: backup.kind,
    version: backup.version,
    exportedAt: backup.exportedAt,
    appName: backup.appName,
    light: backup.light,
    books: emptyCount(),
    sources: emptyCount(),
    groups: emptyCount(),
    bookmarks: emptyCount(),
    notes: emptyCount(),
    progress: emptyCount(),
    readConfigs: emptyCount(),
    dictRules: emptyCount(),
    subscriptions: emptyCount(),
    replaceRules: emptyCount(),
    themes: { total: backup.themes?.customThemes.length ?? 0, added: 0, skipped: 0 },
    settings: { added: [], skipped: 0 },
    covers: 0,
    warnings,
  }

  const existingBooks = new Map<string, Record<string, unknown>>()
  const existingByUrl = new Map<string, Record<string, unknown>>()
  const existingByTitle = new Map<string, Record<string, unknown>>()
  for (const book of existing.books) {
    const id = text(book.id)
    if (id) existingBooks.set(id, book)
    const url = text(book.bookUrl)
    if (url) existingByUrl.set(url, book)
    existingByTitle.set(titleOf(book.name, book.author), book)
  }

  // 备份里的书 id 与书名 → 实际落库的 id，书签/笔记/进度据此对号入座。
  const resolved = new Map<string, string>()
  const titleToLocal = new Map<string, string>()

  for (const book of backup.books) {
    preview.books.total += 1
    const url = text(book.bookUrl)
    const match = (url ? existingByUrl.get(url) : undefined) ?? existingByTitle.get(titleOf(book.name, book.author))
    let key = match ? text(match.id) : ''
    if (!key) {
      const candidate = safeId(book.backupId)
      key = candidate && !existingBooks.has(candidate) ? candidate : sha1(`${book.origin}|${book.bookUrl}`)
      if (!book.bookUrl || book.bookUrl === fallbackUrl(book.name, book.author)) {
        key = candidate || sha1(`shelf|${book.name}|${book.author}`)
      }
    }
    const base: Record<string, unknown> = match
      ? { ...match }
      : { id: key, createdAt: book.createdAt || now, updatedAt: book.updatedAt || now }
    const record = bookRecordFields(book, base)
    record.id = key
    if (base.createdAt !== undefined) record.createdAt = base.createdAt
    const cover = backup.covers[book.backupId]
    if (cover) {
      record.coverUrl = cover
      preview.covers += 1
    } else if (text(base.coverUrl)) {
      record.coverUrl = base.coverUrl
    }
    if (match) {
      if (sameRecord(base, record)) {
        preview.books.skipped += 1
      } else {
        preview.books.updated += 1
        operations.push({ table: 'books', key, record, existed: true })
      }
    } else {
      preview.books.added += 1
      operations.push({ table: 'books', key, record, existed: false })
    }
    existingBooks.set(key, record)
    const bookUrl = text(record.bookUrl)
    if (bookUrl) existingByUrl.set(bookUrl, record)
    existingByTitle.set(titleOf(record.name, record.author), record)
    if (book.backupId) resolved.set(book.backupId, key)
    if (book.name) titleToLocal.set(titleOf(book.name, book.author), key)
  }

  const resolveBook = (item: { bookId: string; bookName: string; bookAuthor: string }): string => {
    if (item.bookId && resolved.has(item.bookId)) return resolved.get(item.bookId) as string
    const title = titleOf(item.bookName, item.bookAuthor)
    if (titleToLocal.has(title)) return titleToLocal.get(title) as string
    const local = existingByTitle.get(title)
    return local ? text(local.id) : ''
  }

  // 书源：按 bookSourceUrl 更新。
  const existingSources = new Map<string, Record<string, unknown>>()
  for (const source of existing.sources) {
    const url = text(source.bookSourceUrl)
    if (url) existingSources.set(url, source)
  }
  for (const incoming of backup.sources) {
    const url = text(incoming.bookSourceUrl)
    if (!url) {
      preview.sources.total += 1
      preview.sources.skipped += 1
      continue
    }
    preview.sources.total += 1
    const match = existingSources.get(url)
    const record: Record<string, unknown> = { ...(match ?? {}), ...incoming, id: url, bookSourceUrl: url }
    if (match) {
      if (sameRecord(match, record)) preview.sources.skipped += 1
      else {
        preview.sources.updated += 1
        operations.push({ table: 'sources', key: url, record, existed: true })
      }
    } else {
      preview.sources.added += 1
      operations.push({ table: 'sources', key: url, record, existed: false })
    }
    existingSources.set(url, record)
  }

  // 分组：同名跳过。
  const groupNames = new Set(existing.groups.map((group) => text(group.name)).filter(Boolean))
  for (const group of backup.groups) {
    preview.groups.total += 1
    if (groupNames.has(group.name)) {
      preview.groups.skipped += 1
      continue
    }
    groupNames.add(group.name)
    preview.groups.added += 1
    operations.push({ table: 'groups', key: group.name, record: { id: group.id || group.name, name: group.name }, existed: false })
  }

  // 每本书的设置覆盖：本机没有才补。
  const existingReadConfigs = new Set(existing.readConfigs.map((config) => text(config.bookId ?? config.id)).filter(Boolean))
  for (const config of backup.readConfigs) {
    preview.readConfigs.total += 1
    const sourceId = text(config.bookId ?? config.id)
    const bookId = resolved.get(sourceId) ?? sourceId
    if (!bookId || existingReadConfigs.has(bookId)) {
      preview.readConfigs.skipped += 1
      continue
    }
    existingReadConfigs.add(bookId)
    preview.readConfigs.added += 1
    operations.push({ table: 'readConfigs', key: bookId, record: { ...config, id: bookId, bookId }, existed: false })
  }

  // 书签：bookId + 章节 + 位置。
  const bookmarkKeys = new Set(
    existing.bookmarks.map((bookmark) => `${text(bookmark.bookId)}|${integer(bookmark.chapterIndex)}|${integer(bookmark.page)}`),
  )
  for (const bookmark of backup.bookmarks) {
    preview.bookmarks.total += 1
    const bookId = resolveBook(bookmark)
    if (!bookId) {
      preview.bookmarks.skipped += 1
      warnings.push(`书签（${bookmark.bookName || '未知书籍'} 第 ${bookmark.chapterIndex + 1} 章）找不到对应的书，已跳过`)
      continue
    }
    const key = `${bookId}|${bookmark.chapterIndex}|${bookmark.page}`
    if (bookmarkKeys.has(key)) {
      preview.bookmarks.skipped += 1
      continue
    }
    bookmarkKeys.add(key)
    preview.bookmarks.added += 1
    const record: Record<string, unknown> = {
      id: sha1(`${bookId}|${bookmark.chapterIndex}|${bookmark.page}|${bookmark.type || 'bookmark'}`).slice(0, 24),
      bookId,
      type: bookmark.type || 'bookmark',
      chapterIndex: bookmark.chapterIndex,
      chapterTitle: bookmark.chapterTitle,
      chapterUrl: bookmark.chapterUrl,
      page: bookmark.page,
      text: bookmark.text,
      note: bookmark.note,
      createdAt: bookmark.createdAt || now,
    }
    operations.push({ table: 'bookmarks', key: record.id as string, record, existed: false })
  }

  // 笔记：书签的键再加正文内容。
  const noteKeys = new Set(
    existing.notes.map(
      (note) =>
        `${text(note.bookId)}|${integer(note.chapterIndex)}|${integer(note.page)}|${text(note.content)}`,
    ),
  )
  for (const note of backup.notes) {
    preview.notes.total += 1
    const bookId = resolveBook(note)
    if (!bookId) {
      preview.notes.skipped += 1
      warnings.push(`笔记（${note.bookName || '未知书籍'} 第 ${note.chapterIndex + 1} 章）找不到对应的书，已跳过`)
      continue
    }
    const key = `${bookId}|${note.chapterIndex}|${note.page}|${note.content}`
    if (noteKeys.has(key)) {
      preview.notes.skipped += 1
      continue
    }
    noteKeys.add(key)
    preview.notes.added += 1
    const record: Record<string, unknown> = {
      id: sha1(`${bookId}|${note.chapterIndex}|${note.page}|${note.type || 'note'}|${note.quote}`).slice(0, 24),
      bookId,
      type: note.type || 'note',
      chapterIndex: note.chapterIndex,
      chapterTitle: note.chapterTitle,
      chapterUrl: note.chapterUrl,
      page: note.page,
      quote: note.quote,
      content: note.content,
      createdAt: note.createdAt || now,
    }
    operations.push({ table: 'notes', key: record.id as string, record, existed: false })
  }

  // 阅读进度：同一本书只保留 updatedAt 较新的一份。
  const existingProgress = new Map<string, Record<string, unknown>>()
  for (const progress of existing.progress) {
    const bookId = text(progress.bookId ?? progress.id)
    if (bookId) existingProgress.set(bookId, progress)
  }
  for (const progress of backup.progress) {
    preview.progress.total += 1
    const bookId = resolveBook(progress)
    if (!bookId) {
      preview.progress.skipped += 1
      continue
    }
    const match = existingProgress.get(bookId)
    const record: Record<string, unknown> = {
      ...(match ?? {}),
      id: bookId,
      bookId,
      chapterIndex: progress.chapterIndex,
      chapterTitle: progress.chapterTitle,
      chapterUrl: progress.chapterUrl,
      position: progress.position,
      updatedAt: progress.updatedAt || now,
    }
    if (!match) {
      preview.progress.added += 1
      operations.push({ table: 'readRecords', key: bookId, record, existed: false })
    } else if (timeOf(progress.updatedAt) > timeOf(match.updatedAt)) {
      preview.progress.updated += 1
      operations.push({ table: 'readRecords', key: bookId, record, existed: true })
    } else {
      preview.progress.skipped += 1
      continue
    }
    existingProgress.set(bookId, record)
  }

  // 字典规则：同名跳过。
  const dictNames = new Set(existing.dictRules.map((rule) => text(rule.name)).filter(Boolean))
  for (const rule of backup.dictRules) {
    preview.dictRules.total += 1
    const name = text(rule.name)
    if (!name || dictNames.has(name)) {
      preview.dictRules.skipped += 1
      continue
    }
    dictNames.add(name)
    preview.dictRules.added += 1
    operations.push({ table: 'dictRules', key: safeId(rule.id) || name, record: { ...rule, id: safeId(rule.id) || name, name }, existed: false })
  }

  // 订阅 / RSS：按地址跳过重复。
  const subscriptionUrls = new Set(
    existing.subscriptions.map((record) => text(record.sourceUrl) || text(record.url)).filter(Boolean),
  )
  for (const record of backup.subscriptions) {
    preview.subscriptions.total += 1
    const url = text(record.sourceUrl) || text(record.url)
    if (!url || subscriptionUrls.has(url)) {
      preview.subscriptions.skipped += 1
      continue
    }
    subscriptionUrls.add(url)
    preview.subscriptions.added += 1
    const key = safeId(record.id) || sha1(url).slice(0, 16)
    operations.push({ table: 'subscriptions', key, record: { ...record, id: key }, existed: false })
  }

  const settings = mergeSettings(backup, existing.settings ?? {}, now, preview)
  const warningsChanged = preview.warnings.length !== backup.warnings.length
  return {
    preview,
    operations,
    settings: settings.changed ? settings.next : null,
    warnings: warningsChanged ? preview.warnings : warnings,
  }
}

function timeOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const number = Number(value)
    if (Number.isFinite(number)) return number
  }
  return 0
}

function mergeSettings(
  backup: ImportedBackup,
  current: Record<string, unknown>,
  now: string,
  preview: BackupImportPreview,
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...current }
  let changed = false
  const inline = backup.settings ?? {}
  for (const key of Object.keys(inline)) {
    if (SKIP_SETTING_KEYS.has(key)) continue
    const value = inline[key]
    if (next[key] === undefined) {
      next[key] = value
      preview.settings.added.push(key)
      changed = true
    } else {
      preview.settings.skipped += 1
    }
  }

  const theme = text(backup.themes?.theme)
  if (theme) {
    if (text(next.theme)) {
      preview.settings.skipped += 1
    } else {
      next.theme = theme
      preview.settings.added.push('theme')
      changed = true
    }
  }

  const localThemes = Array.isArray(next.customThemes) ? [...(next.customThemes as Record<string, unknown>[])] : []
  const themeNames = new Set(localThemes.map((item) => text(item.name).toLowerCase()).filter(Boolean))
  for (const item of backup.themes?.customThemes ?? []) {
    const name = text(item.name)
    if (!name || themeNames.has(name.toLowerCase()) || localThemes.length >= 100) {
      preview.themes.skipped += 1
      continue
    }
    themeNames.add(name.toLowerCase())
    localThemes.push({
      ...item,
      id: safeId(item.id) || sha1(name).slice(0, 12),
      name,
      createdAt: text(item.createdAt) || now,
    })
    preview.themes.added += 1
    changed = true
  }
  if (changed && localThemes.length) next.customThemes = localThemes

  const localRules = Array.isArray(next.replaceRules) ? [...(next.replaceRules as Record<string, unknown>[])] : []
  const ruleKeys = new Set(localRules.map((rule) => ruleKey(rule)))
  for (const rule of backup.replaceRules) {
    preview.replaceRules.total += 1
    const key = ruleKey(rule)
    if (!key || ruleKeys.has(key)) {
      preview.replaceRules.skipped += 1
      continue
    }
    ruleKeys.add(key)
    preview.replaceRules.added += 1
    localRules.push({ ...rule })
    changed = true
  }
  preview.replaceRules.updated = 0
  if (preview.replaceRules.added > 0) {
    preview.replaceRules.total = Math.max(preview.replaceRules.total, localRules.length)
    next.replaceRules = localRules
  }

  return { next, changed }
}

function ruleKey(rule: Record<string, unknown>): string {
  const pattern = text(rule.pattern ?? rule.name)
  if (!pattern) return ''
  return `${pattern}\u0000${text(rule.replacement ?? rule.replacementText ?? '')}`
}

import { ReaderError } from './errors.js'
import { assertNoSecrets, normalizeSource } from './rules.js'
import { normalizeSettings } from './settings.js'
import { clone, now, requiredString } from './utils.js'

const BACKUP_TYPE = 'modu-reader-backup'
const SECRET_FIELD = /^(?:.*(?:password|passwd|credential|secret|cookie|authorization).*|(?:access|refresh|id|auth|session|api|client)?[-_]?token|api[-_]?key|auth|session|x[-_]api[-_]key)$/i

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, item]) => [key, scrubSecrets(item)]))
}

function publicSource(source) {
  return {
    id: source.id,
    name: source.name,
    bookSourceUrl: source.bookSourceUrl,
    allowHttp: source.allowHttp === true,
    rules: scrubSecrets(clone(source.rules ?? {})),
  }
}

function publicBook(book) {
  const fields = ['id', 'sourceId', 'bookUrl', 'name', 'author', 'coverUrl', 'intro', 'format', 'local', 'addedAt', 'updatedAt', 'lastCheckedAt', 'progress', 'download']
  return Object.fromEntries(fields.filter(field => book[field] !== undefined).map(field => [field, clone(book[field])]))
}

function publicChapter(chapter) {
  const fields = ['id', 'bookId', 'index', 'title', 'url', 'text', 'html', 'downloadedAt']
  return Object.fromEntries(fields.filter(field => chapter[field] !== undefined).map(field => [field, clone(chapter[field])]))
}

function publicNote(note) {
  const fields = ['id', 'bookId', 'chapterId', 'text', 'quote', 'color', 'createdAt', 'updatedAt']
  return Object.fromEntries(fields.filter(field => note[field] !== undefined).map(field => [field, clone(note[field])]))
}

export function createBackup({ sources, books, chapters, settings, notes }) {
  const backup = {
    type: BACKUP_TYPE,
    version: 1,
    exportedAt: now(),
    sources: sources.filter(source => source.id !== 'local').map(publicSource),
    books: books.map(publicBook),
    chapters: chapters.map(publicChapter),
    settings: normalizeSettings(settings),
    notes: notes.map(publicNote),
  }
  assertNoSecrets(backup, 'backup')
  return JSON.stringify(backup, null, 2)
}

function safeId(value, label) {
  const id = requiredString(value, label, 4096)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ReaderError('reader/invalid-backup', `${label} 不是安全的持久化 ID。`)
  return id
}

function array(value, name, max = 100000) {
  if (!Array.isArray(value) || value.length > max) throw new ReaderError('reader/invalid-backup', `${name} 必须是有效数组。`)
  return value
}

export function parseBackup(data) {
  if (typeof data !== 'string' && (!data || typeof data !== 'object' || Array.isArray(data))) {
    throw new ReaderError('reader/invalid-backup', 'data 必须是备份 JSON 字符串或对象。')
  }
  if (Buffer.byteLength(typeof data === 'string' ? data : JSON.stringify(data)) > 32 * 1024 * 1024) {
    throw new ReaderError('reader/too-large', '备份超过 32 MiB。')
  }
  let backup
  try {
    backup = typeof data === 'string' ? JSON.parse(data) : clone(data)
  } catch (error) {
    throw new ReaderError('reader/invalid-backup', '备份不是有效 JSON。', undefined, { cause: error })
  }
  if (!backup || backup.type !== BACKUP_TYPE || backup.version !== 1) throw new ReaderError('reader/invalid-backup', '备份格式或版本不受支持。')
  assertNoSecrets(backup, 'backup')
  const sources = array(backup.sources, 'sources').map(source => normalizeSource(publicSource(source), { allowHttp: source.allowHttp === true }))
  const books = array(backup.books, 'books').map(book => {
    if (!book || typeof book !== 'object') throw new ReaderError('reader/invalid-backup', 'books 含有无效记录。')
    const result = publicBook(book)
    result.id = safeId(result.id, 'book.id')
    result.name = requiredString(result.name, 'book.name')
    result.sourceId = safeId(result.sourceId, 'book.sourceId')
    result.bookUrl = requiredString(result.bookUrl, 'book.bookUrl')
    return result
  })
  const bookIds = new Set(books.map(book => book.id))
  const chapters = array(backup.chapters, 'chapters').map(chapter => {
    const result = publicChapter(chapter)
    result.id = safeId(result.id, 'chapter.id')
    result.bookId = safeId(result.bookId, 'chapter.bookId')
    if (!bookIds.has(result.bookId) || !Number.isInteger(result.index) || result.index < 0 || typeof result.text !== 'string') {
      throw new ReaderError('reader/invalid-backup', `章节 ${result.id} 引用或内容无效。`)
    }
    return result
  })
  const notes = array(backup.notes, 'notes').map(note => {
    const result = publicNote(note)
    result.id = safeId(result.id, 'note.id')
    if (!bookIds.has(result.bookId) || typeof result.text !== 'string') throw new ReaderError('reader/invalid-backup', '笔记引用或正文无效。')
    return result
  })
  const settings = normalizeSettings(backup.settings)
  return { sources, books, chapters, settings, notes }
}

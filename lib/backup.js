import { normalizeBookContentType, normalizeSourceContentType } from './content-types.js'
import { ReaderError } from './errors.js'
import { assertNoSecrets, normalizeSource } from './rules.js'
import { normalizeRssSource } from './rss-source.js'
import { normalizeSettings } from './settings.js'
import { clone, now, requiredString } from './utils.js'

const BACKUP_TYPE = 'modu-reader-backup'
// v2 起备份会带上订阅源与订阅作品；旧客户端只认 v1，会明确拒绝而不是静默降级。
const BACKUP_VERSION = 2
const SECRET_FIELD = /^(?:.*(?:password|passwd|credential|secret|cookie|authorization).*|(?:access|refresh|id|auth|session|api|client)?[-_]?token|api[-_]?key|auth|session|x[-_]api[-_]key)$/i

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_FIELD.test(key)).map(([key, item]) => [key, scrubSecrets(item)]))
}

function publicSource(source) {
  const result = {
    id: source.id,
    name: source.name,
    bookSourceUrl: source.bookSourceUrl,
    allowHttp: source.allowHttp === true,
    enabled: source.enabled !== false,
    contentType: normalizeSourceContentType(source.contentType),
    ...(source.contentType === 'website' ? { homeUrl: source.homeUrl, searchUrl: source.searchUrl ?? null } : {}),
    rules: scrubSecrets(clone(source.rules ?? {})),
  }
  if (source.kind === 'rss') {
    result.kind = 'rss'
    result.categories = clone(source.categories ?? [])
    result.unsupported = [...(source.unsupported ?? [])]
  }
  return result
}

function backupSubscriptionUrl(value) {
  try {
    const url = new URL(String(value))
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|secret|passw|auth|signature|sig|api[_-]?key)/i.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return value
  }
}

function publicSubscription(subscription) {
  const result = {
    id: subscription.id,
    url: backupSubscriptionUrl(subscription.url),
    sourceIds: Array.isArray(subscription.sourceIds) ? [...subscription.sourceIds] : subscription.sourceIds,
    status: subscription.status === 'pending' ? 'ready' : subscription.status,
  }
  if (typeof subscription.allowHttp === 'boolean') result.allowHttp = subscription.allowHttp
  for (const field of ['lastCheckedAt', 'lastSuccessAt', 'lastFailureAt', 'createdAt', 'updatedAt']) {
    if (subscription[field] !== undefined) result[field] = subscription[field]
  }
  return result
}

function publicBook(book) {
  const fields = ['id', 'sourceId', 'bookUrl', 'name', 'author', 'coverUrl', 'intro', 'contentType', 'format', 'local', 'subscription', 'createdAt', 'addedAt', 'updatedAt', 'lastCheckedAt', 'progress', 'readerPrefs', 'download']
  const result = Object.fromEntries(fields.filter(field => book[field] !== undefined).map(field => [field, clone(book[field])]))
  result.contentType = normalizeBookContentType(result.contentType)
  return result
}

function publicChapter(chapter) {
  const fields = ['id', 'bookId', 'index', 'title', 'url', 'text', 'html', 'downloadedAt']
  return Object.fromEntries(fields.filter(field => chapter[field] !== undefined).map(field => [field, clone(chapter[field])]))
}

function publicNote(note) {
  const fields = ['id', 'bookId', 'chapterId', 'text', 'quote', 'color', 'createdAt', 'updatedAt']
  return Object.fromEntries(fields.filter(field => note[field] !== undefined).map(field => [field, clone(note[field])]))
}

export function createBackup({ sources, books, chapters, settings, notes, subscriptions = [] }) {
  const backup = {
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    exportedAt: now(),
    sources: sources.filter(source => source.id !== 'local').map(publicSource),
    subscriptions: subscriptions.map(publicSubscription),
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
  if (!backup || backup.type !== BACKUP_TYPE || !Number.isInteger(backup.version) || backup.version < 1 || backup.version > BACKUP_VERSION) throw new ReaderError('reader/invalid-backup', '备份格式或版本不受支持。')
  assertNoSecrets(backup, 'backup')
  const sources = array(backup.sources, 'sources').map(source => {
    const raw = publicSource(source)
    if (raw.kind === 'rss') {
      if (!Array.isArray(raw.categories) || raw.categories.some(category => !category || typeof category.name !== 'string' || typeof category.url !== 'string')) {
        throw new ReaderError('reader/invalid-backup', '订阅源分类记录无效。')
      }
      const sortUrl = raw.categories.map(category => `${category.name}::${category.url}`).join('\n')
      return normalizeRssSource({ sourceName: raw.name, sourceUrl: raw.bookSourceUrl, enabled: raw.enabled, sortUrl }, { allowHttp: raw.allowHttp })
    }
    return normalizeSource(raw, { allowHttp: source.allowHttp === true })
  })
  const sourceIds = new Set(sources.map(source => source.id))
  const subscriptions = array(backup.subscriptions ?? [], 'subscriptions', 1000).map(subscription => {
    if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
      throw new ReaderError('reader/invalid-backup', 'subscriptions 含有无效记录。')
    }
    const result = publicSubscription(subscription)
    result.id = safeId(result.id, 'subscription.id')
    result.url = requiredString(result.url, 'subscription.url', 4096)
    result.sourceIds = array(result.sourceIds, 'subscription.sourceIds', 10000)
      .map(sourceId => safeId(sourceId, 'subscription.sourceIds'))
      .filter(sourceId => sourceIds.has(sourceId))
    result.status = ['ready', 'partial', 'error'].includes(result.status) ? result.status : 'ready'
    if (result.allowHttp !== undefined && typeof result.allowHttp !== 'boolean') {
      throw new ReaderError('reader/invalid-backup', 'subscription.allowHttp 无效。')
    }
    for (const field of ['lastCheckedAt', 'lastSuccessAt', 'lastFailureAt', 'createdAt', 'updatedAt']) {
      if (result[field] !== undefined && (typeof result[field] !== 'string' || Number.isNaN(Date.parse(result[field])))) {
        throw new ReaderError('reader/invalid-backup', `subscription.${field} 无效。`)
      }
    }
    return result
  })
  const books = array(backup.books, 'books').map(book => {
    if (!book || typeof book !== 'object') throw new ReaderError('reader/invalid-backup', 'books 含有无效记录。')
    const result = publicBook(book)
    result.id = safeId(result.id, 'book.id')
    result.name = requiredString(result.name, 'book.name')
    result.sourceId = safeId(result.sourceId, 'book.sourceId')
    result.bookUrl = requiredString(result.bookUrl, 'book.bookUrl')
    result.contentType = normalizeBookContentType(result.contentType)
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
  return { sources, subscriptions, books, chapters, settings, notes }
}

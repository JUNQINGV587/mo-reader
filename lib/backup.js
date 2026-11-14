import { normalizeBookContentType, normalizeSourceContentType } from './content-types.js'
import { ReaderError } from './errors.js'
import { assertBasicRules, assertNoSecrets, assertRuleTypes, normalizeSource } from './rules.js'
import { normalizeRssSource } from './rss-source.js'
import { restoreFeedSource } from './rss-feed.js'
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
    if (source.feed === true) {
      // feed 恢复只读 bookSourceUrl/name/categories/enabled/allowHttp；
      // headers/unsupported 恢复时会被丢弃，导出就不要带，避免语义漂移。
      result.feed = true
    } else {
      result.unsupported = [...(source.unsupported ?? [])]
      // 规则型订阅抓正文/探测媒体依赖这些静态头；Cookie 在导入时已被清理，
      // 值里带的 URL 凭据与 Bearer/Basic/Token 令牌在导出和恢复时都会再清洗一次。
      result.headers = publicHeaders(source.headers)
    }
  }
  return result
}

const URL_SECRET_QUERY = /(token|secret|passw|auth|signature|sig|api[_-]?key)/i

function urlHasSecrets(url) {
  return Boolean(url.username || url.password || url.hash) ||
    [...url.searchParams.keys()].some(key => URL_SECRET_QUERY.test(key))
}

function publicUrl(value) {
  try {
    const url = new URL(String(value))
    url.username = ''
    url.password = ''
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (URL_SECRET_QUERY.test(key)) url.searchParams.delete(key)
    }
    return url.href
  } catch {
    return value
  }
}

const AUTH_HEADER_VALUE = /^(?:Bearer|Basic|Token)\b/i

// 请求头值可能本身就是 URL（如 Referer），其中的用户名/密码、片段与敏感查询参数不能进备份。
// 没有可清理内容的普通值原样保留，避免把 header 值改写成规范化后的 URL。
function publicHeaderValue(value) {
  if (typeof value !== 'string') return value
  if (AUTH_HEADER_VALUE.test(value.trim())) return null
  try {
    return urlHasSecrets(new URL(value)) ? publicUrl(value) : value
  } catch {
    return value
  }
}

function publicHeaders(headers) {
  const scrubbed = scrubSecrets(clone(headers ?? {}))
  if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return scrubbed
  return Object.fromEntries(Object.entries(scrubbed)
    .map(([name, value]) => [name, publicHeaderValue(value)])
    .filter(([, value]) => value !== null))
}

function publicSubscription(subscription) {
  const result = {
    id: subscription.id,
    url: publicUrl(subscription.url),
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
  const fields = ['id', 'sourceId', 'bookUrl', 'name', 'author', 'coverUrl', 'intro', 'contentType', 'format', 'local', 'subscription', 'readBaselineAt', 'latestChapter', 'createdAt', 'addedAt', 'updatedAt', 'lastCheckedAt', 'progress', 'readerPrefs', 'download']
  const result = Object.fromEntries(fields.filter(field => book[field] !== undefined).map(field => [field, clone(book[field])]))
  result.contentType = normalizeBookContentType(result.contentType)
  if (result.subscription && typeof result.subscription === 'object' && !Array.isArray(result.subscription)) {
    // anchorError 是抓取失败时的运行期诊断，不进备份；锚点 URL 与分类元数据仍保留。
    result.subscription = { ...result.subscription }
    delete result.subscription.anchorError
  }
  return result
}

function publicChapter(chapter) {
  const fields = ['id', 'bookId', 'index', 'title', 'url', 'text', 'html', 'description', 'coverUrl', 'downloadedAt', 'publishedAt', 'readAt']
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

function pathMessage(error, path) {
  const message = String(error?.message ?? '记录无效。')
  return message.startsWith(`${path}.`) || message.startsWith(`${path}[`) || message.startsWith(`${path}:`) ? message : `${path}: ${message}`
}

// 恢复订阅源的抓取规则前，按书源导入同样的敏感字段/WebView/类型校验拒绝坏备份。
function assertRestoredRules(source, index) {
  const rulesPath = `sources[${index}].rules`
  const rules = source && typeof source === 'object' ? source.rules ?? {} : {}
  try {
    assertNoSecrets(rules, rulesPath)
    assertBasicRules(rules, rulesPath)
    assertRuleTypes(rules, rulesPath)
  } catch (error) {
    if (error?.code === 'reader/invalid-backup') throw error
    throw new ReaderError('reader/invalid-backup', pathMessage(error, rulesPath), undefined, { cause: error })
  }
}

function assertBackupRules(backup) {
  if (!Array.isArray(backup.sources)) return
  backup.sources.forEach((source, index) => {
    if (!source || typeof source !== 'object' || source.kind !== 'rss' || source.feed === true) return
    assertRestoredRules(source, index)
  })
}

// 订阅源恢复的统一入口：先按导出用的字段映射（publicSource）还原一次，
// 再按记录类型走规范化；导出与恢复共用这一份映射，规则先校验再落库。
function restoreSource(source, index) {
  const raw = publicSource(source)
  if (raw.kind !== 'rss') return normalizeSource(raw, { allowHttp: raw.allowHttp })
  if (!Array.isArray(raw.categories) || raw.categories.some(category => !category || typeof category.name !== 'string' || typeof category.url !== 'string')) {
    throw new ReaderError('reader/invalid-backup', '订阅源分类记录无效。')
  }
  // feed 源没有 ruleArticles/sortUrl，不能走 normalizeRssSource；按备份记录恢复，不重新抓取。
  if (raw.feed === true) {
    try {
      return restoreFeedSource(raw)
    } catch (error) {
      if (error?.code === 'reader/invalid-backup') throw error
      throw new ReaderError('reader/invalid-backup', '订阅源记录无效。', undefined, { cause: error })
    }
  }
  assertRestoredRules(source, index)
  try {
    const sortUrl = raw.categories.map(category => `${category.name}::${category.url}`).join('\n')
    return normalizeRssSource({
      sourceName: raw.name,
      sourceUrl: raw.bookSourceUrl,
      enabled: raw.enabled,
      sortUrl,
      headers: raw.headers,
      rules: raw.rules,
      unsupported: raw.unsupported,
    }, { allowHttp: raw.allowHttp })
  } catch (error) {
    if (error?.code === 'reader/invalid-backup') throw error
    throw new ReaderError('reader/invalid-backup', pathMessage(error, `sources[${index}]`), undefined, { cause: error })
  }
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
  assertBackupRules(backup)
  try {
    assertNoSecrets(backup, 'backup')
  } catch (error) {
    if (error?.code === 'reader/invalid-backup') throw error
    throw new ReaderError('reader/invalid-backup', error.message, undefined, { cause: error })
  }
  const rawSources = array(backup.sources, 'sources')
  const sources = rawSources.map((source, index) => restoreSource(source, index))
  const sourceIds = new Set(sources.map(source => source.id))
  // 恢复时规则型订阅源会按地址重新生成 ID，章节校验要按备份里声明的 sourceId 找源类型。
  const backupSources = new Map(rawSources
    .filter(source => source && typeof source === 'object' && typeof source.id === 'string')
    .map(source => [source.id, source]))
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
    if (result.latestChapter !== undefined) {
      if (typeof result.latestChapter !== 'string') throw new ReaderError('reader/invalid-backup', 'book.latestChapter 无效。')
      result.latestChapter = result.latestChapter.slice(0, 200)
    }
    if (result.readBaselineAt !== undefined) {
      if (typeof result.readBaselineAt !== 'string' || Number.isNaN(Date.parse(result.readBaselineAt))) {
        throw new ReaderError('reader/invalid-backup', 'book.readBaselineAt 无效。')
      }
    }
    return result
  })
  const bookIds = new Set(books.map(book => book.id))
  const bookContentTypes = new Map(books.map(book => [book.id, book.contentType]))
  const bookSources = new Map(books.map(book => [book.id, backupSources.get(book.sourceId)]))
  const chapters = array(backup.chapters, 'chapters').map(chapter => {
    const result = publicChapter(chapter)
    result.id = safeId(result.id, 'chapter.id')
    result.bookId = safeId(result.bookId, 'chapter.bookId')
    // 先逐字段校验类型，再决定订阅条目是否允许省略正文。
    // 订阅的摘要条目只有 description、没有 text；其他作品仍必须有字符串 text。
    const badText = result.text !== undefined && typeof result.text !== 'string'
    const badDescription = result.description !== undefined && typeof result.description !== 'string'
    const badCover = result.coverUrl !== undefined && typeof result.coverUrl !== 'string'
    const subscriptionEntry = bookContentTypes.get(result.bookId) === 'subscription'
    const summaryOnly = subscriptionEntry
      && typeof result.description === 'string'
      && result.description.trim().length > 0
    const chapterSource = bookSources.get(result.bookId)
    const feedEntry = chapterSource?.kind === 'rss' && chapterSource.feed === true
    // 订阅媒体条目备份时不保留 mediaUrl/headers；只要还有条目 URL，恢复后可重新抓取。
    // 这条放宽只给规则型订阅源：RSS 2.0 feed 的条目必须带摘要。
    const mediaEntry = subscriptionEntry && chapterSource?.kind === 'rss' && chapterSource.feed !== true
      && typeof result.url === 'string' && result.url.trim().length > 0
    if (!bookIds.has(result.bookId) || !Number.isInteger(result.index) || result.index < 0 || badText || badDescription || badCover
      || (typeof result.text !== 'string' && !summaryOnly && !mediaEntry)) {
      if (feedEntry && typeof result.text !== 'string' && !summaryOnly) {
        throw new ReaderError('reader/invalid-backup', `章节 ${result.id} 缺少摘要，RSS 2.0 订阅条目无法恢复。`)
      }
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

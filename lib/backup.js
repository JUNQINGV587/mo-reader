import { normalizeBookContentType, normalizeSourceContentType } from './content-types.js'
import { ReaderError } from './errors.js'
import { assertNoSecrets, normalizeSource } from './rules.js'
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

function publicSource(source, { scrubRules = true } = {}) {
  const result = {
    id: source.id,
    name: source.name,
    bookSourceUrl: source.bookSourceUrl,
    allowHttp: source.allowHttp === true,
    enabled: source.enabled !== false,
    contentType: normalizeSourceContentType(source.contentType),
    ...(source.contentType === 'website' ? { homeUrl: source.homeUrl, searchUrl: source.searchUrl ?? null } : {}),
    // 导出时清洗规则里的敏感键；恢复时保留原值交给 normalizeRssSource 校验并报出字段路径。
    rules: scrubRules ? scrubSecrets(clone(source.rules ?? {})) : clone(source.rules ?? {}),
  }
  if (source.kind === 'rss') {
    result.kind = 'rss'
    result.categories = clone(source.categories ?? [])
    if (source.feed === true) {
      // feed 恢复只读 bookSourceUrl/name/categories/enabled/allowHttp；
      // contentType/rules/headers/unsupported 恢复时都不消费，导出不要带。
      delete result.contentType
      delete result.rules
      result.feed = true
    } else {
      const cleaned = publicHeaders(source.headers)
      result.headers = cleaned.headers
      result.unsupported = [...(Array.isArray(source.unsupported) ? source.unsupported : [])]
      if (cleaned.dropped.length && !result.unsupported.includes('credentials')) result.unsupported.push('credentials')
    }
  }
  return result
}

// 查询参数按名字边界匹配，避免把 design、author 里的 sig/auth 当成凭据。
const SECRET_QUERY_NAME = /(?:^|[-_])(?:token|secret|passw(?:ord)?|auth|signature|sig|api[_-]?key)(?:$|[-_])/i

function isSecretQueryName(name) {
  return SECRET_QUERY_NAME.test(String(name))
}

function urlHasSecrets(url) {
  return Boolean(url.username || url.password || url.hash) ||
    [...url.searchParams.keys()].some(isSecretQueryName)
}

function clearUrlSecrets(url) {
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const key of [...url.searchParams.keys()]) {
    if (isSecretQueryName(key)) url.searchParams.delete(key)
  }
  return url
}

function publicUrl(value) {
  try {
    return clearUrlSecrets(new URL(String(value))).href
  } catch {
    return value
  }
}

// 请求头里可能出现相对地址或协议相对地址；它们同样要清洗，但不能改写成绝对地址。
function headerUrl(value) {
  const text = String(value)
  try {
    return { url: new URL(text), relative: false }
  } catch {}
  try {
    return { url: new URL(text, 'https://header.invalid'), relative: true }
  } catch {
    return null
  }
}

function cleanRelativeUrl(parsed, original) {
  const url = clearUrlSecrets(parsed)
  const suffix = url.pathname + url.search
  if (original.startsWith('//')) return '//' + url.host + suffix
  if (original.startsWith('/')) return suffix
  if (original.startsWith('?')) return url.search
  if (original.startsWith('#')) return ''
  return suffix.replace(/^\//, '')
}

const AUTH_HEADER_VALUE = /^(?:Bearer|Basic|Token)\b/i

// 请求头值可能本身就是 URL（如 Referer），其中的用户名/密码、片段与敏感查询参数不能进备份。
// 没有可清理内容的普通值原样保留，避免把 header 值改写成规范化后的 URL。
function publicHeaderValue(value) {
  if (typeof value !== 'string') return value
  if (AUTH_HEADER_VALUE.test(value.trim())) return null
  const parsed = headerUrl(value)
  if (!parsed || !urlHasSecrets(parsed.url)) return value
  return parsed.relative ? cleanRelativeUrl(parsed.url, value) : publicUrl(value)
}

function publicHeaders(headers) {
  const input = clone(headers ?? {})
  const dropped = []
  const scrubbed = scrubSecrets(input)
  if (input && typeof input === 'object' && !Array.isArray(input) && scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed)) {
    for (const name of Object.keys(input)) {
      if (!Object.hasOwn(scrubbed, name)) dropped.push(name)
    }
  }
  if (!scrubbed || typeof scrubbed !== 'object' || Array.isArray(scrubbed)) return { headers: scrubbed, dropped }
  const result = {}
  for (const [name, value] of Object.entries(scrubbed)) {
    const cleaned = publicHeaderValue(value)
    if (cleaned === null) {
      dropped.push(name)
      continue
    }
    result[name] = cleaned
  }
  return { headers: result, dropped }
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

function sanitizeBackupHeaders(backup) {
  if (!Array.isArray(backup.sources)) return
  for (const source of backup.sources) {
    if (!source || typeof source !== 'object' || source.headers === undefined) continue
    const cleaned = publicHeaders(source.headers)
    source.headers = cleaned.headers
    if (cleaned.dropped.length) {
      const unsupported = Array.isArray(source.unsupported) ? source.unsupported : []
      source.unsupported = [...new Set([...unsupported, 'credentials'])]
    }
  }
}

// 订阅源恢复的统一入口：先按导出用的字段映射（publicSource）还原一次，
// 再按记录类型走规范化；导出与恢复共用这一份映射，规则由 normalizeRssSource 校验后落库。
function restoreSource(source, index) {
  const raw = publicSource(source, { scrubRules: false })
  if (raw.kind !== 'rss') return normalizeSource(raw, { allowHttp: raw.allowHttp })
  // feed 源没有 ruleArticles/sortUrl，不能走 normalizeRssSource；按备份记录恢复，不重新抓取。
  if (raw.feed === true) {
    try {
      return restoreFeedSource(raw)
    } catch (error) {
      if (error?.code === 'reader/invalid-backup') throw error
      throw new ReaderError('reader/invalid-backup', '订阅源记录无效。', undefined, { cause: error })
    }
  }
  if (!Array.isArray(raw.categories) || raw.categories.some(category => !category || typeof category.name !== 'string' || typeof category.url !== 'string')) {
    throw new ReaderError('reader/invalid-backup', '订阅源分类记录无效。')
  }
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
    }, { allowHttp: raw.allowHttp, rulesPath: `sources[${index}].rules` })
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
  sanitizeBackupHeaders(backup)
  // 先恢复源，让规则错误带 sources[i].rules 路径；否则全局敏感键扫描会先报一个
  // 没有来源路径的 "Header Cookie is not allowed."。恢复后的源已不含敏感键。
  const declaredSources = Array.isArray(backup.sources) ? backup.sources : null
  if (declaredSources) backup.sources = declaredSources.map((source, index) => restoreSource(source, index))
  try {
    assertNoSecrets(backup, 'backup')
  } catch (error) {
    if (error?.code === 'reader/invalid-backup') throw error
    throw new ReaderError('reader/invalid-backup', error.message, undefined, { cause: error })
  }
  const sources = array(backup.sources, 'sources')
  const sourceIds = new Set(sources.map(source => source.id))
  // 恢复时规则型订阅源会按地址重新生成 ID，章节校验要按备份里声明的 sourceId 找源类型。
  const backupSources = new Map((declaredSources ?? sources)
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
    const hasText = typeof result.text === 'string' && result.text.trim().length > 0
    const chapterSource = bookSources.get(result.bookId)
    const feedEntry = chapterSource?.kind === 'rss' && chapterSource.feed === true
    // 订阅媒体条目备份时不保留 mediaUrl/headers；只要还有条目 URL，恢复后可重新抓取。
    // 这条放宽只给规则型订阅源：RSS 2.0 feed 的条目必须带非空摘要，空 text 不能替代。
    const mediaEntry = subscriptionEntry && chapterSource?.kind === 'rss' && chapterSource.feed !== true
      && typeof result.url === 'string' && result.url.trim().length > 0
    if (feedEntry && !summaryOnly) {
      throw new ReaderError('reader/invalid-backup', `章节 ${result.id} 缺少摘要，RSS 2.0 订阅条目无法恢复。`)
    }
    if (!bookIds.has(result.bookId) || !Number.isInteger(result.index) || result.index < 0 || badText || badDescription || badCover
      || (!hasText && !summaryOnly && !mediaEntry)) {
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

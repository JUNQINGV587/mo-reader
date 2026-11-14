import { ReaderError } from './errors.js'
import { cleanHeaders, parseRemoteUrl } from './http.js'
import { requiredString, stableId } from './utils.js'

const CATEGORY_BREAK = /\s*(?:&&|\r?\n)\s*/
const MAX_CATEGORIES = 500
const SCRIPT_URL = /^(?:@js\s*:|<js[\s>])/i

// Legado 的 RssSource 与书源共用导入入口，但没有 bookSourceUrl。
// 这里只认订阅源特征，普通采集源仍然交给 normalizeSource 报错。
export function detectRssSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  if (raw.bookSourceUrl !== undefined) return false
  if (typeof raw.sourceUrl !== 'string' || !raw.sourceUrl.trim()) return false
  return raw.ruleArticles !== undefined
    || raw.sortUrl !== undefined
    || raw.articleStyle !== undefined
    || (raw.sourceName !== undefined && raw.ruleContent !== undefined)
}

function untrackedSourceUrl(value) {
  return requiredString(value, 'sourceUrl', 4096).trim().replace(/#$/, '')
}

function headerEntries(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    try { return headerEntries(JSON.parse(text)) } catch {}
    return text.split(/\r?\n/).map((line) => {
      const at = line.indexOf(':')
      return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)]
    })
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.entries(value)
  return []
}

// 空字符串 / 空对象 / false 不算“声明了这项能力”，避免把空字段报成不支持。
function present(value) {
  if (typeof value === 'string') return value.trim().length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return value !== undefined && value !== null && value !== false
}

function droppedCapabilities(raw) {
  const capabilities = []
  const cookieHeader = headerEntries(raw.header).some(([key, item]) => key.trim().toLowerCase() === 'cookie' && String(item).trim().length > 0)
  if (raw.enabledCookieJar === true || cookieHeader) capabilities.push('cookie')
  if (present(raw.loginUrl) || present(raw.loginUi) || present(raw.loginCheckJs)) capabilities.push('login')
  if (present(raw.injectJs) || present(raw.preloadJs)) capabilities.push('inject-js')
  return capabilities
}

function splitCategoryLines(value) {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === 'string' ? item.split(CATEGORY_BREAK) : [])
  if (typeof value !== 'string') return []
  return value.split(CATEGORY_BREAK)
}

function resolveCategoryUrl(value, sourceUrl, allowHttp) {
  let href
  try {
    href = new URL(value, sourceUrl).href
  } catch {
    throw new ReaderError('reader/invalid-source', `订阅源分类地址不是有效网址：${value.slice(0, 60)}`)
  }
  // {{page}} 等模板变量在 URL 解析时会被转义；保留原文，后续展开分页。
  href = href.replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}')
  const probe = href.replace(/\{\{[^}]*\}\}/g, '1')
  try {
    parseRemoteUrl(probe, { allowHttp })
  } catch (error) {
    if (error instanceof ReaderError) throw new ReaderError(error.code, `订阅源分类地址不可用：${value.slice(0, 60)}。${error.message}`)
    throw error
  }
  return href
}

function parseCategory(line, index, sourceUrl, allowHttp) {
  const text = String(line || '').trim()
  if (!text) return null
  if (SCRIPT_URL.test(text)) throw new ReaderError('reader/unsupported-source', '订阅源的分类由脚本生成，墨读暂不支持。')
  const separator = text.indexOf('::')
  const name = separator >= 0 ? text.slice(0, separator).trim() : `分类${index + 1}`
  const value = separator >= 0 ? text.slice(separator + 2).trim() : text
  if (!name || !value) throw new ReaderError('reader/invalid-source', `订阅源分类格式无效：${text.slice(0, 60)}`)
  if (name.length > 200) throw new ReaderError('reader/invalid-source', `订阅源分类名过长：${name.slice(0, 60)}`)
  if (SCRIPT_URL.test(value)) throw new ReaderError('reader/unsupported-source', '订阅源的分类地址由脚本生成，墨读暂不支持。')
  return { name, url: resolveCategoryUrl(value, sourceUrl, allowHttp) }
}

function readCategories(raw, sourceUrl, allowHttp) {
  if (typeof raw.sortUrl === 'string' && SCRIPT_URL.test(raw.sortUrl.trim())) {
    throw new ReaderError('reader/unsupported-source', '订阅源的分类由脚本生成，墨读暂不支持。')
  }
  const lines = splitCategoryLines(raw.sortUrl)
  const seen = new Set()
  const categories = []
  lines.forEach((line, index) => {
    const category = parseCategory(line, index, sourceUrl, allowHttp)
    if (!category || seen.has(category.url)) return
    if (category.url.length > 4096) throw new ReaderError('reader/invalid-source', `订阅源分类地址过长：${category.name.slice(0, 40)}`)
    seen.add(category.url)
    categories.push(category)
  })
  if (categories.length > MAX_CATEGORIES) throw new ReaderError('reader/too-large', `订阅源分类过多，最多 ${MAX_CATEGORIES} 个。`)
  if (categories.length) return categories
  return [{ name: String(raw.sourceName ?? raw.name ?? new URL(sourceUrl).hostname), url: sourceUrl }]
}

// 条目列表与正文沿用书源规则的名字（chapterList/chapterName/chapterUrl），
// 这样订阅和书源共用同一套选择器与 @js 执行器；封面、时间、摘要是订阅额外字段。
function articleRules(raw) {
  const toc = Object.fromEntries(Object.entries({
    chapterList: raw.ruleArticles,
    chapterName: raw.ruleTitle,
    chapterUrl: raw.ruleLink,
    chapterCover: raw.ruleImage,
    chapterDate: raw.rulePubDate,
    chapterDescription: raw.ruleDescription,
    nextPage: raw.ruleNextPage,
  }).filter(([, value]) => value !== undefined && value !== null && value !== ''))
  const rules = {}
  if (Object.keys(toc).length) rules.toc = toc
  if (raw.ruleContent !== undefined && raw.ruleContent !== null && raw.ruleContent !== '') rules.content = { content: raw.ruleContent }
  return rules
}

export function normalizeRssSource(raw, { allowHttp = false } = {}) {
  if (!detectRssSource(raw)) throw new ReaderError('reader/invalid-source', '这不是 Legado 订阅源。')
  const sourceUrl = untrackedSourceUrl(raw.sourceUrl)
  parseRemoteUrl(sourceUrl, { allowHttp })
  const name = requiredString(raw.sourceName ?? raw.name ?? new URL(sourceUrl).hostname, 'sourceName', 200)
  const categories = readCategories(raw, sourceUrl, allowHttp)
  // 订阅源的静态请求头可以用于抓正文与探测媒体，但 Cookie/凭据在导入时丢弃，
  // 不落库也不发送；其余头沿用书源请求层的同一套校验。
  // 备份恢复传的是已清理的 headers；Legado 导入传的是原始 header 字符串。
  const declared = {
    ...Object.fromEntries(headerEntries(raw.headers)),
    ...Object.fromEntries(headerEntries(raw.header)),
  }
  const droppedHeaders = []
  const cleaned = cleanHeaders(declared, {
    dropForbidden: true,
    onDrop: (name, reason, kind) => droppedHeaders.push({ name, reason, kind }),
  })
  // cleanHeaders 会补默认 UA/Accept；只落库源真正声明的头，别把 text/html 带给 CDN。
  const declaredNames = new Set(Object.keys(declared).map(name => name.toLowerCase()))
  const headers = Object.fromEntries(Object.entries(cleaned).filter(([name]) => declaredNames.has(name)))
  const unsupported = [...new Set([
    ...(Array.isArray(raw.unsupported) ? raw.unsupported.filter(item => typeof item === 'string') : []),
    ...droppedCapabilities(raw),
    ...(droppedHeaders.some(item => item.kind === 'credential') ? ['credentials'] : []),
  ])]
  const mappedRules = articleRules(raw)
  const rules = Object.keys(mappedRules).length || !raw.rules || typeof raw.rules !== 'object' || Array.isArray(raw.rules)
    ? mappedRules
    : raw.rules
  return {
    id: stableId('rss-source', sourceUrl),
    name,
    bookSourceUrl: sourceUrl,
    kind: 'rss',
    contentType: 'subscription',
    allowHttp,
    enabled: raw.enabled !== false,
    unsupported,
    categories,
    headers,
    rules,
  }
}

// 分类地址是列表页模板；作品卡需要一个真实地址，先把第一页展开。
export function categoryPageUrl(categoryUrl, sourceUrl) {
  const value = String(categoryUrl).replace(/\{\{\s*page\s*\}\}/g, '1')
  return new URL(value, sourceUrl).href
}

export function rssImportSummary(source) {
  return {
    kind: 'rss',
    sourceId: source.id,
    name: source.name,
    categories: source.categories,
    unsupported: source.unsupported,
  }
}

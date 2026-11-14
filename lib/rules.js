import * as cheerio from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import { ReaderError } from './errors.js'
import { BOOK_CONTENT_TYPES, contentTypeFromLegado } from './content-types.js'
import { runSourceScript } from './source-script.js'
import { cleanHeaders, parseRemoteUrl } from './http.js'
import { requiredString, stableId } from './utils.js'

const SECRET_KEY = /^(?:.*(?:password|passwd|credential|secret|cookie|authorization).*|(?:access|refresh|id|auth|session|api|client)?[-_]?token|api[-_]?key|auth|session)$/i
const JS_RULE = /<\s*js\b|@js\b|@java\b|<\s*java\b|\brhino\b|\bwebview\b|\beval\s*\(|javascript:/i
const WEBVIEW_RULE = /\bwebview\b|<\s*webview/i
const XPATH_RULE = /^@?xpath\s*:/i
const REQUEST_KEYS = ['url', 'method', 'body', 'headers', 'charset', 'nextPage']
const MAP_LIST_URL_FIELDS = new Set(['bookUrl', 'chapterUrl', 'url', 'coverUrl', 'cover', 'chapterCover'])
const UNSUPPORTED_KEYS = {
  loginurl: 'login',
  loginui: 'login',
  logincheckjs: 'login',
  webview: 'webview',
  captcha: 'captcha',
  captchaurl: 'captcha',
  pay: 'payment',
  payurl: 'payment',
  purchase: 'payment',
}

function unsupportedCapabilities(value) {
  const found = new Set()
  const visit = (item) => {
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      const capability = UNSUPPORTED_KEYS[key.toLowerCase()]
      if (capability && child !== undefined && child !== null && child !== '' && child !== false) found.add(capability)
      if (child && typeof child === 'object') visit(child)
    }
  }
  visit(value)
  return [...found].sort()
}

function xpathUnsupported(expression, detail = '') {
  return new ReaderError('reader/unsupported-rule', `XPath 暂不支持该写法${detail ? `：${detail}` : ''}。${expression ? `（${expression}）` : ''}`)
}

function cssQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function cssAttribute(name) {
  if (!/^[-\w]+$/.test(name)) throw xpathUnsupported('', `属性 ${name}`)
  return name
}

function splitXPathAnd(value) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '(' || char === '[') depth += 1
    else if (char === ')' || char === ']') depth -= 1
    else if (depth === 0 && value.slice(index, index + 5).toLowerCase() === ' and ') {
      parts.push(value.slice(start, index))
      start = index + 5
      index += 4
    }
  }
  parts.push(value.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

function xpathPredicate(predicate, tag) {
  const expression = predicate.trim()
  if (/^\d+$/.test(expression)) {
    return tag === '*' ? `:nth-child(${Number(expression)})` : `:nth-of-type(${Number(expression)})`
  }
  if (/^last\(\)$/i.test(expression)) {
    return tag === '*' ? ':last-child' : ':last-of-type'
  }
  const attribute = /^@([-\w:]+)$/.exec(expression)
  if (attribute) return `[${cssAttribute(attribute[1])}]`
  const equals = /^@([-\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(expression)
  if (equals) return `[${cssAttribute(equals[1])}=${cssQuote(equals[2] ?? equals[3])}]`
  const contains = /^contains\(\s*@([-\w:]+)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(expression)
  if (contains) return `[${cssAttribute(contains[1])}*=${cssQuote(contains[2] ?? contains[3])}]`
  const starts = /^starts-with\(\s*@([-\w:]+)\s*,\s*(?:"([^"]*)"|'([^']*)')\s*\)$/i.exec(expression)
  if (starts) return `[${cssAttribute(starts[1])}^=${cssQuote(starts[2] ?? starts[3])}]`
  throw xpathUnsupported('', `谓词 ${expression}`)
}

function xpathSegment(segment) {
  const match = /^([A-Za-z_][\w:-]*|\*)?/.exec(segment)
  const tag = match?.[1] ?? '*'
  let rest = segment.slice(match?.[0].length ?? 0)
  let css = tag === '*' ? '' : tag
  while (rest) {
    if (rest[0] !== '[') throw xpathUnsupported('', `路径 ${segment}`)
    let depth = 0
    let quote = ''
    let end = -1
    for (let index = 1; index < rest.length; index += 1) {
      const char = rest[index]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '[') depth += 1
      else if (char === ']') {
        if (depth === 0) { end = index; break }
        depth -= 1
      }
    }
    if (end < 0) throw xpathUnsupported('', `谓词 ${rest}`)
    const predicate = rest.slice(1, end)
    for (const part of splitXPathAnd(predicate)) css += xpathPredicate(part, tag)
    rest = rest.slice(end + 1)
  }
  return css
}

function xpathToCss(expression) {
  if (!expression || expression === '.') return ''
  let text = expression.trim()
  if (text.startsWith('.//')) text = text.slice(1)
  else if (text.startsWith('./')) text = text.slice(1)
  if (text.includes('|') || text.includes('::') || /\.\.(?:[/[]|$)/.test(text)) throw xpathUnsupported(expression, '轴或 union')
  let position = 0
  let descendant = true
  if (text.startsWith('//')) position = 2
  else if (text.startsWith('/')) { position = 1; descendant = false }
  if (position === 0 && !/^[A-Za-z_*[]/.test(text)) throw xpathUnsupported(expression)
  let css = ''
  let first = true
  while (position < text.length) {
    let end = position
    let depth = 0
    let quote = ''
    for (; end < text.length; end += 1) {
      const char = text[end]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '[') depth += 1
      else if (char === ']') depth -= 1
      else if (char === '/' && depth === 0) break
    }
    const segment = text.slice(position, end)
    if (!segment) throw xpathUnsupported(expression)
    if (/^text\(\)$|^@[-\w:]+$/.test(segment)) throw xpathUnsupported(expression, '非末尾取值')
    const part = xpathSegment(segment)
    if (first) css = part
    else css += `${descendant ? ' ' : ' > '}${part}`
    first = false
    if (end >= text.length) break
    descendant = text.slice(end, end + 2) === '//'
    position = end + (descendant ? 2 : 1)
  }
  if (!css) throw xpathUnsupported(expression)
  return css
}

function xpathRule(rule) {
  let expression = rule.replace(/^@?xpath\s*:/i, '').trim()
  if (!expression) throw new ReaderError('reader/invalid-source', 'Empty XPath rule.')
  let action = 'text'
  const attribute = /\/@([-\w:]+)\s*$/.exec(expression)
  if (attribute) {
    action = attribute[1]
    expression = expression.slice(0, attribute.index)
  } else if (/\/text\(\)\s*$/.test(expression)) {
    expression = expression.replace(/\/text\(\)\s*$/, '')
  }
  if (/\/@[-\w:]+\s*$|\/text\(\)\s*$|\/(?:text\(\)|@)/.test(expression)) throw xpathUnsupported(expression, '非末尾取值')
  return { selector: xpathToCss(expression), action }
}

function xpathValues(document, rule) {
  const { selector, action } = xpathRule(rule)
  return cssValues(document, selector ? `${selector}${action === 'text' ? '' : `@${action}`}` : `@${action}`)
}

function walkRules(value, visit, path = 'source') {
  if (typeof value === 'string') visit(value, path)
  else if (Array.isArray(value)) value.forEach((item, index) => walkRules(item, visit, `${path}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walkRules(item, visit, `${path}.${key}`)
  }
}

export function assertNoSecrets(value, path = 'source') {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    const flagOnly = typeof item !== 'string' || /^(true|false|0|1)$/i.test(item)
    const benignFlag = /^(enabled|enabledCookieJar|enabledExplore|enabledReview|enabledJs|enabledBookInfo)$/i.test(key)
    if (SECRET_KEY.test(key) && !(benignFlag && flagOnly)) throw new ReaderError('reader/credentials-forbidden', `${path}.${key} is not accepted; reader sources must not contain secrets.`)
    if (key.toLowerCase() === 'headers' && item && typeof item === 'object') cleanHeaders(item)
    if (item && typeof item === 'object') assertNoSecrets(item, `${path}.${key}`)
  }
}

export function assertBasicRules(value, path = 'source') {
  walkRules(value, (rule, rulePath) => {
    if (WEBVIEW_RULE.test(rule)) throw new ReaderError('reader/unsupported-source', `${rulePath}: 该书源需要 WebView，暂不支持。`)
    // JS 规则交由 source-script 的隔离 Worker 执行，这里只拒绝 WebView。
    if (JS_RULE.test(rule)) return
  }, path)
}

function isPlainRuleObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertRuleValue(value, path) {
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item !== 'string') {
        throw new ReaderError('reader/unsupported-rule', `${path}[${index}]: 规则值必须是字符串或字符串数组。`)
      }
    })
    return
  }
  if (isPlainRuleObject(value)) {
    for (const [key, item] of Object.entries(value)) assertRuleValue(item, `${path}.${key}`)
    return
  }
  throw new ReaderError('reader/unsupported-rule', `${path}: 规则值必须是字符串或字符串数组。`)
}

// 恢复订阅源规则前的类型校验：toc/content 必须是普通对象，叶子值只能是字符串或字符串数组。
export function assertRuleTypes(value, path = 'source') {
  if (!isPlainRuleObject(value)) {
    throw new ReaderError('reader/unsupported-rule', `${path}: 规则必须是一个普通对象。`)
  }
  for (const field of ['toc', 'content']) {
    if (value[field] === undefined) continue
    if (!isPlainRuleObject(value[field])) {
      throw new ReaderError('reader/unsupported-rule', `${path}.${field}: 规则必须是一个普通对象。`)
    }
  }
  assertRuleValue(value, path)
}

// 检测规则是否是 JS 脚本（@js: 或 <js>）
export function isJsRule(value) {
  if (Array.isArray(value)) return value.some(isJsRule)
  return typeof value === 'string' && JS_RULE.test(value)
}

// Legado 的字段规则可以写成「选择器@js:脚本」：选择器先取出 result，脚本再处理它。
export function splitJsRule(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      if (!value.some(isJsRule)) return null
      throw new ReaderError('reader/unsupported-rule', 'JS 规则数组只能包含一个脚本。')
    }
    return splitJsRule(value[0])
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (WEBVIEW_RULE.test(text)) throw new ReaderError('reader/unsupported-source', '该书源需要 WebView，暂不支持。')
  const tagMatch = text.match(/^<js[^>]*>([\s\S]*)<\/js>$/i)
  if (tagMatch) return { selector: '', code: tagMatch[1] }
  const atMatch = text.match(/^@js\s*:\s*([\s\S]+)$/i)
  if (atMatch) return { selector: '', code: atMatch[1] }
  const index = text.search(/@js\s*:/i)
  if (index > 0) {
    const selector = text.slice(0, index).trim()
    const code = text.slice(index).replace(/^@js\s*:\s*/i, '')
    if (!code) throw new ReaderError('reader/unsupported-rule', 'JS 规则缺少脚本。')
    return { selector, code }
  }
  if (JS_RULE.test(text)) return { selector: '', code: text }
  return null
}



// 裸 JS 规则的 result 是整页文本；带前缀的规则先由前缀选择器取值。
function documentSourceText(document) {
  if (!document) return ''
  if (document.kind === 'json') return JSON.stringify(document.value ?? null)
  return document.html ?? document.$?.html?.() ?? ''
}

function scriptContext({ document, source, variables = {}, baseUrl, result } = {}) {
  const context = {
    baseUrl: baseUrl ?? source?.bookSourceUrl,
    src: documentSourceText(document),
    page: variables.page ?? 1,
    key: variables.key,
    bookUrl: variables.bookUrl,
    bookName: variables.bookName,
    chapterUrl: variables.chapterUrl,
    chapterTitle: variables.chapterTitle,
    source: source ? { bookSourceUrl: source.bookSourceUrl, name: source.name, contentType: source.contentType } : undefined,
  }
  if (result !== undefined) context.result = result
  return context
}

// Legado 的 searchUrl 形如 `/search,{"method":"POST","body":"q={{key}}"}`，路径相对 bookSourceUrl。
function parseLegadoSearchUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return {}
  const comma = value.indexOf(',{')
  const path = (comma < 0 ? value : value.slice(0, comma)).trim()
  let options = {}
  if (comma >= 0) { try { options = JSON.parse(value.slice(comma + 1)) } catch { options = {} } }
  let absolute = path
  if (path && !/^https?:/i.test(path) && typeof baseUrl === 'string' && /^https?:/i.test(baseUrl)) {
    const base = new URL(baseUrl)
    absolute = `${base.origin}${path.startsWith('/') ? '' : '/'}${path}`
  }
  return { url: absolute || undefined, ...options }
}

function mapLegado(rule, fields) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule
  const result = { ...rule }
  for (const [target, source] of Object.entries(fields)) {
    if (result[target] === undefined && result[source] !== undefined) result[target] = result[source]
  }
  return result
}

function normalizeRequest(rule = {}) {
  if (typeof rule === 'string') return { url: rule }
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return {}
  const result = { ...rule }
  if (result.method !== undefined) result.method = String(result.method).toUpperCase()
  if (result.headers !== undefined) cleanHeaders(result.headers)
  return result
}

export function normalizeSource(raw, { allowHttp = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReaderError('reader/invalid-source', '书源必须是一个 JSON 对象。')
  const unsupported = unsupportedCapabilities(raw)
  if (raw.contentType === 'website') {
    contentTypeFromLegado(raw.bookSourceType)
    const homeUrl = requiredString(raw.homeUrl, 'homeUrl', 4096)
    parseRemoteUrl(homeUrl, { allowHttp })
    const scrapingKeys = ['search', 'ruleSearch', 'bookInfo', 'ruleBookInfo', 'toc', 'ruleToc', 'content', 'ruleContent', 'explore', 'ruleExplore']
    if (scrapingKeys.some(key => raw[key] !== undefined && raw[key] !== null && raw[key] !== '') || (raw.rules && typeof raw.rules === 'object' && Object.keys(raw.rules).length)) {
      throw new ReaderError('reader/unsupported-source', '网站源只提供站点入口，不支持抓取规则。')
    }
    const searchUrl = raw.searchUrl === undefined || raw.searchUrl === null || raw.searchUrl === '' ? null : requiredString(raw.searchUrl, 'searchUrl', 4096)
    if (searchUrl) parseRemoteUrl(renderTemplate(searchUrl, { key: 'probe' }), { allowHttp })
    return {
      id: stableId('source', homeUrl),
      name: requiredString(raw.bookSourceName ?? raw.name ?? new URL(homeUrl).hostname, 'bookSourceName', 200),
      bookSourceUrl: homeUrl,
      homeUrl,
      searchUrl,
      allowHttp,
      enabled: raw.enabled !== false,
      contentType: 'website',
      unsupported,
      rules: {},
    }
  }
  // Legado 里这些字段是客户端脚本/自定义 UI，第一期从不执行，直接丢掉而不是整源拒绝。
  const SKIPPABLE = ['exploreUrl', 'ruleExplore', 'loginUrl', 'loginUi', 'eventListener', 'customButton', 'customOrder', 'ruleReview', 'ruleBookInfo.review']
  const dropped = SKIPPABLE.filter((key) => {
    const value = raw[key]
    if (typeof value === 'string') return JS_RULE.test(value)
    return value !== undefined && value !== null && typeof value === 'object' && JS_RULE.test(JSON.stringify(value))
  })
  if (dropped.length) {
    raw = { ...raw }
    for (const key of dropped) delete raw[key]
  }
  assertNoSecrets(raw)
  assertBasicRules(raw)
  if (raw.bookSourceUrl === undefined && raw.sourceUrl !== undefined) {
    const rss = raw.ruleArticles !== undefined || raw.sortUrl !== undefined || raw.articleStyle !== undefined || (raw.sourceName !== undefined && raw.ruleContent !== undefined)
    if (rss) throw new ReaderError('reader/unsupported-source', '这是 Legado 订阅源（RSS）的字段，但缺少有效的 sourceUrl，无法作为书源或订阅源导入。')
    throw new ReaderError('reader/unsupported-source', '这是采集源格式，不是 Legado 书源；墨读只支持 bookSourceUrl 形式的书源。')
  }
  const legadoContentType = contentTypeFromLegado(raw.bookSourceType)
  const contentType = BOOK_CONTENT_TYPES.includes(raw.contentType) ? raw.contentType : legadoContentType
  // 订阅作品只能由订阅源生成；普通书源声明 subscription 会得到永远不会追更的假订阅。
  if (contentType === 'subscription') throw new ReaderError('reader/invalid-source', '只有订阅源可以生成订阅作品，普通书源请使用 novel/comic/audio/video。')
  const sourceUrl = requiredString(raw.bookSourceUrl ?? raw.url, 'bookSourceUrl', 4096)
  parseRemoteUrl(sourceUrl, { allowHttp })
  const name = requiredString(raw.bookSourceName ?? raw.name ?? new URL(sourceUrl).hostname, 'bookSourceName', 200)
  const groups = raw.rules && typeof raw.rules === 'object' ? raw.rules : raw
  const searchRule = mapLegado(raw.search ?? raw.ruleSearch ?? groups.search, { list: 'bookList' }) ?? {}
  const legadoSearch = parseLegadoSearchUrl(raw.searchUrl, raw.bookSourceUrl ?? raw.url)
  const search = normalizeRequest({ ...legadoSearch, ...searchRule, url: searchRule.url ?? legadoSearch.url })
  const exploreRaw = raw.explore ?? raw.ruleExplore ?? groups.explore
  const explore = Array.isArray(exploreRaw)
    ? exploreRaw.map(item => normalizeRequest(item))
    : normalizeRequest(exploreRaw)
  const bookInfo = normalizeRequest(raw.bookInfo ?? raw.ruleBookInfo ?? groups.bookInfo)
  const toc = normalizeRequest(mapLegado(raw.toc ?? raw.ruleToc ?? groups.toc, { list: 'chapterList', name: 'chapterName' }))
  const content = normalizeRequest(raw.content ?? raw.ruleContent ?? groups.content)
  if (search.method && search.method !== 'GET' && search.method !== 'POST') throw new ReaderError('reader/unsupported-rule', 'search 仅支持 GET/POST。')
  return {
    id: stableId('source', sourceUrl),
    name,
    bookSourceUrl: sourceUrl,
    allowHttp,
    enabled: raw.enabled !== false,
    contentType,
    unsupported,
    rules: { search, explore, bookInfo, toc, content },
  }
}

export function renderTemplate(template, variables = {}) {
  if (typeof template !== 'string') throw new ReaderError('reader/invalid-source', 'URL template must be a string.')
  const values = { page: 1, ...variables }
  return template.replace(/\{\{\s*(!?)([\w.-]+)\s*\}\}/g, (_match, raw, key) => {
    if (values[key] === undefined || values[key] === null) throw new ReaderError('reader/invalid-source', `Missing URL template variable ${key}.`)
    // `{{!name}}` inserts the value verbatim: whole-URL variables such as bookUrl
    // would otherwise be percent-encoded into an unusable address.
    return raw ? String(values[key]) : encodeURIComponent(String(values[key]))
  })
}

const TEMPLATE_TOKEN = /\{\{\s*(!?)([\s\S]*?)\s*\}\}/g
const TEMPLATE_NAME = /^[\w.-]+$/

// {{...}} 里不是简单名字时要在沙箱里求值，等同于给书源新增 JS 能力。
export function hasTemplateExpression(value) {
  if (Array.isArray(value)) return value.some(hasTemplateExpression)
  if (typeof value !== 'string') return false
  return (value.match(/\{\{[\s\S]*?\}\}/g) ?? []).some(token => {
    const body = token.slice(2, -2).trim().replace(/^!/, '').trim()
    return body !== '' && !TEMPLATE_NAME.test(body)
  })
}

// 与 renderTemplate 相同的 {{name}} 语义，另外允许 {{page*2}} 这类表达式：
// 表达式在同一个 @js 沙箱里批量求值，仍然只能访问规则上下文里的名字。
export async function renderTemplateAsync(template, variables = {}, options = {}) {
  if (typeof template !== 'string') throw new ReaderError('reader/invalid-source', 'URL template must be a string.')
  const values = { page: 1, ...variables }
  const tokens = []
  template.replace(TEMPLATE_TOKEN, (match, bang, body, offset) => {
    tokens.push({ match, bang: Boolean(bang), expression: String(body).trim(), offset })
    return match
  })
  if (!tokens.length) return template
  const resolved = new Map()
  const simple = tokens.filter(token => TEMPLATE_NAME.test(token.expression))
  const complex = tokens.filter(token => !TEMPLATE_NAME.test(token.expression))
  for (const token of simple) {
    const value = values[token.expression]
    if (value === undefined || value === null) throw new ReaderError('reader/invalid-source', `Missing URL template variable ${token.expression}.`)
    resolved.set(token, String(value))
  }
  if (complex.length) {
    let results
    try {
      results = await runSourceScript('[' + complex.map(token => `(async () => (${token.expression}))()`).join(',') + ']', {
        source: options.source,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        context: scriptContext({ document: options.document, source: options.source, variables: values, baseUrl: options.baseUrl }),
        rawValue: true,
      })
    } catch (error) {
      throw new ReaderError('reader/invalid-source', `地址模板表达式执行失败：${error?.message || String(error)}`, undefined, { cause: error })
    }
    if (!Array.isArray(results) || results.length !== complex.length) throw new ReaderError('reader/invalid-source', '地址模板表达式返回了意外的结果。')
    complex.forEach((token, index) => {
      const value = results[index]
      if (value === undefined || value === null) throw new ReaderError('reader/invalid-source', `地址模板表达式没有结果：${token.expression}`)
      resolved.set(token, String(value))
    })
  }
  let output = ''
  let cursor = 0
  for (const token of tokens) {
    output += template.slice(cursor, token.offset)
    output += token.bang ? resolved.get(token) : encodeURIComponent(resolved.get(token))
    cursor = token.offset + token.match.length
  }
  return output + template.slice(cursor)
}

export function renderValue(template, variables = {}) {
  if (typeof template !== 'string') throw new ReaderError('reader/invalid-source', 'Field template must be a string.')
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key) => {
    const value = variables[key]
    return value === undefined || value === null ? match : String(value)
  })
}

export function renderJsonBody(template, variables = {}) {
  if (typeof template !== 'string') throw new ReaderError('reader/invalid-source', 'JSON body must be a string.')
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (match, key, offset, source) => {
    const value = variables[key]
    if (value === undefined || value === null) return match
    const before = source.slice(0, offset).trimEnd().slice(-1)
    const after = source.slice(offset + match.length).trimStart()[0]
    if (before === '"' && after === '"') return JSON.stringify(String(value)).slice(1, -1)
    return JSON.stringify(value)
  })
}

export function responseDocument(text, contentType = '') {
  const trimmed = String(text).trim()
  if (/json/i.test(contentType) || /^[[{]/.test(trimmed)) {
    try {
      return { kind: 'json', value: JSON.parse(trimmed) }
    } catch (error) {
      if (/json/i.test(contentType)) throw new ReaderError('reader/parse-error', 'Remote response is not valid JSON.', undefined, { cause: error })
    }
  }
  return { kind: 'html', $: cheerio.load(text), root: undefined }
}

function jsonValues(document, path) {
  let expression = path.replace(/^@Json\s*:/i, '').trim()
  if (!expression) throw new ReaderError('reader/invalid-source', 'Empty JSONPath rule.')
  // Legado sources often omit the leading `$` (for example `data[*].name`).
  if (!/^[$@]/.test(expression) && !expression.startsWith('..')) expression = `$.${expression.replace(/^\./, '')}`
  try {
    return JSONPath({ path: expression, json: document.value, wrap: true })
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid JSONPath ${expression}.`, undefined, { cause: error })
  }
}

function splitCssAction(rule) {
  const match = /^(.*?)@(text|html|outerHtml|href|src|title|alt|value|id|class|data-[\w-]+|attr\([^)]+\))$/i.exec(rule)
  if (!match) return { selector: rule, action: 'text' }
  return { selector: match[1], action: match[2] }
}

function applyIndex(nodes, index) {
  if (index === undefined || nodes.length === 0) return nodes
  const position = index < 0 ? nodes.length + index : index
  const picked = nodes[position]
  return picked === undefined ? [] : [picked]
}

function splitIndex(selector) {
  const match = /^(.*?)!(-?\d+)$/.exec(selector)
  if (!match) return { selector, index: undefined }
  return { selector: match[1], index: Number(match[2]) }
}

function cssValues(document, rule) {
  const normalized = rule.replace(/^@css\s*:/i, '').trim()
  const { selector: rawSelector, action } = splitCssAction(normalized)
  const { selector, index } = splitIndex(rawSelector)
  let nodes
  if (!selector) {
    // `@text` / `@href` read from the element the list rule picked (an <a> in a
    // chapter list usually is the element itself, not its parent).
    if (document.root === undefined) throw new ReaderError('reader/invalid-source', 'Empty CSS selector.')
    nodes = [document.root]
    return nodes.map(node => {
      const element = document.$(node)
      if (action === 'text') return element.text().trim()
      if (action === 'html' || action === 'outerHtml') return (action === 'html' ? element.html() : document.$.html(node)) ?? ''
      if (action.startsWith('attr(')) return element.attr(action.slice(5, -1)) ?? ''
      return element.attr(action) ?? ''
    })
  }
  try {
    nodes = document.root === undefined ? document.$(selector) : document.$(document.root).find(selector)
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid CSS selector ${selector}.`, undefined, { cause: error })
  }
  return applyIndex(nodes.toArray(), index).map(node => {
    const element = document.$(node)
    if (action === 'text') return element.text().trim()
    if (action === 'html' || action === 'outerHtml') return (action === 'html' ? element.html() : document.$.html(node)) ?? ''
    if (action.startsWith('attr(')) return element.attr(action.slice(5, -1)) ?? ''
    return element.attr(action) ?? ''
  })
}

export function selectAll(document, rule) {
  if (rule === undefined || rule === null || rule === '') return []
  if (typeof rule !== 'string') throw new ReaderError('reader/unsupported-rule', 'List rules must be CSS or JSONPath strings.')
  if (document.kind === 'json' || /^@Json\s*:/i.test(rule) || rule.trim().startsWith('$')) return jsonValues(document, rule)
  const isXPath = XPATH_RULE.test(rule) || /^\s*\.?\//.test(rule)
  const selector = isXPath ? xpathRule(rule).selector : rule.replace(/^@css\s*:/i, '').trim()
  if (!selector) throw new ReaderError('reader/invalid-source', 'Empty CSS selector.')
  try {
    const nodes = document.root === undefined ? document.$(selector) : document.$(document.root).find(selector)
    return nodes.toArray()
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid CSS selector ${selector}.`, undefined, { cause: error })
  }
}

function childDocument(document, item) {
  if (document.kind === 'json') return { kind: 'json', value: item }
  return { ...document, root: item }
}

/**
 * Field rules may carry `##pattern###replacement` (Legado style) to reshape the
 * extracted text: with a replacement the value is rewritten (`$1` refs), without
 * one the first match group (or whole match) is returned.
 */
function parseTextRule(rule) {
  const mark = rule.indexOf('##')
  if (mark < 0) return null
  const rest = rule.slice(mark + 2)
  const split = rest.indexOf('###')
  const pattern = split < 0 ? rest : rest.slice(0, split)
  const replacement = split < 0 ? undefined : rest.slice(split + 3)
  if (!pattern) return null
  let expression
  try {
    expression = new RegExp(pattern)
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid field regex ${pattern}.`, undefined, { cause: error })
  }
  return { expression, replacement }
}

export function applyTextRule(value, textRule) {
  if (typeof value !== 'string') return value
  if (textRule.replacement !== undefined) return value.replace(textRule.expression, textRule.replacement)
  const match = textRule.expression.exec(value)
  if (!match) return ''
  return match[1] ?? match[0]
}

export async function extractOneAsync(document, rule, options = {}) {
  const parsed = splitJsRule(rule)
  if (!parsed) return extractOne(document, rule)
  let result
  if (parsed.selector) {
    if (options.isUrl) {
      // Legado reads URL fields with getString(..., isUrl = true), which keeps
      // only the first match; joining hrefs would produce an unusable URL.
      const extracted = extractOne(document, parsed.selector)
      result = extracted === undefined || extracted === null ? '' : String(extracted)
    } else {
      // Legado 330e606 AnalyzeByJSoup.getString joins every matched node with
      // newlines before the JS rule sees it. Taking only the first node here
      // silently drops paragraphs from multi-element selectors.
      result = joinedSelectorText(document, parsed.selector)
    }
  } else result = documentSourceText(document)
  return runSourceScript(parsed.code, {
    document,
    source: options.source,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    context: scriptContext({ document, source: options.source, variables: options.variables, baseUrl: options.baseUrl, result }),
  })
}

function selectorValues(document, rule) {
  if (rule === undefined || rule === null || rule === '') return []
  if (typeof rule !== 'string') {
    if (typeof rule === 'number' || typeof rule === 'boolean') return [String(rule)]
    throw new ReaderError('reader/unsupported-rule', 'Field rules must be strings.')
  }
  if (isJsRule(rule)) throw new ReaderError('reader/unsupported-rule', 'JS 规则必须通过 SourceEngine 异步执行。')
  if (document.kind === 'json' || /^@Json\s*:/i.test(rule) || rule.trim().startsWith('$')) {
    return jsonValues(document, rule).map(value => {
      if (value === undefined || value === null) return undefined
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
    })
  }
  return XPATH_RULE.test(rule) || /^\s*\.?\//.test(rule) ? xpathValues(document, rule) : cssValues(document, rule)
}

function splitTextRule(rule) {
  const textRule = typeof rule === 'string' ? parseTextRule(rule) : null
  return { textRule, base: textRule ? rule.slice(0, rule.indexOf('##')) : rule }
}

// Legado applies a field's ## regex after the selector result is assembled.
// Joining first keeps that order for a selector that matches several nodes.
function joinedSelectorText(document, rule) {
  const { textRule, base } = splitTextRule(rule)
  const values = selectorValues(document, base)
  const joined = values.map(value => value === undefined ? '' : String(value)).join('\n')
  return textRule && values.some(value => value !== undefined) ? applyTextRule(joined, textRule) : joined
}

export function extractOne(document, rule) {
  if (Array.isArray(rule)) {
    if (rule.length === 0) throw new ReaderError('reader/unsupported-rule', 'Field rules must be strings.')
    rule = rule[0]
  }
  const { textRule, base } = splitTextRule(rule)
  const first = selectorValues(document, base)[0]
  if (first === undefined || first === null) return undefined
  return textRule ? applyTextRule(first, textRule) : first
}

export function extractList(document, rule) {
  if (document.kind === 'json') return selectAll(document, rule).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value))
  if (XPATH_RULE.test(rule) || /^\s*\.?\//.test(String(rule ?? ''))) {
    const parsed = xpathRule(rule)
    if (parsed.action !== 'text') return cssValues(document, `${parsed.selector}@${parsed.action}`)
    const nodes = selectAll(document, rule)
    return nodes.map(node => document.$(node).text().trim())
  }
  const normalized = String(rule ?? '').replace(/^@css\s*:/i, '')
  const { selector, action } = splitCssAction(normalized)
  if (action !== 'text') return cssValues(document, rule)
  let nodes
  try {
    nodes = document.root === undefined ? document.$(selector) : document.$(document.root).find(selector)
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid CSS selector ${selector}.`, undefined, { cause: error })
  }
  return nodes.toArray().map(node => document.$(node).text().trim())
}

export async function mapListAsync(document, rule, fields, variables = {}, options = {}) {
  const results = []
  for (const item of selectAll(document, rule)) {
    const child = childDocument(document, item)
    const result = {}
    for (const [name, fieldRule] of Object.entries(fields)) {
      if (typeof fieldRule === 'string' && fieldRule.includes('{{')) continue
      const value = await extractOneAsync(child, fieldRule, { ...options, variables, isUrl: MAP_LIST_URL_FIELDS.has(name) })
      if (value !== undefined && value !== '') result[name] = value
    }
    for (const [name, fieldRule] of Object.entries(fields)) {
      if (typeof fieldRule !== 'string' || !fieldRule.includes('{{')) continue
      const value = renderValue(fieldRule, { ...variables, ...result }).trim()
      if (value !== '') result[name] = value
    }
    results.push(result)
  }
  return results
}

export function mapList(document, rule, fields, variables = {}) {
  return selectAll(document, rule).map(item => {
    const child = childDocument(document, item)
    const result = {}
    for (const [name, fieldRule] of Object.entries(fields)) {
      if (typeof fieldRule === 'string' && fieldRule.includes('{{')) continue
      const value = extractOne(child, fieldRule)
      if (value !== undefined && value !== '') result[name] = value
    }
    for (const [name, fieldRule] of Object.entries(fields)) {
      if (typeof fieldRule !== 'string' || !fieldRule.includes('{{')) continue
      const value = renderValue(fieldRule, { ...variables, ...result }).trim()
      if (value !== '') result[name] = value
    }
    return result
  })
}

export function absoluteUrl(value, base) {
  if (!value) return undefined
  try {
    return new URL(value, base).href
  } catch {
    throw new ReaderError('reader/invalid-url', `Invalid relative URL ${value}.`)
  }
}

export async function requestConfig(rule, variables, fallbackUrl, options = {}) {
  const normalized = normalizeRequest(rule)
  const template = normalized.url ?? fallbackUrl
  if (!template) throw new ReaderError('reader/invalid-source', 'This rule has no request URL.')
  const headerEntries = Object.entries(normalized.headers ?? {})
  const contentType = headerEntries.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  const rawBody = normalized.body === undefined ? undefined : String(normalized.body)
  const jsonBody = rawBody !== undefined && (/application\/json/i.test(String(contentType)) || /^\s*[[{]/.test(rawBody))
  return {
    url: absoluteUrl(await renderTemplateAsync(template, variables, options), variables.sourceUrl),
    method: normalized.method ?? 'GET',
    body: jsonBody ? renderJsonBody(rawBody, variables) : undefined,
    form: rawBody === undefined || jsonBody ? undefined : await renderTemplateAsync(rawBody, variables, options),
    jsonBody,
    headers: normalized.headers,
    charset: normalized.charset,
  }
}

export function ruleField(rule, ...names) {
  for (const name of names) if (rule?.[name] !== undefined) return rule[name]
  return undefined
}

export function nextPageRule(rule) {
  return ruleField(rule, 'nextPage', 'nextPageUrl')
}

export function knownRequestKeys(rule) {
  return REQUEST_KEYS.filter(key => rule?.[key] !== undefined)
}

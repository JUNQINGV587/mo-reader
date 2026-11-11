import * as cheerio from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import { ReaderError } from './errors.js'
import { runSourceScript } from './source-script.js'
import { cleanHeaders, parseRemoteUrl } from './http.js'
import { requiredString, stableId } from './utils.js'

const SECRET_KEY = /^(?:.*(?:password|passwd|credential|secret|cookie|authorization).*|(?:access|refresh|id|auth|session|api|client)?[-_]?token|api[-_]?key|auth|session)$/i
const JS_RULE = /<\s*js\b|@js\b|@java\b|<\s*java\b|\brhino\b|\bwebview\b|\beval\s*\(|javascript:/i
const WEBVIEW_RULE = /\bwebview\b|<\s*webview/i
const XPATH_RULE = /^@?xpath\s*:/i
const REQUEST_KEYS = ['url', 'method', 'body', 'headers', 'charset', 'nextPage']
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

export function assertBasicRules(value) {
  walkRules(value, (rule, path) => {
    if (WEBVIEW_RULE.test(rule)) throw new ReaderError('reader/unsupported-source', `${path}: 该书源需要 WebView，暂不支持。`)
    // JS 规则交由 source-script 的隔离 Worker 执行，这里只拒绝 WebView。
    if (JS_RULE.test(rule)) return
  })
}

// 检测规则是否是 JS 脚本（@js: 或 <js>）
export function isJsRule(value) {
  if (Array.isArray(value)) return value.some(isJsRule)
  return typeof value === 'string' && JS_RULE.test(value)
}

// 从规则字符串提取 JS 代码
export function extractJsCode(value) {
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new ReaderError('reader/unsupported-rule', 'JS 规则数组只能包含一个脚本。')
    return extractJsCode(value[0])
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (WEBVIEW_RULE.test(text)) throw new ReaderError('reader/unsupported-source', '该书源需要 WebView，暂不支持。')
  // @js:code 或 <js>code</js>
  const atMatch = text.match(/^@js\s*:\s*([\s\S]+)$/i)
  if (atMatch) return atMatch[1]
  const tagMatch = text.match(/^<js[^>]*>([\s\S]*)<\/js>$/i)
  if (tagMatch) return tagMatch[1]
  if (JS_RULE.test(text)) return text
  return null
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
  if (isJsRule(rule)) return runSourceScript(extractJsCode(rule), { document, ...options })
  return extractOne(document, rule)
}

export function extractOne(document, rule) {
  if (rule === undefined || rule === null || rule === '') return undefined
  if (Array.isArray(rule)) rule = rule[0]
  if (typeof rule !== 'string') {
    if (typeof rule === 'number' || typeof rule === 'boolean') return String(rule)
    throw new ReaderError('reader/unsupported-rule', 'Field rules must be strings.')
  }
  if (isJsRule(rule)) throw new ReaderError('reader/unsupported-rule', 'JS 规则必须通过 SourceEngine 异步执行。')
  const textRule = parseTextRule(rule)
  const base = textRule ? rule.slice(0, rule.indexOf('##')) : rule
  if (document.kind === 'json' || /^@Json\s*:/i.test(base) || base.trim().startsWith('$')) {
    const value = jsonValues(document, base)[0]
    if (value === undefined || value === null) return undefined
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return textRule ? applyTextRule(text, textRule) : text
  }
  const extracted = (XPATH_RULE.test(base) || /^\s*\.?\//.test(base) ? xpathValues(document, base) : cssValues(document, base))[0]
  return textRule && extracted !== undefined ? applyTextRule(extracted, textRule) : extracted
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
      const value = await extractOneAsync(child, fieldRule, options)
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

export function requestConfig(rule, variables, fallbackUrl) {
  const normalized = normalizeRequest(rule)
  const template = normalized.url ?? fallbackUrl
  if (!template) throw new ReaderError('reader/invalid-source', 'This rule has no request URL.')
  const headerEntries = Object.entries(normalized.headers ?? {})
  const contentType = headerEntries.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? ''
  const rawBody = normalized.body === undefined ? undefined : String(normalized.body)
  const jsonBody = rawBody !== undefined && (/application\/json/i.test(String(contentType)) || /^\s*[[{]/.test(rawBody))
  return {
    url: absoluteUrl(renderTemplate(template, variables), variables.sourceUrl),
    method: normalized.method ?? 'GET',
    body: jsonBody ? renderJsonBody(rawBody, variables) : undefined,
    form: rawBody === undefined || jsonBody ? undefined : renderTemplate(rawBody, variables),
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

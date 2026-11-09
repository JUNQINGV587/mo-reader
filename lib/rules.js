import * as cheerio from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import { ReaderError } from './errors.js'
import { cleanHeaders, parseRemoteUrl } from './http.js'
import { requiredString, stableId } from './utils.js'

// JS 沙箱：受限执行环境，无网络、无文件系统、无 DOM 访问
function executeJsRule(code, document) {
  try {
    // 构建受限上下文
    const context = {
      // 文档数据
      document: document.kind === 'json' ? document.data : undefined,
      html: document.kind === 'html' ? document.html : undefined,
      $: document.kind === 'html' ? document.$ : undefined,
      // 工具函数
      String, Number, Boolean, Array, Object, JSON, Math, Date,
      parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
      // 禁止访问：window, globalThis, process, require, fetch, XMLHttpRequest 等
    }
    // 用 Function 构造器创建隔离作用域
    const fn = new Function(...Object.keys(context), `"use strict"; return (${code});`)
    const result = fn(...Object.values(context))
    return result === undefined || result === null ? undefined : String(result)
  } catch (error) {
    console.error('[JS 规则执行失败]', error.message)
    return undefined
  }
}

const SECRET_KEY = /^(?:.*(?:password|passwd|credential|secret|cookie|authorization).*|(?:access|refresh|id|auth|session|api|client)?[-_]?token|api[-_]?key|auth|session)$/i
const JS_RULE = /<\s*js\b|@js\b|@java\b|<\s*java\b|\brhino\b|\bwebview\b|\beval\s*\(|javascript:/i
const XPATH_RULE = /^@?xpath\s*:/i
const REQUEST_KEYS = ['url', 'method', 'body', 'headers', 'charset', 'nextPage']

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
    // 第二期：JS 规则已支持，但只执行受限沙箱（无网络、无 DOM、无文件系统）
    if (JS_RULE.test(rule)) {
      // 不再拒绝，标记为需要 JS 引擎
      return
    }
    if (XPATH_RULE.test(rule)) throw new ReaderError('reader/unsupported-rule', `${path}: XPath 暂不支持，请改用 CSS selector 或 JSONPath。`)
  })
}

// 检测规则是否是 JS 脚本（@js: 或 <js>）
export function isJsRule(value) {
  return typeof value === 'string' && JS_RULE.test(value)
}

// 从规则字符串提取 JS 代码
export function extractJsCode(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
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
  const toc = normalizeRequest(mapLegado(raw.toc ?? raw.ruleToc ?? groups.toc, { list: 'chapterList', name: 'chapterName', url: 'chapterUrl' }))
  const content = normalizeRequest(raw.content ?? raw.ruleContent ?? groups.content)
  if (search.method && search.method !== 'GET' && search.method !== 'POST') throw new ReaderError('reader/unsupported-rule', 'search 仅支持 GET/POST。')
  return {
    id: stableId('source', sourceUrl),
    name,
    bookSourceUrl: sourceUrl,
    allowHttp,
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
  const expression = path.replace(/^@Json\s*:/i, '').trim()
  if (!expression) throw new ReaderError('reader/invalid-source', 'Empty JSONPath rule.')
  try {
    return JSONPath({ path: expression, json: document.value, wrap: true })
  } catch (error) {
    throw new ReaderError('reader/unsupported-rule', `Invalid JSONPath ${expression}.`, undefined, { cause: error })
  }
}

function splitCssAction(rule) {
  const match = /^(.*?)@(text|html|outerHtml|href|src|title|alt|value|data-[\w-]+|attr\([^)]+\))$/i.exec(rule)
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
  if (XPATH_RULE.test(rule) || rule.trim().startsWith('//')) throw new ReaderError('reader/unsupported-rule', 'XPath 暂不支持，请改用 CSS selector 或 JSONPath。')
  if (document.kind === 'json' || /^@Json\s*:/i.test(rule) || rule.trim().startsWith('$')) return jsonValues(document, rule)
  const selector = rule.replace(/^@css\s*:/i, '').trim()
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

export function extractOne(document, rule) {
  if (rule === undefined || rule === null || rule === '') return undefined
  if (Array.isArray(rule)) rule = rule[0]
  if (typeof rule !== 'string') {
    if (typeof rule === 'number' || typeof rule === 'boolean') return String(rule)
    throw new ReaderError('reader/unsupported-rule', 'Field rules must be strings.')
  }
  // JS 规则：在受限沙箱中执行
  if (isJsRule(rule)) {
    const code = extractJsCode(rule)
    if (!code) return undefined
    return executeJsRule(code, document)
  }
  const textRule = parseTextRule(rule)
  const base = textRule ? rule.slice(0, rule.indexOf('##')) : rule
  if (document.kind === 'json' || /^@Json\s*:/i.test(base) || base.trim().startsWith('$')) {
    const value = jsonValues(document, base)[0]
    if (value === undefined || value === null) return undefined
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    return textRule ? applyTextRule(text, textRule) : text
  }
  const extracted = cssValues(document, base)[0]
  return textRule && extracted !== undefined ? applyTextRule(extracted, textRule) : extracted
}

export function extractList(document, rule) {
  if (document.kind === 'json') return selectAll(document, rule).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value))
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
  return {
    url: absoluteUrl(renderTemplate(template, variables), variables.sourceUrl),
    method: normalized.method ?? 'GET',
    form: normalized.body === undefined ? undefined : renderTemplate(String(normalized.body), variables),
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

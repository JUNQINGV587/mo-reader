/**
 * 「发现」（书源 exploreUrl）解析：
 * - 按行拆分；`名称::地址` 或裸地址；忽略空行
 * - 相对地址按书源地址补全；`{{page}}` 等占位符原样保留，交给请求阶段替换
 * - `@js:` 行返回数组（字符串或 `{name,url}`）或换行分隔字符串
 * - 单行/单个分类失败只跳过该行，不影响其余分类
 *
 * 同时提供发现页书目的解析（ruleExplore），返回与搜索一致的书目形状，
 * 让 UI 能直接复用 `openBook(book)`。
 */
import { AnalyzeRule } from '../rules/analyze-rule.js'
import { evalJs } from '../rules/js.js'
import type { BookSource } from '../model/source.js'
import { htmlToText, type SearchBook } from './analyze.js'

export interface ExploreCategory {
  name: string
  url: string
}

export interface ExploreScriptEnv {
  baseUrl: string
  source?: BookSource
}

export interface ExploreParseOptions {
  source?: BookSource
  /** 注入 @js 执行器，便于测试纯解析逻辑；默认执行书源 JS。 */
  evalScript?: (script: string, env: ExploreScriptEnv) => unknown
}

/** 裸地址（带协议）不按 `::` 拆名，避免把 IPv6 主机误当分类名。 */
const BARE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
/** 读取分类名时不会展开的占位符，先遮住再交给 URL 解析。 */
const PLACEHOLDER = /\{\{[^{}]*\}\}/g
const MASK = /__MO_PH_(\d+)__/g

/**
 * 解析书源的 exploreUrl 为分类列表。
 * 解析器本身不抛错：损坏的行被跳过，其他行照常返回。
 */
export function parseExploreCategories(
  raw: string | undefined,
  baseUrl: string,
  options: ExploreParseOptions = {},
): ExploreCategory[] {
  const text = typeof raw === 'string' ? raw : ''
  if (!text.trim()) return []

  const categories: ExploreCategory[] = []
  const evalScript = options.evalScript ?? defaultExploreScript
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      if (/^@js:/i.test(trimmed)) {
        const value = evalScript(trimmed.slice(4), { baseUrl, source: options.source })
        collectScriptResult(value, baseUrl, categories)
      } else {
        addCategory(trimmed, baseUrl, categories)
      }
    } catch {
      // 单行失败只影响该分类。
    }
  }
  return categories
}

/** 解析 ruleExplore 返回的一页书目，形状与 analyzeSearch 一致。 */
export function analyzeExplore(
  content: unknown,
  source: BookSource,
  baseUrl = source.bookSourceUrl,
): SearchBook[] {
  const rule = source.ruleExplore ?? {}
  const bookList = rule.bookList ?? ''
  if (!bookList) return []

  const listRule = new AnalyzeRule(content, { baseUrl, source })
  const elements = listRule.getElements(bookList)
  const books: SearchBook[] = []

  for (const element of elements) {
    const item = new AnalyzeRule(element, { baseUrl, source })
    const name = clean(item.getString(rule.name ?? ''))
    const bookUrl = toAbsolute(item.getString(rule.bookUrl ?? ''), baseUrl)
    if (!name || !bookUrl) continue

    books.push({
      name,
      author: clean(item.getString(rule.author ?? '')),
      kind: clean(item.getString(rule.kind ?? '')),
      wordCount: clean(item.getString((rule as Record<string, unknown>).wordCount as string | undefined ?? '')),
      lastChapter: clean(item.getString((rule as Record<string, unknown>).lastChapter as string | undefined ?? '')),
      intro: htmlToText(item.getString(rule.intro ?? '')),
      coverUrl: toAbsolute(item.getString(rule.coverUrl ?? ''), baseUrl),
      bookUrl,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName,
      type: source.bookSourceType ?? 0,
    })
  }
  return books
}

function defaultExploreScript(script: string, env: ExploreScriptEnv): unknown {
  return evalJs(script, {
    baseUrl: env.baseUrl,
    source: env.source,
    page: 1,
  })
}

/** 把一行 `名称::地址` 或裸地址解析成分类；非法地址跳过。 */
function addCategory(line: string, baseUrl: string, categories: ExploreCategory[]): void {
  const schemeStart = BARE_URL.test(line)
  const separator = schemeStart ? -1 : line.indexOf('::')
  let name = ''
  let urlRule = line
  if (separator >= 0) {
    name = line.slice(0, separator).trim()
    urlRule = line.slice(separator + 2).trim()
  }

  const url = resolveCategoryUrl(urlRule, baseUrl)
  if (!url) return
  categories.push({ name: name || url, url })
}

/** @js 的返回值可能是数组、换行字符串或单个对象，统一展开成分类。 */
function collectScriptResult(
  value: unknown,
  baseUrl: string,
  categories: ExploreCategory[],
): void {
  if (value == null) return
  if (typeof value === 'string') {
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) addCategory(trimmed, baseUrl, categories)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectScriptResult(item, baseUrl, categories)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const url =
    typeof record.url === 'string'
      ? record.url
      : typeof record.href === 'string'
        ? record.href
        : ''
  if (!url.trim()) return
  const resolved = resolveCategoryUrl(url, baseUrl)
  if (resolved) categories.push({ name: name.trim() || resolved, url: resolved })
}

/** 相对地址按书源地址补全；`{{page}}` 等占位符保持原样。 */
function resolveCategoryUrl(urlRule: string, baseUrl: string): string {
  const raw = urlRule.trim()
  if (!raw) return ''

  const placeholders: string[] = []
  const masked = raw.replace(PLACEHOLDER, (match) => {
    placeholders.push(match)
    return `__MO_PH_${placeholders.length - 1}__`
  })

  let resolved: string
  try {
    resolved = new URL(masked, baseUrl || undefined).toString()
  } catch {
    return ''
  }
  // 占位符被遮住时 URL 会先百分号编码；还原后再确认协议。
  resolved = resolved.replace(MASK, (_match, index: string) => placeholders[Number(index)] ?? '')
  if (!/^https?:\/\//i.test(resolved)) return ''
  return resolved
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function toAbsolute(value: string, baseUrl: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  try {
    return new URL(trimmed, baseUrl || undefined).toString()
  } catch {
    return trimmed
  }
}

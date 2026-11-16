/**
 * 段评（只读）：移植阅读 ReviewRuleParser.parseSummary 的摘要解析。
 *
 * 书源的 ruleReview.enabled 为真且配置了 summary 规则时：
 * - reviewSummaryUrl 请求章节段评摘要（一次请求）
 * - summaryListRule 取列表，summaryParagraphIndexRule 取段落序号
 * - summaryCountRule 取该段评论数，summaryParagraphDataRule 取该段标识数据
 * 本模块只读，不做发帖/点赞/回复。
 */
import type { BookSource } from '../model/source.js'
import { AnalyzeRule } from '../rules/analyze-rule.js'
import { buildRequest, type RequestSpec } from './url.js'

export interface ReviewRule {
  enabled?: boolean
  reviewSummaryUrl?: string
  summaryListRule?: string
  summaryParagraphIndexRule?: string
  summaryParagraphDataRule?: string
  summaryCountRule?: string
}

export interface ReviewBookLike {
  bookUrl?: string
  name?: string
  author?: string
}

export interface ReviewChapterLike {
  url?: string
  title?: string
  index?: number
}

export interface ReviewSummary {
  counts: Record<number, number>
  keys: Record<number, string>
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][\w]*)\s*\}\}/g

function substitute(template: string, source: BookSource, book: ReviewBookLike, chapter: ReviewChapterLike): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    switch (key) {
      case 'bookUrl':
        return book.bookUrl ?? ''
      case 'bookName':
        return book.name ?? ''
      case 'bookAuthor':
        return book.author ?? ''
      case 'chapterUrl':
        return chapter.url ?? ''
      case 'chapterTitle':
        return chapter.title ?? ''
      case 'chapterIndex':
        return String(chapter.index ?? 0)
      case 'sourceUrl':
      case 'baseUrl':
        return source.bookSourceUrl ?? ''
      default:
        return whole
    }
  })
}

export function reviewRule(source: BookSource): ReviewRule | null {
  const rule = (source as unknown as { ruleReview?: ReviewRule }).ruleReview
  if (!rule || typeof rule !== 'object') return null
  if (!rule.enabled) return null
  return rule
}

export function buildReviewSummaryRequest(
  rule: ReviewRule,
  source: BookSource,
  book: ReviewBookLike,
  chapter: ReviewChapterLike,
): RequestSpec | null {
  const template = (rule.reviewSummaryUrl ?? '').trim()
  if (!template) return null
  return buildRequest(substitute(template, source, book, chapter), {
    baseUrl: source.bookSourceUrl,
    source,
    book,
    chapter,
  })
}

function parseIntOrNull(value: string): number | null {
  const match = /\d+/.exec(value)
  if (!match) return null
  const number = Number.parseInt(match[0], 10)
  return Number.isFinite(number) ? number : null
}

export function parseReviewSummary(
  body: string,
  rule: ReviewRule,
  source: BookSource,
  book: ReviewBookLike,
  chapter: ReviewChapterLike,
  baseUrl: string,
): ReviewSummary | null {
  const listRule = (rule.summaryListRule ?? '').trim()
  const indexRule = (rule.summaryParagraphIndexRule ?? '').trim()
  if (!body || !listRule || !indexRule) return null

  const analyzer = new AnalyzeRule(body, { baseUrl, book, chapter, source })
  const items = analyzer.getElements(listRule) ?? []
  const counts: Record<number, number> = {}
  const keys: Record<number, string> = {}
  if (items.length === 0) return { counts, keys }

  const countRule = (rule.summaryCountRule ?? '').trim()
  const dataRule = (rule.summaryParagraphDataRule ?? '').trim()
  items.forEach((item, position) => {
    const itemRule = new AnalyzeRule(item, { baseUrl, book, chapter, source })
    const indexText = itemRule.getString(indexRule)
    const paragraphIndex = parseIntOrNull(indexText) ?? position + 1
    if (paragraphIndex === 0) return
    const count = countRule ? (parseIntOrNull(itemRule.getString(countRule)) ?? 0) : 0
    const data = dataRule ? itemRule.getString(dataRule) : ''
    if (count > 0) {
      counts[paragraphIndex] = count
      keys[paragraphIndex] = data || indexText || String(paragraphIndex)
    }
  })
  return { counts, keys }
}

export function summaryIsConfigured(rule: ReviewRule): boolean {
  return Boolean(
    rule.enabled &&
      (rule.reviewSummaryUrl ?? '').trim() &&
      (rule.summaryListRule ?? '').trim() &&
      (rule.summaryParagraphIndexRule ?? '').trim(),
  )
}

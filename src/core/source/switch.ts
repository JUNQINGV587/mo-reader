/**
 * 换源的纯逻辑：书名/作者规范化比较、候选匹配度、旧进度到新目录的映射。
 * 网络与存储都在 ReaderService，这里只做可独立测试的判断。
 */
import type { TocChapter } from './analyze.js'

export type NameMatch = 'exact' | 'contains' | 'none'

/** 去掉空白与常见中英文标点，便于判断两个书名/作者是否指向同一对象。 */
const STRIP = /[\s\u3000·・_.,，。、；;：:!！?？'"“”‘’()（）\[\]【】《》〈〉<>…~～\/\\|+\-—–]/g

export function normalizeComparable(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(STRIP, '')
}

/** 书名匹配度：规范化后相同、互相包含，或明显无关。 */
export function matchBookName(current: unknown, target: unknown): NameMatch {
  const left = normalizeComparable(current)
  const right = normalizeComparable(target)
  if (!left || !right) return 'none'
  if (left === right) return 'exact'
  if (left.includes(right) || right.includes(left)) return 'contains'
  return 'none'
}

/** 书名相同或互相包含时视为同一本；任一为空则无法确认。 */
export function bookNamesRelated(current: unknown, target: unknown): boolean {
  return matchBookName(current, target) !== 'none'
}

/** 作者规范化后完全相同才算同作者（空作者不算）。 */
export function sameAuthorName(current: unknown, target: unknown): boolean {
  const left = normalizeComparable(current)
  const right = normalizeComparable(target)
  return Boolean(left) && left === right
}

export interface SwitchProgressInput {
  chapterIndex?: unknown
  chapterTitle?: unknown
  position?: unknown
}

export interface MappedSwitchProgress {
  chapterIndex: number
  chapterTitle: string
  chapterUrl: string
  position: number
  /** title：按旧章节标题命中；index：按旧索引夹取。 */
  matched: 'title' | 'index'
}

function readableChapters(chapters: TocChapter[]): Array<{ chapter: TocChapter; index: number }> {
  return chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => Boolean(chapter) && !chapter.isVolume && String(chapter.url ?? '').trim())
}

function safePosition(value: unknown): number {
  const position = Number(value ?? 0)
  return Number.isFinite(position) && position > 0 ? Math.floor(position) : 0
}

/**
 * 把旧进度映射到新目录：
 * 1. 旧章节标题在新目录里精确命中 → 保留旧页号（同一章的内容通常还能对上，越界由阅读器兜底）；
 * 2. 标题失配 → 旧索引夹取到新目录范围内，页号归零（章节内容已变，旧页号视为越界）。
 * 目录里没有可读章节时返回 null。
 */
export function mapSwitchProgress(
  chapters: TocChapter[] | null | undefined,
  old: SwitchProgressInput | null | undefined,
): MappedSwitchProgress | null {
  const list = Array.isArray(chapters) ? chapters : []
  const readable = readableChapters(list)
  if (readable.length === 0) return null

  const title = String(old?.chapterTitle ?? '').trim()
  if (title) {
    const hit = readable.find(({ chapter }) => String(chapter.title ?? '').trim() === title)
    if (hit) {
      return {
        chapterIndex: hit.index,
        chapterTitle: hit.chapter.title,
        chapterUrl: hit.chapter.url,
        position: safePosition(old?.position),
        matched: 'title',
      }
    }
  }

  const requested = Number(old?.chapterIndex ?? 0)
  const clamped = Number.isFinite(requested)
    ? Math.min(Math.max(0, Math.trunc(requested)), list.length - 1)
    : 0
  const hit = readable.find(({ index }) => index >= clamped) ?? readable[readable.length - 1]!
  return {
    chapterIndex: hit.index,
    chapterTitle: hit.chapter.title,
    chapterUrl: hit.chapter.url,
    position: 0,
    matched: 'index',
  }
}

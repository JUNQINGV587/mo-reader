/**
 * 正文命中测试：把画布上的指针位置换算成行、字符，再扩展成词。
 *
 * 纯函数，测量函数由调用方注入（阅读器传 canvas.measureText，测试传固定字宽）。
 * 坐标口径与 CanvasReader 的绘制一致：
 * - 第 index 行的行顶 = top + index * lineHeight；
 * - 行内文字从 left 开始绘制，缩进已经算在行文本里，按实际测量宽度定位。
 *
 * 回退规则（拿不到词时保证仍有可查询的文本）：
 * - y 超出正文：夹到第一行 / 最后一行；
 * - 指针落在段间空行：取最近的非空行（先向上、再向下）；
 * - x 越界、行内只有标点等情况：返回整行去掉缩进和首尾空白的文本，fallback = true；
 * - 整页没有可读文本：返回 null。
 */

/** 与 paginate.ts 的缩进、换行口径保持一致的全角空白与 CJK 范围。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const WORD_CHAR = /[\p{L}\p{N}]/u
/** 拉丁词内部的连接符：Don't、hello-world。 */
const CONNECTOR = /['’-]/

const isCjkChar = (char: string | undefined): boolean => !!char && CJK.test(char)
const isWordChar = (char: string | undefined): boolean => !!char && WORD_CHAR.test(char)
const isConnector = (char: string | undefined): boolean => !!char && CONNECTOR.test(char)
/** 拉丁词扩展只在本脚本内进行，避免把紧邻的“你好world”并成一个词。 */
const isLatinExpandable = (char: string | undefined): boolean =>
  (isWordChar(char) && !isCjkChar(char)) || isConnector(char)

export interface TextHitLayout {
  /** 行内文字的起始 x（阅读器的 padding.left）。 */
  left: number
  /** 第一行文字的顶部 y。 */
  top: number
  /** 行高（px）。 */
  lineHeight: number
  /** 测量一段文本的绘制宽度。 */
  measure: (text: string) => number
}

export interface WordRange {
  word: string
  /** 词在行内的起始下标（含）。 */
  start: number
  /** 词在行内的结束下标（不含）。 */
  end: number
  /** true 表示没有定位到词，word 是整行回退文本。 */
  fallback: boolean
}

export interface TextHit extends WordRange {
  lineIndex: number
  line: string
  /** 指针所在的字符下标；x 越界时为 -1。 */
  charIndex: number
}

/** 整行回退：去掉段首缩进与首尾空白，保留中间的原文。 */
function fallbackWord(line: string): WordRange {
  const start = line.search(/\S/)
  if (start < 0) return { word: '', start: 0, end: 0, fallback: true }
  let end = line.length
  while (end > start && /\s/.test(line[end - 1])) end -= 1
  return { word: line.slice(start, end), start, end, fallback: true }
}

/**
 * 把行内字符下标扩展成词。
 *
 * CJK 连续段直到标点/空白为止；拉丁词允许字母、数字与内部连接符，
 * 两端连接符（如句末的连字符）会被裁掉。指针落在空白或标点上时先看左边、
 * 再看右边，取最近的词。
 */
export function wordAt(line: string, charIndex: number): WordRange {
  if (!line || charIndex < 0 || charIndex >= line.length) return fallbackWord(line)

  let probe = charIndex
  if (!isWordChar(line[probe])) {
    for (let index = charIndex - 1; index >= 0; index -= 1) {
      if (isWordChar(line[index])) {
        probe = index
        break
      }
    }
    if (probe === charIndex) {
      for (let index = charIndex + 1; index < line.length; index += 1) {
        if (isWordChar(line[index])) {
          probe = index
          break
        }
      }
    }
    // 前后都没有文字（例如只有标点或缩进）→ 回退整行。
    if (probe === charIndex && !isWordChar(line[probe])) return fallbackWord(line)
  }

  let start = probe
  let end = probe + 1
  if (isCjkChar(line[probe])) {
    while (start > 0 && isCjkChar(line[start - 1])) start -= 1
    while (end < line.length && isCjkChar(line[end])) end += 1
  } else {
    while (start > 0 && isLatinExpandable(line[start - 1])) start -= 1
    while (end < line.length && isLatinExpandable(line[end])) end += 1
  }
  while (start < end && isConnector(line[start])) start += 1
  while (end > start && isConnector(line[end - 1])) end -= 1
  if (start >= end) return fallbackWord(line)
  return { word: line.slice(start, end), start, end, fallback: false }
}

/** 指针落点所在行（空行取最近的非空行）；没有可读行返回 -1。 */
function nearestReadableLine(lines: readonly string[], index: number): number {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    if (lines[cursor]?.trim()) return cursor
  }
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (lines[cursor]?.trim()) return cursor
  }
  return -1
}

/**
 * 把画布坐标换算成「行 + 字符 + 词」。
 *
 * lines 是当前页的渲染行（与 paginate 输出一致，段间空行为 ''）；
 * point 是画布内坐标（已按 CSS 尺寸与位图尺寸的比例归一）。
 */
export function hitTest(
  lines: readonly string[],
  point: { x: number; y: number },
  layout: TextHitLayout,
): TextHit | null {
  if (lines.length === 0 || !(layout.lineHeight > 0)) return null

  const rawLine = Math.floor((point.y - layout.top) / layout.lineHeight)
  let lineIndex = Math.max(0, Math.min(lines.length - 1, rawLine))
  if (!lines[lineIndex]?.trim()) {
    lineIndex = nearestReadableLine(lines, lineIndex)
    if (lineIndex < 0) return null
  }

  const line = lines[lineIndex]
  const dx = point.x - layout.left
  const width = layout.measure(line)
  const outOfRange = dx < 0 || !(width > 0) || dx >= width

  let charIndex = -1
  if (!outOfRange) {
    for (let index = 0; index < line.length; index += 1) {
      // 用前缀宽度定位字符起点：measure 可以包含字距调整。
      if (dx < layout.measure(line.slice(0, index + 1))) {
        charIndex = index
        break
      }
    }
  }

  const word = wordAt(line, charIndex)
  return { ...word, lineIndex, line, charIndex }
}

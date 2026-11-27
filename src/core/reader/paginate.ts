/**
 * 正文分页：按测量宽度折行、按行高切页。纯函数，测量函数由调用方注入
 * （浏览器用 canvas.measureText，测试用固定字宽）。
 *
 * 除了旧版 pages/lines 结果，还额外给出带字符偏移的 layout：每页分栏，
 * 每行记录 startOffset/endOffset，重排后可凭偏移找回原位置。
 */
export type PaginateTextAlign = 'left' | 'justify'

export type PaginateDualColumnDisabledReason = 'narrow' | 'scroll'

export interface PaginateOptions {
  width: number
  height: number
  fontSize: number
  lineHeight: number
  padding?: number
  headerHeight?: number
  footerHeight?: number
  /** 段首缩进两个全角空格（默认开） */
  indent?: boolean
  /** 段距（px） */
  paragraphSpacing?: number
  measure: (text: string) => number
  /** 字距（px），加在相邻两个字之间 */
  letterSpacing?: number
  /** 章节标题；为空时不显示标题。正文已经以标题开头时不会重复插入 */
  title?: string
  /** 0 左对齐、1 居中、2 隐藏、3 右对齐 */
  titleMode?: number
  /** 标题字号增量：标题字号 = fontSize + titleSize * 2 */
  titleSize?: number
  /** 两端对齐只作用于段落的非末行 */
  align?: PaginateTextAlign
  /** 标点压缩：相邻两个标点各让出半个字宽 */
  compressPunctuation?: boolean
  /** 避头尾：行首不出现收尾标点，行尾不出现起首标点 */
  kinsoku?: boolean
  dualColumn?: boolean
  /** 双栏栏距（px），默认 24 */
  columnGap?: number
  /** 滚动模式只允许单栏 */
  scrollMode?: boolean
  /** 标题测量函数；缺省复用 measure */
  measureTitle?: (text: string) => number
}

export interface PaginateLine {
  /** 画在纸面上的文本（首行含两个全角空格缩进） */
  text: string
  /** 原文起始偏移（UTF-16，含）；标题行与空行为 -1 */
  start: number
  /** 原文结束偏移（UTF-16，不含）；标题行与空行为 -1 */
  end: number
  firstOfParagraph: boolean
  lastOfParagraph: boolean
  title: boolean
  /** 行首缩进的字符数（缩进是合成出来的，不属于原文偏移） */
  indentChars: number
  /** 行前的段间距（px）；栏/页首行会塌陷为 0 */
  gapBefore: number
  /** 两端对齐时每个字间补的像素；0 表示左对齐 */
  justifyPx: number
  fontSize: number
  /** 整行宽度（含缩进、不含两端对齐的额外补白） */
  width: number
  /** 相对栏（正文区）顶部的 y 偏移 */
  top: number
}

export interface PaginateColumn {
  lines: PaginateLine[]
  /** 本栏第一行的起始偏移；空栏为 -1 */
  start: number
  /** 本栏最后一行的结束偏移；空栏为 -1 */
  end: number
  /** 相对正文区左边的 x 偏移 */
  x: number
  width: number
}

export interface PaginatePage {
  /** 跨全宽显示的标题行，只在第一页 */
  titleLines: PaginateLine[]
  columns: PaginateColumn[]
  /** 本页正文的起始偏移；纯标题页为 -1 */
  start: number
  /** 本页正文的结束偏移；纯标题页为 -1 */
  end: number
}

export interface PaginateResult {
  pages: string[][]
  lines: string[]
  linesPerPage: number
  layout: PaginatePage[]
  /** 1 或 2；双栏被禁用时仍是 1 */
  columnCount: number
  /** 双栏被禁用的原因：屏幕太窄或滚动模式 */
  dualColumnDisabledReason: PaginateDualColumnDisabledReason | null
  /** 标题对齐方式；不显示标题时为 null */
  titleAlign: 'left' | 'center' | 'right' | null
  /** 规范化后的正文（\r\n -> \n） */
  text: string
}

const INDENT = '　　'
const CLOSING = '。，、；：？！…—～·”’）》」』】〕〉》,.;:!?)]}'
const OPENING = '（《「『【〔〈“‘([{'
const PUNCTUATION = CLOSING + OPENING
const DUAL_COLUMN_MIN_WIDTH = 480
const DEFAULT_COLUMN_GAP = 24
const MAX_JUSTIFY_EM = 0.5
const EPS = 1e-6

function isClosing(char: string): boolean {
  return CLOSING.includes(char)
}

function isOpening(char: string): boolean {
  return OPENING.includes(char)
}

function isPunctuation(char: string): boolean {
  return PUNCTUATION.includes(char)
}

/** 供渲染层判断标点压缩的边界（只给出是否标点）。 */
export function isPunctuationChar(char: string): boolean {
  return isPunctuation(char)
}

interface Item {
  char: string
  width: number
  /** 原文偏移；缩进等合成字符为 -1 */
  offset: number
  /** 该字符在 UTF-16 里的长度 */
  length: number
}

interface RawLine {
  text: string
  start: number
  end: number
  width: number
}

interface WrapOptions {
  content: string
  startOffset: number
  prefix: string
  maxWidth: number
  fontSize: number
  letterSpacing: number
  compress: boolean
  kinsoku: boolean
  charWidth: (char: string) => number
}

function lineWidthOf(items: Item[], letterSpacing: number, compress: boolean, fontSize: number): number {
  let width = 0
  for (let index = 0; index < items.length; index += 1) {
    width += items[index].width
    if (index > 0) {
      width += letterSpacing
      if (compress && isPunctuation(items[index - 1].char) && isPunctuation(items[index].char)) {
        width -= fontSize * 0.5
      }
    }
  }
  return width
}

function rawLineOf(items: Item[], letterSpacing: number, compress: boolean, fontSize: number): RawLine {
  let start = -1
  let end = -1
  for (const item of items) {
    if (item.offset >= 0) {
      start = item.offset
      break
    }
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].offset >= 0) {
      end = items[index].offset + items[index].length
      break
    }
  }
  return {
    text: items.map((item) => item.char).join(''),
    start,
    end,
    width: lineWidthOf(items, letterSpacing, compress, fontSize),
  }
}

/** 按宽度折行；返回未带页面信息的原始行。 */
function wrapItems(options: WrapOptions): RawLine[] {
  const { content, startOffset, prefix, maxWidth, fontSize, letterSpacing, compress, kinsoku, charWidth } = options
  const items: Item[] = []
  for (const char of prefix) {
    items.push({ char, width: charWidth(char), offset: -1, length: 0 })
  }
  let offset = startOffset
  for (const char of content) {
    items.push({ char, width: charWidth(char), offset, length: char.length })
    offset += char.length
  }

  const lines: RawLine[] = []
  let cursor = 0
  while (cursor < items.length) {
    const line: Item[] = []
    let width = 0
    while (cursor < items.length) {
      const item = items[cursor]
      const spacing = line.length > 0 ? letterSpacing : 0
      const compression = line.length > 0 && compress && isPunctuation(line[line.length - 1].char) && isPunctuation(item.char)
        ? fontSize * 0.5
        : 0
      const advance = item.width + spacing - compression
      if (line.length > 0 && width + advance > maxWidth + EPS) {
        // 避头：收尾标点不能落在行首，允许挂在行尾（半个字宽左右）
        if (kinsoku && isClosing(item.char)) {
          line.push(item)
          cursor += 1
          break
        }
        let cut = line.length
        if (kinsoku) {
          // 避尾：起首标点不能落在行尾，整串移到下一行开头
          while (cut > 0 && isOpening(line[cut - 1].char)) cut -= 1
        }
        if (cut < 1) cut = 1
        if (cut >= line.length) break
        lines.push(rawLineOf(line.slice(0, cut), letterSpacing, compress, fontSize))
        const moved = line.slice(cut)
        line.length = 0
        line.push(...moved)
        width = lineWidthOf(line, letterSpacing, compress, fontSize)
        continue
      }
      line.push(item)
      width += advance
      cursor += 1
    }
    if (line.length > 0) {
      lines.push(rawLineOf(line, letterSpacing, compress, fontSize))
    } else if (cursor < items.length) {
      // 兜底：单字宽于整行时也要前进
      lines.push(rawLineOf([items[cursor]], letterSpacing, compress, fontSize))
      cursor += 1
    }
  }
  return lines
}

function buildBodyLines(
  text: string,
  options: Required<Pick<PaginateOptions, 'fontSize' | 'letterSpacing' | 'compressPunctuation' | 'kinsoku' | 'paragraphSpacing' | 'align'>> & { indent: boolean; maxWidth: number; charWidth: (char: string) => number },
): PaginateLine[] {
  const { fontSize, letterSpacing, compressPunctuation, kinsoku, paragraphSpacing, align, indent, maxWidth, charWidth } = options
  const prefix = indent ? INDENT : ''
  const lines: PaginateLine[] = []
  const paragraphs: Array<{ raw: string; start: number }> = []
  let position = 0
  for (const raw of text.split('\n')) {
    paragraphs.push({ raw, start: position })
    position += raw.length + 1
  }
  // 文末换行不产生空白页：去掉结尾的纯空白段
  while (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1]
    if (last.raw.trim() !== '') break
    paragraphs.pop()
  }

  for (const paragraph of paragraphs) {
    const content = paragraph.raw.trim()
    if (!content) {
      const blank: PaginateLine = {
        text: '',
        start: paragraph.start,
        end: paragraph.start,
        firstOfParagraph: true,
        lastOfParagraph: true,
        title: false,
        indentChars: 0,
        gapBefore: 0,
        justifyPx: 0,
        fontSize,
        width: 0,
        top: 0,
      }
      lines.push(blank)
      continue
    }
    const leading = paragraph.raw.length - paragraph.raw.trimStart().length
    const contentStart = paragraph.start + leading
    const rawLines = wrapItems({
      content,
      startOffset: contentStart,
      prefix,
      maxWidth,
      fontSize,
      letterSpacing,
      compress: compressPunctuation,
      kinsoku,
      charWidth,
    })
    const paragraphLines = rawLines.map((rawLine, index): PaginateLine => ({
      text: rawLine.text,
      start: rawLine.start,
      end: rawLine.end,
      firstOfParagraph: index === 0,
      lastOfParagraph: index === rawLines.length - 1,
      title: false,
      indentChars: index === 0 ? prefix.length : 0,
      gapBefore: 0,
      justifyPx: 0,
      fontSize,
      width: rawLine.width,
      top: 0,
    }))
    if (paragraphLines.length > 0) {
      paragraphLines[0].gapBefore = paragraphSpacing
    }
    lines.push(...paragraphLines)
  }

  if (align === 'justify') {
    for (const line of lines) {
      if (line.title || line.lastOfParagraph || line.text === '') {
        line.justifyPx = 0
        continue
      }
      const chars = Array.from(line.text).length
      const contentChars = chars - line.indentChars
      if (contentChars <= 1) {
        line.justifyPx = 0
        continue
      }
      const extra = (maxWidth - line.width) / (contentChars - 1)
      line.justifyPx = extra > 0 && extra <= fontSize * MAX_JUSTIFY_EM ? extra : 0
    }
  }
  return lines
}

function buildTitleLines(
  title: string,
  options: {
    maxWidth: number
    fontSize: number
    titleFontSize: number
    titleLineHeight: number
    letterSpacing: number
    charWidth: (char: string) => number
  },
): PaginateLine[] {
  const { maxWidth, titleFontSize, titleLineHeight, letterSpacing, charWidth } = options
  const rawLines = wrapItems({
    content: title,
    startOffset: 0,
    prefix: '',
    maxWidth,
    fontSize: titleFontSize,
    letterSpacing,
    compress: false,
    kinsoku: false,
    charWidth,
  })
  return rawLines.map((rawLine, index) => ({
    text: rawLine.text,
    start: -1,
    end: -1,
    firstOfParagraph: false,
    lastOfParagraph: false,
    title: true,
    indentChars: 0,
    gapBefore: 0,
    justifyPx: 0,
    fontSize: titleFontSize,
    width: rawLine.width,
    top: index * titleLineHeight,
  }))
}

function titleAlignOf(titleMode: number | undefined): 'left' | 'center' | 'right' | null {
  if (titleMode === 1) return 'center'
  if (titleMode === 2) return null
  if (titleMode === 3) return 'right'
  return 'left'
}

export function paginate(text: string, options: PaginateOptions): PaginateResult {
  const padding = options.padding ?? 24
  const headerHeight = options.headerHeight ?? 36
  const footerHeight = options.footerHeight ?? 28
  const normalized = text.replace(/\r\n?/g, '\n')
  const maxWidth = Math.max(options.fontSize, options.width - padding * 2)
  const maxHeight = Math.max(options.lineHeight, options.height - headerHeight - footerHeight)
  const linesPerPage = Math.max(1, Math.floor(maxHeight / options.lineHeight))
  const fontSize = options.fontSize
  const lineHeight = options.lineHeight
  const letterSpacing = options.letterSpacing ?? 0
  const titleSize = Math.max(0, options.titleSize ?? 0)
  const titleFontSize = fontSize + titleSize * 2
  const titleLineHeight = lineHeight * (titleFontSize / fontSize)
  const paragraphSpacing = Math.max(0, options.paragraphSpacing ?? 0)
  const align: PaginateTextAlign = options.align === 'justify' ? 'justify' : 'left'
  const compressPunctuation = options.compressPunctuation === true
  const kinsoku = options.kinsoku === true
  const indent = options.indent !== false
  const titleMode = options.titleMode ?? 0

  const bodyCache = new Map<string, number>()
  const titleCache = new Map<string, number>()
  const bodyCharWidth = (char: string): number => {
    const cached = bodyCache.get(char)
    if (cached !== undefined) return cached
    const value = options.measure(char)
    bodyCache.set(char, value)
    return value
  }
  const titleMeasure = options.measureTitle ?? options.measure
  const titleCharWidth = (char: string): number => {
    const cached = titleCache.get(char)
    if (cached !== undefined) return cached
    const value = titleMeasure(char)
    titleCache.set(char, value)
    return value
  }

  const requestedDualColumn = options.dualColumn === true
  const scrollMode = options.scrollMode === true
  const dualColumnDisabledReason: PaginateDualColumnDisabledReason | null = requestedDualColumn
    ? scrollMode
      ? 'scroll'
      : maxWidth < DUAL_COLUMN_MIN_WIDTH
        ? 'narrow'
        : null
    : null
  const columnCount = requestedDualColumn && dualColumnDisabledReason === null ? 2 : 1
  const columnGap = Math.max(0, options.columnGap ?? DEFAULT_COLUMN_GAP)
  const columnWidth = columnCount === 2 ? (maxWidth - columnGap) / 2 : maxWidth

  const bodyLines = buildBodyLines(normalized, {
    fontSize,
    letterSpacing,
    compressPunctuation,
    kinsoku,
    paragraphSpacing,
    align,
    indent,
    maxWidth: columnWidth,
    charWidth: bodyCharWidth,
  })

  const rawTitle = (options.title ?? '').trim()
  const titleAlign = rawTitle ? titleAlignOf(titleMode) : null
  const bodyAlreadyStartsWithTitle = rawTitle !== '' && normalized.trimStart().startsWith(rawTitle)
  const shouldShowTitle = rawTitle !== '' && titleAlign !== null && !bodyAlreadyStartsWithTitle
  const titleLines = shouldShowTitle
    ? buildTitleLines(rawTitle, { maxWidth, fontSize, titleFontSize, titleLineHeight, letterSpacing, charWidth: titleCharWidth })
    : []

  if (bodyLines.length === 0 && titleLines.length === 0) {
    bodyLines.push({
      text: '',
      start: 0,
      end: 0,
      firstOfParagraph: true,
      lastOfParagraph: true,
      title: false,
      indentChars: 0,
      gapBefore: 0,
      justifyPx: 0,
      fontSize,
      width: 0,
      top: 0,
    })
  }

  const layout: PaginatePage[] = []
  let bodyIndex = 0
  let pageNo = 0
  while (bodyIndex < bodyLines.length || (pageNo === 0 && titleLines.length > 0)) {
    const isFirstPage = pageNo === 0
    const pageTitleLines = isFirstPage ? titleLines : []
    const titleHeight = pageTitleLines.length * titleLineHeight
    const capacity = Math.max(0, maxHeight - titleHeight)
    const columns: PaginateColumn[] = []
    const canPlaceBody = capacity >= lineHeight - EPS
    if (bodyIndex < bodyLines.length && canPlaceBody) {
      for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const columnLines: PaginateLine[] = []
        let cursorY = 0
        while (bodyIndex < bodyLines.length) {
          const line = bodyLines[bodyIndex]
          const gap = columnLines.length === 0 ? 0 : line.gapBefore
          const next = cursorY + gap + lineHeight
          if (columnLines.length > 0 && next > capacity + EPS) break
          line.gapBefore = gap
          line.top = cursorY + gap
          cursorY = next
          columnLines.push(line)
          bodyIndex += 1
        }
        columns.push({
          lines: columnLines,
          start: columnLines.length > 0 ? columnLines[0].start : -1,
          end: columnLines.length > 0 ? columnLines[columnLines.length - 1].end : -1,
          x: columnIndex * (columnWidth + columnGap),
          width: columnWidth,
        })
        if (bodyIndex >= bodyLines.length) break
      }
    }
    if (columns.length === 0) {
      columns.push({ lines: [], start: -1, end: -1, x: 0, width: columnWidth })
    }
    const firstBody = columns.find((column) => column.lines.length > 0)
    const lastBody = [...columns].reverse().find((column) => column.lines.length > 0)
    layout.push({
      titleLines: pageTitleLines,
      columns,
      start: firstBody ? firstBody.start : -1,
      end: lastBody ? lastBody.end : -1,
    })
    pageNo += 1
    if (bodyIndex >= bodyLines.length) break
  }

  const pages: string[][] = layout.map((page) => {
    const texts = [
      ...page.titleLines.map((line) => line.text),
      ...page.columns.flatMap((column) => column.lines.map((line) => line.text)),
    ]
    return texts.length > 0 ? texts : ['']
  })
  const lines: string[] = [
    ...titleLines.map((line) => line.text),
    ...bodyLines.map((line) => line.text),
  ]

  return {
    pages,
    lines,
    linesPerPage,
    layout,
    columnCount,
    dualColumnDisabledReason,
    titleAlign,
    text: normalized,
  }
}

/** 按字符偏移找回页号：优先包含该偏移的页，找不到取最近的一页（同距取靠后）。 */
export function pageIndexForOffset(layout: PaginatePage[], offset: number): number {
  if (layout.length === 0) return 0
  const safe = Math.max(0, offset)
  for (let index = 0; index < layout.length; index += 1) {
    const page = layout[index]
    if (page.start < 0 || page.end < 0) continue
    if (safe >= page.start && safe < page.end) return index
    if (safe === page.end && index === layout.length - 1) return index
  }
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < layout.length; index += 1) {
    const page = layout[index]
    if (page.start < 0 || page.end < 0) continue
    const distance = safe < page.start ? page.start - safe : safe - page.end
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

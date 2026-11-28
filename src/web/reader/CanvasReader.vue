<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { hitTest } from '../../core/reader/hit-test'
import { createLayoutJob, LayoutCache, layoutCacheKey, type LayoutJob } from '../../core/reader/layout-cache'
import {
  isPunctuationChar,
  paginate,
  pageIndexForOffset,
  punctuationCompressionWidth,
  titleFontSizeOf,
  titleLineHeightOf,
  type PaginateLine,
  type PaginatePage,
  type PaginateResult,
} from '../../core/reader/paginate'
import { pageTurnFrame, resolvePageTurn, turnDurationMs } from '../../core/reader/page-turn'
import { DEFAULT_TAP_ZONES, tapZoneIndex, tipText } from '../../core/reader/reader-config'
import {
  gestureModeFor,
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE,
  resolveReaderGesture,
} from '../../core/reader/swipe-gesture'
import { isDarkColor, type ThemeColors } from '../../core/reader/theme'
import { TurnAnimator } from '../../core/reader/turn-animator'
import type { TurnCancelReason, TurnState } from '../../core/reader/turn-animator'

type Theme = 'light' | 'sepia' | 'dark'
type Turn = 'none' | 'cover' | 'slide' | 'simulate' | 'scroll'
type TextAlign = 'left' | 'justify'

const props = withDefaults(
  defineProps<{
    text: string
    title?: string
    bookName?: string
    fontSize?: number
    fontFamily?: string
    lineHeight?: number
    paragraphSpacing?: number
    indent?: number
    padding?: { left: number; top: number; right: number; bottom: number }
    initialPage?: number
    theme?: Theme
    themeColors?: ThemeColors | null
    animation?: Turn
    headerMode?: number
    footerMode?: number
    showHeaderLine?: boolean
    showFooterLine?: boolean
    tapZones?: number[]
    bookPercent?: number
    batteryPercent?: number | null
    /** 朗读/搜索高亮：原文绝对字符范围（#127 起不再用子串匹配） */
    highlight?: { start: number; end: number } | null
    underlines?: string[]
    /** 字距（px），加在相邻两个字之间 */
    letterSpacing?: number
    bold?: boolean
    /** 0 左对齐、1 居中、2 隐藏、3 右对齐 */
    titleMode?: number
    /** 标题字号增量：标题字号 = fontSize + titleSize * 2 */
    titleSize?: number
    align?: TextAlign
    compressPunctuation?: boolean
    kinsoku?: boolean
    dualColumn?: boolean
    inkMode?: boolean
    /** 设置/目录等面板打开时由宿主关掉键盘翻页，避免按键穿透 */
    keysEnabled?: boolean
  }>(),
  {
    title: '',
    bookName: '',
    fontSize: 22,
    fontFamily: '',
    lineHeight: 1.9,
    paragraphSpacing: 6,
    indent: 2,
    padding: () => ({ left: 22, top: 5, right: 22, bottom: 4 }),
    initialPage: 0,
    theme: 'light',
    themeColors: null,
    animation: 'cover',
    headerMode: 1,
    footerMode: 6,
    showHeaderLine: true,
    showFooterLine: true,
    tapZones: () => DEFAULT_TAP_ZONES,
    bookPercent: 0,
    batteryPercent: null,
    highlight: null,
    underlines: () => [],
    letterSpacing: 0,
    bold: false,
    titleMode: 0,
    titleSize: 0,
    align: 'left',
    compressPunctuation: false,
    kinsoku: false,
    dualColumn: false,
    inkMode: false,
    keysEnabled: true,
  },
)

/** 长按选中的结果：正文文本 + 画布/视口坐标，供查词面板使用。 */
interface ReaderSelection {
  text: string
  line: string
  fallback: boolean
  lineIndex: number
  charIndex: number
  x: number
  y: number
  clientX: number
  clientY: number
}

const emit = defineEmits<{
  page: [payload: { page: number; total: number }]
  tapAction: [code: number]
  select: [selection: ReaderSelection]
  /** 到章边界：交宿主加载相邻章，成功后再 goto，失败留原页 */
  chapterBoundary: [payload: { direction: 1 | -1 }]
  /** 翻页动画开始/结束，自动翻页据此暂停计时 */
  turnState: [animating: boolean]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const result = ref<PaginateResult | null>(null)
const page = ref(0)
const total = computed(() => result.value?.layout.length ?? 1)
const loading = ref(false)
const anchorOffset = ref(-1)

let ctx: CanvasRenderingContext2D | null = null
let observer: ResizeObserver | null = null
let dpr = 1
let width = 0
let height = 0
let animating = false
let animator: TurnAnimator | null = null
let rafId = 0
let turnImages: { before: HTMLCanvasElement; after: HTMLCanvasElement; targetPage: number } | null = null
let motionQuery: MediaQueryList | null = null
const reducedMotion = ref(false)

const layoutCache = new LayoutCache<PaginateResult>(6)
let layoutJob: LayoutJob<PaginateResult> | null = null
let layoutToken = 0
let layoutFrame = 0
let settingsTimer = 0
const SETTINGS_DEBOUNCE_MS = 120

interface PressState {
  pointerId: number
  startX: number
  startY: number
  x: number
  y: number
  /** 按下时刻（performance.now），抬起时算手势时长 */
  startedAt: number
  /** 长按计时器已触发：松手不再判定滑动 */
  longPressed: boolean
  timer: number
}

let press: PressState | null = null
let swallowClick = false

const SERIF = "'Noto Serif SC', 'Songti SC', 'Noto Sans SC', serif"
const ACCENT = '#3d6b53'

const effectiveAnimation = computed<Turn>(() =>
  resolvePageTurn(props.animation, { reducedMotion: reducedMotion.value, inkMode: props.inkMode }),
)

/** 手势模式跟着实际翻页形态走：scroll 纵向过渡，其余形态都按分页翻页。 */
const gestureMode = computed(() => gestureModeFor(effectiveAnimation.value))

const palette = computed<ThemeColors>(() => {
  if (props.inkMode) {
    return { bg: '#ffffff', text: '#000000', muted: '#3f3f3f', line: 'rgba(0,0,0,0.45)' }
  }
  if (props.themeColors) return props.themeColors
  if (props.theme === 'dark') {
    return { bg: '#141518', text: '#d8d4c8', muted: '#8f897b', line: 'rgba(255,255,255,0.14)' }
  }
  if (props.theme === 'sepia') {
    return { bg: '#f1e5c9', text: '#4a3b28', muted: '#8a7657', line: 'rgba(74,59,40,0.2)' }
  }
  return { bg: '#f6f1e7', text: '#2b2a26', muted: '#7c7567', line: 'rgba(43,42,38,0.14)' }
})

const dualHint = computed(() => {
  if (!props.dualColumn) return ''
  const reason = result.value?.dualColumnDisabledReason
  if (reason === 'narrow') return '屏幕太窄，已改为单栏'
  if (reason === 'scroll') return '滚动模式只支持单栏'
  return ''
})

const fontStack = computed(() => (props.fontFamily ? `'${props.fontFamily.replace(/'/g, '')}', ${SERIF}` : SERIF))
const darkTheme = computed(() =>
  props.inkMode ? false : props.themeColors ? isDarkColor(props.themeColors.bg) : props.theme === 'dark',
)

function bodyFont(): string {
  return `${props.bold ? 'bold ' : ''}${props.fontSize}px ${fontStack.value}`
}

function titleFontSize(): number {
  return titleFontSizeOf(props.fontSize, props.titleSize)
}

function titleFont(): string {
  return `${props.bold ? 'bold ' : ''}${titleFontSize()}px ${fontStack.value}`
}

function lineHeightPx(): number {
  return props.fontSize * props.lineHeight
}

function titleLineHeight(): number {
  return titleLineHeightOf(props.fontSize, lineHeightPx(), props.titleSize)
}

function headerHeight(): number {
  return props.headerMode === 0 && !props.showHeaderLine ? 18 : 48
}

function footerHeight(): number {
  return props.footerMode === 0 && !props.showFooterLine ? 18 : 44
}

/** 正文可用区域：页眉页脚横跨全宽，正文左右留白也在这里扣掉。 */
function contentBox() {
  const pad = props.padding
  return {
    left: pad.left,
    top: headerHeight() + pad.top,
    width: Math.max(80, width - pad.left - pad.right),
    height: Math.max(1, height - headerHeight() - footerHeight() - pad.top - pad.bottom),
  }
}

function layoutSettings() {
  return {
    fontSize: props.fontSize,
    fontFamily: props.fontFamily,
    lineHeight: props.lineHeight,
    paragraphSpacing: props.paragraphSpacing,
    indent: props.indent,
    padding: props.padding,
    letterSpacing: props.letterSpacing,
    bold: props.bold,
    title: props.title,
    titleMode: props.titleMode,
    titleSize: props.titleSize,
    align: props.align,
    compressPunctuation: props.compressPunctuation,
    kinsoku: props.kinsoku,
    dualColumn: props.dualColumn,
    animation: effectiveAnimation.value,
  }
}

function applyLayout(next: PaginateResult, keepOffset: boolean) {
  const previousAnchor = anchorOffset.value
  const lastPage = Math.max(0, next.layout.length - 1)
  result.value = next
  if (keepOffset && previousAnchor >= 0) {
    page.value = Math.min(lastPage, pageIndexForOffset(next.layout, previousAnchor))
  } else if (!keepOffset) {
    page.value = Math.min(Math.max(0, props.initialPage), lastPage)
  } else {
    page.value = Math.min(page.value, lastPage)
  }
  syncAnchor()
  render()
}

function layout(keepOffset = true) {
  const canvas = canvasRef.value
  const host = canvas?.parentElement
  if (!canvas || !host || !ctx) return
  cancelTurn('setting')
  const rect = host.getBoundingClientRect()
  if (!rect.width || !rect.height) return

  dpr = Math.min(window.devicePixelRatio || 1, 2)
  width = rect.width
  height = rect.height
  canvas.width = Math.round(rect.width * dpr)
  canvas.height = Math.round(rect.height * dpr)
  canvas.style.width = `${rect.width}px`
  canvas.style.height = `${rect.height}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.font = bodyFont()

  const box = contentBox()
  const key = layoutCacheKey({
    text: props.text,
    settings: layoutSettings(),
    viewport: { width: box.width, height: box.height },
  })

  layoutToken += 1
  const token = layoutToken
  layoutJob?.cancel()
  layoutJob = null
  cancelAnimationFrame(layoutFrame)

  const cached = layoutCache.get(key)
  if (cached) {
    loading.value = false
    applyLayout(cached, keepOffset)
    return
  }

  // 大章节先让加载态画出来，再排版
  loading.value = props.text.length > 15000
  const startLayout = () => {
    if (token !== layoutToken) return
    const job = createLayoutJob(() =>
      paginate(props.text, {
        width: box.width,
        height: box.height,
        fontSize: props.fontSize,
        lineHeight: lineHeightPx(),
        padding: 0,
        headerHeight: 0,
        footerHeight: 0,
        indent: props.indent !== 0,
        paragraphSpacing: props.paragraphSpacing,
        letterSpacing: props.letterSpacing,
        title: props.title,
        titleMode: props.titleMode,
        titleSize: props.titleSize,
        align: props.align,
        compressPunctuation: props.compressPunctuation,
        kinsoku: props.kinsoku,
        dualColumn: props.dualColumn,
        scrollMode: effectiveAnimation.value === 'scroll',
        measure: (value) => {
          if (!ctx) return 0
          ctx.font = bodyFont()
          return ctx.measureText(value).width
        },
        measureTitle: (value) => {
          if (!ctx) return 0
          ctx.font = titleFont()
          return ctx.measureText(value).width
        },
      }),
    )
    layoutJob = job
    job.promise
      .then((next) => {
        if (token !== layoutToken) return
        layoutCache.set(key, next)
        applyLayout(next, keepOffset)
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'LayoutCancelledError') return
        console.error('[reader] 排版失败', error)
      })
      .finally(() => {
        if (token === layoutToken) loading.value = false
      })
  }
  if (loading.value) {
    // 先让「排版中…」画一帧，再跑同步排版
    layoutFrame = requestAnimationFrame(startLayout)
  } else {
    startLayout()
  }
}

function fillBackground() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = palette.value.bg
  ctx.fillRect(0, 0, width, height)
}

function tipContext() {
  return {
    bookName: props.bookName,
    chapterTitle: props.title,
    page: page.value + 1,
    totalPages: total.value,
    bookPercent: props.bookPercent,
    batteryPercent: props.batteryPercent ?? undefined,
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
  }
}

let widthCacheFont = ''
const widthCache = new Map<string, number>()

function charWidth(char: string): number {
  const font = ctx?.font ?? ''
  if (font !== widthCacheFont) {
    widthCacheFont = font
    widthCache.clear()
  }
  const cached = widthCache.get(char)
  if (cached !== undefined) return cached
  const value = ctx?.measureText(char).width ?? 0
  widthCache.set(char, value)
  return value
}

/** 相邻字符之间额外的距离：字距、标点压缩、两端对齐补白。 */
function gapBefore(line: PaginateLine, index: number, previous: string, char: string): number {
  if (index === 0) return 0
  let gap = props.letterSpacing
  if (props.compressPunctuation && isPunctuationChar(previous) && isPunctuationChar(char)) {
    gap -= punctuationCompressionWidth(props.fontSize)
  }
  if (line.justifyPx > 0 && index > line.indentChars) gap += line.justifyPx
  return gap
}

/** 画一行（逐字画，才能带上字距、压缩与对齐）；返回行宽。 */
function drawLine(line: PaginateLine, left: number, top: number): number {
  if (!ctx || !line.text) return 0
  const chars = Array.from(line.text)
  let x = left
  let previous = ''
  for (let index = 0; index < chars.length; index += 1) {
    x += gapBefore(line, index, previous, chars[index])
    ctx.fillText(chars[index], x, top)
    x += charWidth(chars[index])
    previous = chars[index]
  }
  return x - left
}

/** 行内前 count 个字符的宽度（含字距、压缩、对齐补白）。 */
function prefixWidth(line: PaginateLine, count: number): number {
  const chars = Array.from(line.text)
  let width = 0
  let previous = ''
  for (let index = 0; index < count && index < chars.length; index += 1) {
    width += gapBefore(line, index, previous, chars[index])
    width += charWidth(chars[index])
    previous = chars[index]
  }
  return width
}

function pageLinesOf(pageData: PaginatePage): PaginateLine[] {
  return [...pageData.titleLines, ...pageData.columns.flatMap((column) => column.lines)]
}

function highlightRange(): { start: number; end: number } | null {
  const range = props.highlight
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return null
  const start = Math.max(0, Math.trunc(range.start))
  const end = Math.max(0, Math.trunc(range.end))
  if (end <= start) return null
  return { start, end }
}

/** 关键词 → 原文绝对范围，供搜索跳转高亮（只用于搜索，朗读只用偏移） */
function findRangeFor(text: string): { start: number; end: number } | null {
  const quote = text?.trim()
  if (!quote) return null
  const haystack = result.value?.text ?? props.text.replace(/\r\n?/g, '\n')
  const index = haystack.indexOf(quote)
  if (index < 0) return null
  return { start: index, end: index + quote.length }
}

/** 正文绝对偏移 → 页号（越界取最近页） */
function pageForOffset(offset: number): number {
  return pageIndexForOffset(result.value?.layout ?? [], offset)
}

/** 当前页覆盖的原文范围；纯标题页/空页返回 null */
function currentPageRange(): { start: number; end: number } | null {
  const pageData = result.value?.layout[page.value]
  if (!pageData || pageData.start < 0 || pageData.end < 0) return null
  return { start: pageData.start, end: pageData.end }
}

function render() {
  const canvas = canvasRef.value
  if (!canvas || !ctx) return
  fillBackground()
  const { text: color, muted, line } = palette.value
  const pad = props.padding
  const lineHeight = lineHeightPx()
  const headerText = tipText(props.headerMode, tipContext())
  const footerText = tipText(props.footerMode, tipContext())

  // 页眉横跨全宽
  if (headerText) {
    ctx.fillStyle = muted
    ctx.font = `${Math.max(11, props.fontSize - 9)}px ${fontStack.value}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(headerText, width / 2, 18, width - pad.left - pad.right)
  }
  if (props.showHeaderLine) {
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(pad.left, 44)
    ctx.lineTo(width - pad.right, 44)
    ctx.stroke()
  }

  const pageData = result.value?.layout[page.value]
  if (!pageData) {
    emit('page', { page: page.value, total: total.value })
    return
  }
  const box = contentBox()
  const titleHeight = pageData.titleLines.length * titleLineHeight()
  const dualTitle = (result.value?.columnCount ?? 1) === 2 && pageData.titleLines.length > 0
  const highlight = highlightRange()

  // 标题：单栏跨全宽，双栏只占第一栏顶部；按左/中/右对齐
  if (pageData.titleLines.length > 0) {
    ctx.font = titleFont()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillStyle = color
    const titleWidth = dualTitle ? pageData.columns[0]?.width ?? box.width : box.width
    for (const titleLine of pageData.titleLines) {
      const align = result.value?.titleAlign ?? 'left'
      const lineWidth = prefixWidth(titleLine, Array.from(titleLine.text).length)
      const left =
        align === 'center'
          ? box.left + Math.max(0, (titleWidth - lineWidth) / 2)
          : align === 'right'
            ? box.left + Math.max(0, titleWidth - lineWidth)
            : box.left
      drawLine(titleLine, left, box.top + titleLine.top)
    }
  }

  ctx.font = bodyFont()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'

  for (let columnIndex = 0; columnIndex < pageData.columns.length; columnIndex += 1) {
    const column = pageData.columns[columnIndex]
    if (column.lines.length === 0) continue
    const left = box.left + column.x
    const topOffset = columnIndex === 0 ? titleHeight : 0
    const top = box.top + topOffset
    ctx.save()
    ctx.beginPath()
    ctx.rect(left - props.fontSize, top - 2, column.width + props.fontSize * 2, box.height - topOffset + props.fontSize)
    ctx.clip()

    for (const bodyLine of column.lines) {
      const lineTop = top + bodyLine.top
      if (highlight && bodyLine.start >= 0) {
        const from = Math.max(highlight.start, bodyLine.start)
        const to = Math.min(highlight.end, bodyLine.end)
        if (to > from) {
          const startIndex = bodyLine.indentChars + (from - bodyLine.start)
          const endIndex = bodyLine.indentChars + (to - bodyLine.start)
          const x1 = prefixWidth(bodyLine, startIndex)
          const x2 = prefixWidth(bodyLine, endIndex)
          ctx.save()
          ctx.fillStyle = props.inkMode
            ? 'rgba(0,0,0,0.12)'
            : darkTheme.value
              ? 'rgba(214,193,148,0.24)'
              : 'rgba(61,107,83,0.18)'
          ctx.fillRect(left + x1, lineTop - 2, x2 - x1, lineHeight - 2)
          ctx.restore()
        }
      }
      ctx.fillStyle = color
      if (bodyLine.text) drawLine(bodyLine, left, lineTop)

      if (props.underlines?.length && bodyLine.text) {
        if (props.underlines.some((quote) => quote && bodyLine.text.includes(quote))) {
          const textWidth = prefixWidth(bodyLine, Array.from(bodyLine.text).length)
          ctx.save()
          ctx.strokeStyle = props.inkMode
            ? 'rgba(0,0,0,0.55)'
            : darkTheme.value
              ? 'rgba(214,193,148,0.55)'
              : 'rgba(61,107,83,0.45)'
          ctx.lineWidth = 2
          const underlineY = lineTop + lineHeight - 5
          ctx.beginPath()
          ctx.moveTo(left, underlineY)
          ctx.lineTo(left + textWidth, underlineY)
          ctx.stroke()
          ctx.restore()
        }
      }
    }
    ctx.restore()
  }

  // 页脚横跨全宽
  if (footerText) {
    ctx.fillStyle = muted
    ctx.font = `${Math.max(10, props.fontSize - 10)}px ${fontStack.value}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(footerText, width - pad.right, height - 20 - pad.bottom)
  }
  if (props.showFooterLine) {
    ctx.fillStyle = line
    ctx.fillRect(pad.left, height - 12 - pad.bottom, width - pad.left - pad.right, 1)
    const ratio = total.value <= 1 ? 1 : (page.value + 1) / total.value
    ctx.fillStyle = props.inkMode ? color : ACCENT
    ctx.fillRect(pad.left, height - 12 - pad.bottom, (width - pad.left - pad.right) * ratio, 1)
  }

  emit('page', { page: page.value, total: total.value })
}

function pageAnchor(): number {
  const layoutPages = result.value?.layout ?? []
  const current = layoutPages[page.value]
  if (!current) return -1
  if (current.start >= 0) return current.start
  for (let index = page.value + 1; index < layoutPages.length; index += 1) {
    if (layoutPages[index].start >= 0) return layoutPages[index].start
  }
  for (let index = page.value - 1; index >= 0; index -= 1) {
    if (layoutPages[index].end >= 0) return layoutPages[index].end
  }
  return -1
}

function syncAnchor() {
  anchorOffset.value = pageAnchor()
}

function snapshot(): HTMLCanvasElement | null {
  const canvas = canvasRef.value
  if (!canvas) return null
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  copy.getContext('2d')?.drawImage(canvas, 0, 0)
  return copy
}

function stopFrames() {
  cancelAnimationFrame(rafId)
  rafId = 0
}

/** 动画结束（自然完成）：画目标页并恢复交互。 */
function finishTurn() {
  stopFrames()
  animating = false
  turnImages = null
  emit('turnState', false)
  render()
}

/** 取消动画：切后台、尺寸/设置变化、关闭或新翻页打断，都直接落到目标页。 */
function cancelTurn(reason: TurnCancelReason) {
  if (!animating) return
  const pending = turnImages?.targetPage ?? page.value
  animator?.cancel(reason)
  stopFrames()
  animating = false
  turnImages = null
  emit('turnState', false)
  if (reason !== 'close' && !document.hidden) {
    page.value = pending
    syncAnchor()
  }
  render()
}

/** Canvas 2D 合成一帧：覆盖/平移/滚动直接平移两页，仿真按折线裁切旧页并画纸背。 */
function drawTurn(state: TurnState) {
  const canvas = canvasRef.value
  const images = turnImages
  if (!canvas || !ctx || !images) return
  const c = ctx
  const scale = dpr
  const { before, after } = images
  const frame = state.frame
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.clearRect(0, 0, canvas.width, canvas.height)
  c.fillStyle = palette.value.bg
  c.fillRect(0, 0, canvas.width, canvas.height)

  if (frame.kind === 'simulate' && frame.curl) {
    const curl = frame.curl
    const foldX = curl.foldX * scale
    const bulge = Math.max(1, curl.bulge * scale)
    const dir = frame.direction
    // 新页铺底，旧页露出被掀起的那一侧
    c.drawImage(after, 0, 0)
    c.save()
    c.beginPath()
    if (dir > 0) c.rect(0, 0, foldX, canvas.height)
    else c.rect(foldX, 0, canvas.width - foldX, canvas.height)
    c.clip()
    c.drawImage(before, 0, 0)
    c.restore()
    // 折线旁压暗新页，制造隆起
    const band = Math.max(6 * scale, curl.shadowWidth * scale)
    const gradient = c.createLinearGradient(foldX, 0, dir > 0 ? foldX + band : foldX - band, 0)
    gradient.addColorStop(0, 'rgba(0,0,0,0.26)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = gradient
    c.save()
    c.beginPath()
    if (dir > 0) c.rect(foldX, 0, band, canvas.height)
    else c.rect(foldX - band, 0, band, canvas.height)
    c.fill()
    c.restore()
    // 卷起的纸背：折线与反向弧之间的一条月牙
    const lift = dir > 0 ? bulge : -bulge
    c.save()
    c.beginPath()
    c.moveTo(foldX, 0)
    c.quadraticCurveTo(foldX + lift, canvas.height / 2, foldX, canvas.height)
    c.quadraticCurveTo(foldX + lift * 0.55, canvas.height / 2, foldX, 0)
    c.closePath()
    c.fillStyle = palette.value.bg
    c.fill()
    c.strokeStyle = 'rgba(0,0,0,0.12)'
    c.lineWidth = Math.max(1, scale)
    c.stroke()
    c.restore()
    return
  }

  c.drawImage(before, frame.from.x * scale, frame.from.y * scale)
  c.drawImage(after, frame.to.x * scale, frame.to.y * scale)
}

function turn(direction: 1 | -1) {
  // 新翻页打断旧动画：先结束旧的、画它要到的页，再开始新的一次
  if (animating) {
    const pending = turnImages?.targetPage ?? page.value
    animator?.cancel('interrupt')
    stopFrames()
    animating = false
    turnImages = null
    emit('turnState', false)
    page.value = pending
    syncAnchor()
    render()
  }

  const nextPage = page.value + direction
  if (nextPage < 0 || nextPage >= total.value) {
    // 章边界：先让宿主加载相邻章，加载成功前不播动画
    emit('chapterBoundary', { direction })
    return
  }

  const mode = effectiveAnimation.value
  if (mode === 'none' || !canvasRef.value) {
    page.value = nextPage
    syncAnchor()
    render()
    return
  }

  const before = snapshot()
  if (!before) return
  page.value = nextPage
  syncAnchor()
  render()
  const after = snapshot()
  if (!after) return
  turnImages = { before, after, targetPage: nextPage }
  animating = true
  emit('turnState', true)
  if (!animator) {
    animator = new TurnAnimator({
      now: () => performance.now(),
      onUpdate: (state) => drawTurn(state),
      onComplete: () => finishTurn(),
    })
  }
  animator.begin(mode, direction, { width, height, durationMs: turnDurationMs(mode) })
  const step = () => {
    animator?.tick()
    if (animator?.animating) rafId = requestAnimationFrame(step)
  }
  rafId = requestAnimationFrame(step)
}

function next() {
  turn(1)
}

function prev() {
  turn(-1)
}

function onCanvasClick(event: MouseEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  if (swallowClick) {
    swallowClick = false
    return
  }
  const rect = canvas.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  const index = tapZoneIndex(x, y)
  const zones = props.tapZones?.length === 9 ? props.tapZones : DEFAULT_TAP_ZONES
  emit('tapAction', zones[index] ?? 0)
}

/** 点按落点换算成词；双栏时先定位到栏，再在该行里选词。 */
function selectionAt(clientX: number, clientY: number): ReaderSelection | null {
  const canvas = canvasRef.value
  const pageData = result.value?.layout[page.value]
  if (!canvas || !ctx || !pageData) return null
  const rect = canvas.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const box = contentBox()
  const x = clientX - rect.left
  const y = clientY - rect.top
  const titleHeight = pageData.titleLines.length * titleLineHeight()
  if (y < box.top || y > box.top + box.height) return null

  for (let columnIndex = 0; columnIndex < pageData.columns.length; columnIndex += 1) {
    const column = pageData.columns[columnIndex]
    const columnLeft = box.left + column.x
    if (x < columnLeft - props.fontSize || x > columnLeft + column.width + props.fontSize) continue
    const columnTop = box.top + (columnIndex === 0 ? titleHeight : 0)
    for (const line of column.lines) {
      if (!line.text) continue
      const lineTop = columnTop + line.top
      if (y < lineTop || y > lineTop + lineHeightPx()) continue
      ctx.font = bodyFont()
      const measure = (value: string) => {
        const chars = Array.from(value).length
        return ctx!.measureText(value).width + props.letterSpacing * Math.max(0, chars - 1)
      }
      const hit = hitTest([line.text], { x: x - columnLeft, y: 0 }, {
        left: 0,
        top: 0,
        lineHeight: lineHeightPx(),
        measure,
      })
      if (!hit || !hit.word) return null
      const flat = pageLinesOf(pageData)
      return {
        text: hit.word,
        line: hit.line.trim(),
        fallback: hit.fallback,
        lineIndex: Math.max(0, flat.indexOf(line)),
        charIndex: hit.charIndex,
        x,
        y,
        clientX,
        clientY,
      }
    }
  }
  return null
}

function clearPress() {
  if (press) {
    window.clearTimeout(press.timer)
    press.timer = 0
  }
  press = null
}

/** 移动超过长按容差后只停掉计时器，保留按下点给抬手时判定滑动。 */
function cancelLongPressTimer() {
  if (!press || press.timer === 0) return
  window.clearTimeout(press.timer)
  press.timer = 0
}

function finishLongPress() {
  const active = press
  if (!active || active.longPressed) return
  cancelLongPressTimer()
  active.longPressed = true
  swallowClick = true
  const selection = selectionAt(active.x, active.y)
  if (selection) emit('select', selection)
}

/**
 * 触屏长按会开查词面板，但松手时浏览器仍补发一次 click。
 * 此时点击目标已变成刚出现的遮罩，会立刻把面板关掉；在捕获阶段吞掉这次 click。
 */
let clickSuppressTimer = 0
function suppressNextClick() {
  swallowClick = false
  const handler = (event: Event) => {
    window.clearTimeout(clickSuppressTimer)
    window.removeEventListener('click', handler, true)
    event.preventDefault()
    event.stopPropagation()
  }
  window.addEventListener('click', handler, true)
  clickSuppressTimer = window.setTimeout(() => {
    window.removeEventListener('click', handler, true)
  }, 1200)
}

function onCanvasPointerDown(event: PointerEvent) {
  if (!event.isPrimary) return
  if (event.pointerType === 'mouse' && event.button !== 0) return
  clearPress()
  swallowClick = false
  press = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    startedAt: performance.now(),
    longPressed: false,
    timer: window.setTimeout(finishLongPress, LONG_PRESS_MS),
  }
}

function onWindowPointerMove(event: PointerEvent) {
  if (!press || event.pointerId !== press.pointerId) return
  press.x = event.clientX
  press.y = event.clientY
  if (press.longPressed || press.timer === 0) return
  if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) > LONG_PRESS_TOLERANCE) {
    cancelLongPressTimer()
  }
}

function onWindowPointerEnd(event: PointerEvent) {
  const active = press
  if (!active || event.pointerId !== active.pointerId) return
  // 被系统手势打断时只放弃本次判定，不按位移翻页
  if (event.type === 'pointercancel') {
    clearPress()
    return
  }
  const durationMs = performance.now() - active.startedAt
  const dx = event.clientX - active.startX
  const dy = event.clientY - active.startY
  const moved = Math.hypot(dx, dy)

  // 长按已触发：松手不翻页；长按后再移动按取消处理
  if (active.longPressed) {
    clearPress()
    suppressNextClick()
    return
  }

  const gesture = resolveReaderGesture({ dx, dy, durationMs, mode: gestureMode.value })
  if (gesture === 'longpress') {
    // 浏览器把 500ms 计时器压后时，由抬手补齐一次选词
    active.x = event.clientX
    active.y = event.clientY
    finishLongPress()
    clearPress()
    suppressNextClick()
    return
  }
  clearPress()
  // 超过长按容差的移动不再当作点按，避免滑动误触九区动作
  if (moved > LONG_PRESS_TOLERANCE) swallowClick = true
  if (gesture === 'next') next()
  else if (gesture === 'prev') prev()
}

function onCanvasContextMenu(event: MouseEvent) {
  event.preventDefault()
}

function onKey(event: KeyboardEvent) {
  if (!props.keysEnabled) return
  const target = event.target as HTMLElement | null
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(target.tagName))) return
  if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === 'ArrowDown' || event.key === ' ') {
    event.preventDefault()
    next()
  } else if (event.key === 'ArrowLeft' || event.key === 'PageUp' || event.key === 'ArrowUp') {
    event.preventDefault()
    prev()
  }
}

function onVisibilityChange() {
  if (document.hidden) cancelTurn('hidden')
}

function onMotionPreferenceChange(event: MediaQueryListEvent) {
  reducedMotion.value = event.matches
  cancelTurn('setting')
  render()
}

onMounted(() => {
  const canvas = canvasRef.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  anchorOffset.value = -1
  page.value = Math.max(0, props.initialPage)
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion.value = motionQuery.matches
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', onMotionPreferenceChange)
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  layout(false)
  observer = new ResizeObserver(() => {
    cancelTurn('resize')
    layout(true)
  })
  if (canvas.parentElement) observer.observe(canvas.parentElement)
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', onWindowPointerEnd)
  window.addEventListener('pointercancel', onWindowPointerEnd)
})

onBeforeUnmount(() => {
  cancelTurn('close')
  animator = null
  if (motionQuery && typeof motionQuery.removeEventListener === 'function') {
    motionQuery.removeEventListener('change', onMotionPreferenceChange)
  }
  document.removeEventListener('visibilitychange', onVisibilityChange)
  observer?.disconnect()
  layoutJob?.cancel()
  cancelAnimationFrame(layoutFrame)
  window.clearTimeout(settingsTimer)
  clearPress()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', onWindowPointerEnd)
  window.removeEventListener('pointercancel', onWindowPointerEnd)
})

watch(
  () => props.text,
  () => {
    window.clearTimeout(settingsTimer)
    anchorOffset.value = -1
    page.value = Math.max(0, props.initialPage)
    layout(false)
  },
)

watch(
  () => props.initialPage,
  (value) => {
    window.clearTimeout(settingsTimer)
    anchorOffset.value = -1
    page.value = Math.max(0, value)
    layout(false)
  },
)

watch(
  () => [
    props.title,
    props.bookName,
    props.fontSize,
    props.fontFamily,
    props.lineHeight,
    props.paragraphSpacing,
    props.indent,
    props.padding,
    props.letterSpacing,
    props.bold,
    props.titleMode,
    props.titleSize,
    props.align,
    props.compressPunctuation,
    props.kinsoku,
    props.dualColumn,
    props.animation,
    props.inkMode,
    props.headerMode,
    props.footerMode,
    props.showHeaderLine,
    props.showFooterLine,
  ],
  () => {
    // 滑杆连续输入时合帧：120ms 内只重排最后一步，且按字符偏移留在原处
    window.clearTimeout(settingsTimer)
    settingsTimer = window.setTimeout(() => layout(true), SETTINGS_DEBOUNCE_MS)
  },
  { deep: true },
)

watch(
  () => [props.theme, props.themeColors],
  () => render(),
  { deep: true },
)

function goto(target: number) {
  cancelTurn('interrupt')
  const nextPage = Math.max(0, Math.min(total.value - 1, target))
  if (nextPage === page.value) {
    render()
    return
  }
  page.value = nextPage
  syncAnchor()
  render()
}

function findPageFor(text: string): number {
  if (!text) return -1
  const layoutPages = result.value?.layout ?? []
  return layoutPages.findIndex((pageData) => pageLinesOf(pageData).map((line) => line.text).join('\n').includes(text))
}

watch(
  () => props.highlight,
  () => render(),
)

watch(
  () => props.underlines,
  () => render(),
  { deep: true },
)

function currentPageLines() {
  const pageData = result.value?.layout[page.value]
  if (!pageData) return []
  return pageLinesOf(pageData).map((line) => line.text).filter(Boolean)
}

defineExpose({
  next,
  prev,
  total,
  page,
  goto,
  findPageFor,
  findRangeFor,
  pageForOffset,
  currentPageRange,
  currentPageLines,
  isAnimating: () => animating,
})
</script>

<template>
  <div class="mo-canvas-host" data-testid="canvas-reader" :style="{ background: palette.bg }">
    <canvas
      ref="canvasRef"
      class="mo-canvas"
      @click="onCanvasClick"
      @pointerdown="onCanvasPointerDown"
      @contextmenu="onCanvasContextMenu"
    />
    <div
      v-if="loading"
      class="mo-reader-loading"
      data-testid="reader-loading"
      :style="{ color: palette.muted, background: palette.bg }"
    >
      排版中…
    </div>
    <div
      v-if="dualHint"
      class="mo-reader-hint"
      :style="{ color: palette.muted, borderColor: palette.line, background: palette.bg }"
    >
      {{ dualHint }}
    </div>
  </div>
</template>

<style>
.mo-canvas-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.mo-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: pointer;
  /* 手势由 pointer 事件自行判定；避免浏览器接管平移/缩放手势后发出 pointercancel */
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
}
.mo-reader-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  opacity: 0.8;
}
.mo-reader-hint {
  position: absolute;
  left: 50%;
  bottom: 64px;
  transform: translateX(-50%);
  padding: 2px 10px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  opacity: 0.85;
  pointer-events: none;
}
</style>

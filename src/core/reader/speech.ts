/**
 * 朗读计划与游标（#127）：纯逻辑，不依赖 speechSynthesis。
 *
 * 计划 = 章节标题一段 + 正文逐行切段（空行/空白行跳过），每段记录原文绝对
 * UTF-16 起止偏移。游标负责段内字符位置、上一段/下一段与章末判断，高亮和
 * 续读都只认绝对偏移，不做子串匹配，避免重复句子高亮错行。
 */

export type SpeechSegmentKind = 'title' | 'paragraph'

export interface SpeechSegment {
  index: number
  kind: SpeechSegmentKind
  text: string
  /** 原文绝对起始偏移（含）；标题段为 -1 */
  start: number
  /** 原文绝对结束偏移（不含）；标题段为 -1 */
  end: number
}

export interface SpeechPlan {
  title: string
  body: string
  segments: SpeechSegment[]
}

export interface SpeechHighlightRange {
  start: number
  end: number
}

const splitLines = (body: string): Array<{ text: string; start: number }> => {
  const normalized = body.replace(/\r\n?/g, '\n')
  const lines: Array<{ text: string; start: number }> = []
  let lineStart = 0
  while (lineStart <= normalized.length) {
    const lineEnd = normalized.indexOf('\n', lineStart)
    const end = lineEnd === -1 ? normalized.length : lineEnd
    const raw = normalized.slice(lineStart, end)
    const text = raw.trim()
    if (text) {
      const leading = raw.length - raw.trimStart().length
      lines.push({ text, start: lineStart + leading })
    }
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }
  return lines
}

/** 生成一章的朗读计划：标题一段，正文按换行切段（空行/空白行跳过）。 */
export function buildSpeechPlan(title: string, body: string): SpeechPlan {
  const heading = typeof title === 'string' ? title.trim() : ''
  const content = typeof body === 'string' ? body : ''
  const segments: SpeechSegment[] = []
  if (heading) {
    segments.push({ index: 0, kind: 'title', text: heading, start: -1, end: -1 })
  }
  for (const line of splitLines(content)) {
    segments.push({
      index: segments.length,
      kind: 'paragraph',
      text: line.text,
      start: line.start,
      end: line.start + line.text.length,
    })
  }
  return { title: heading, body: content, segments }
}

/**
 * 找当前页起始偏移所在（或之后最近）的正文段，用于「从当前页开始朗读」。
 * 没有正文段时返回 -1。
 */
export function segmentIndexForOffset(plan: SpeechPlan, offset: number): number {
  const { segments } = plan
  const target = Number.isFinite(offset) ? offset : 0
  let firstParagraph = -1
  let lastParagraph = -1
  for (const segment of segments) {
    if (segment.kind !== 'paragraph') continue
    if (firstParagraph === -1) firstParagraph = segment.index
    lastParagraph = segment.index
    if (target < segment.end) return segment.index
  }
  return lastParagraph === -1 ? -1 : lastParagraph
}

export class SpeechCursor {
  readonly plan: SpeechPlan
  private currentIndex = -1
  private currentCharOffset = 0

  constructor(plan: SpeechPlan) {
    this.plan = plan
    if (plan.segments.length > 0) this.currentIndex = 0
  }

  get index(): number {
    return this.currentIndex
  }

  get total(): number {
    return this.plan.segments.length
  }

  get segment(): SpeechSegment | null {
    if (this.currentIndex < 0) return null
    return this.plan.segments[this.currentIndex] ?? null
  }

  /** 当前段内已读字符数（相对段首） */
  get charOffset(): number {
    return this.currentCharOffset
  }

  /** 当前字符在原文中的绝对偏移；标题段/空计划为 -1 */
  get absoluteOffset(): number {
    const segment = this.segment
    if (!segment) return -1
    if (segment.kind === 'title') return -1
    return segment.start + this.currentCharOffset
  }

  get isLast(): boolean {
    if (this.total === 0) return true
    return this.currentIndex >= this.total - 1
  }

  /** 跳到指定段并复位段内偏移（越界钳位） */
  setIndex(index: number): void {
    if (this.total === 0) {
      this.currentIndex = -1
      this.currentCharOffset = 0
      return
    }
    const next = Number.isFinite(index) ? Math.trunc(index) : 0
    this.currentIndex = Math.min(this.total - 1, Math.max(0, next))
    this.currentCharOffset = 0
  }

  /** 记录 speechSynthesis 的 boundary 字符位置（相对当前段），并钳位 */
  setBoundary(charIndex: number): void {
    const segment = this.segment
    if (!segment || segment.kind === 'title') {
      this.currentCharOffset = 0
      return
    }
    const value = Number.isFinite(charIndex) ? Math.trunc(charIndex) : 0
    this.currentCharOffset = Math.min(segment.text.length, Math.max(0, value))
  }

  next(): boolean {
    if (this.total === 0 || this.currentIndex >= this.total - 1) return false
    this.currentIndex += 1
    this.currentCharOffset = 0
    return true
  }

  prev(): boolean {
    if (this.total === 0 || this.currentIndex <= 0) return false
    this.currentIndex -= 1
    this.currentCharOffset = 0
    return true
  }

  /** 当前段读完：有下一段则前进，否则报告章末 */
  advance(): 'next' | 'end' {
    return this.next() ? 'next' : 'end'
  }

  /** 当前段从已读位置到段尾的高亮范围；标题段/已读完返回 null */
  highlightRange(): SpeechHighlightRange | null {
    const segment = this.segment
    if (!segment || segment.kind === 'title') return null
    if (this.currentCharOffset >= segment.text.length) return null
    return { start: segment.start + this.currentCharOffset, end: segment.end }
  }

  /** 当前段剩余要念的文本（续读/恢复时从 character offset 接着念） */
  remainingText(): string {
    const segment = this.segment
    if (!segment) return ''
    return segment.text.slice(this.currentCharOffset)
  }
}

export type SpeechErrorAction = 'ignore' | 'not-allowed' | 'retry' | 'stop'

/**
 * 朗读错误分类：
 * - interrupted/canceled 且是用户操作引起 → 忽略；
 * - not-allowed → 暂停并提示点页面；
 * - audio-busy → 最多重试一次（由调用方保证只重试一次）；
 * - 其它 → 停止并提示原因，不无限重试。
 */
export function classifySpeechError(error: string, userInitiated: boolean): SpeechErrorAction {
  const code = typeof error === 'string' ? error : ''
  if ((code === 'interrupted' || code === 'canceled') && userInitiated) return 'ignore'
  if (code === 'not-allowed') return 'not-allowed'
  if (code === 'audio-busy') return 'retry'
  return 'stop'
}

export const SPEECH_NOT_ALLOWED_NOTICE = '点一下页面再继续'
export const SPEECH_NO_VOICE_MESSAGE = '系统没有中文音色，暂时不能朗读'
export const SPEECH_UNSUPPORTED_MESSAGE = '当前浏览器不支持朗读'

export function speechErrorNotice(error: string): string {
  const code = typeof error === 'string' ? error : ''
  if (code === 'not-allowed') return SPEECH_NOT_ALLOWED_NOTICE
  if (code === 'audio-hardware') return '朗读失败：音频设备不可用'
  if (code === 'audio-busy') return '朗读失败：音频设备忙'
  if (code === 'network') return '朗读失败：语音服务网络异常'
  if (code === 'synthesis-failed') return '朗读失败：语音合成出错'
  if (code === 'synthesis-unavailable') return '朗读失败：语音合成不可用'
  if (code === 'language-unavailable' || code === 'voice-unavailable') {
    return '朗读失败：没有可用的中文音色'
  }
  if (code === 'text-too-long') return '朗读失败：本段太长'
  if (code === 'invalid-argument') return '朗读失败：语音参数无效'
  return '朗读失败：未知错误'
}

export interface SpeechAvailability {
  /** 浏览器是否提供 speechSynthesis + SpeechSynthesisUtterance */
  supported: boolean
  /** 是否已经尝试读取过音色列表（含等待 voiceschanged 之后仍为空的情况） */
  loaded: boolean
  /** 当前可用音色的语言标签，如 'zh-CN' */
  voiceLangs: readonly string[]
}

/** 是否中文音色 */
export function isChineseVoiceLang(lang: string | undefined): boolean {
  return typeof lang === 'string' && lang.toLowerCase().startsWith('zh')
}

/**
 * 朗读入口禁用原因：
 * - 不支持语音合成 → 说明不支持；
 * - 还没有音色结论（刚进页面、voiceschanged 未到）→ 不禁用，避免首屏误判；
 * - 已确认没有任何音色或没有中文音色 → 禁用并说明原因。
 */
export function speechBlockedMessage(availability: SpeechAvailability): string {
  if (!availability.supported) return SPEECH_UNSUPPORTED_MESSAGE
  if (!availability.loaded) return ''
  return availability.voiceLangs.some((lang) => isChineseVoiceLang(lang)) ? '' : SPEECH_NO_VOICE_MESSAGE
}


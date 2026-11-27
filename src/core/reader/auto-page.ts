/**
 * 自动翻页控制器（#126）——纯逻辑，时钟由外部注入。
 *
 * 控制器只做「什么时候该翻页 / 该续章 / 该停」的判断，真正的翻页、加载、
 * 界面提示都由宿主（App.vue）执行，所以这里没有任何 DOM 或定时器依赖。
 */

export type AutoPageStatus = 'idle' | 'running' | 'paused'

/** 暂停原因：任一存在即暂停，全部清空才恢复（恢复时重置计时）。 */
export type AutoPagePauseReason =
  | 'user'
  | 'menu'
  | 'toc'
  | 'settings'
  | 'hidden'
  | 'turn'
  | 'loading'
  | 'chapter-failed'

export type AutoPageTick =
  | { kind: 'idle' }
  | { kind: 'wait' }
  | { kind: 'turn'; page: number }
  | { kind: 'load-chapter' }
  | { kind: 'book-end'; message: string }

export interface AutoPagePosition {
  page: number
  pages: number
  hasNextChapter: boolean
}

export interface LoadedChapter {
  pages: number
}

export const AUTO_PAGE_MIN_SECONDS = 1
export const AUTO_PAGE_MAX_SECONDS = 60
export const AUTO_PAGE_DEFAULT_SECONDS = 10
export const AUTO_PAGE_BOOK_END_MESSAGE = '已到全书末尾'

export interface AutoPageOptions {
  /** 注入时钟，测试用假时钟；默认 Date.now */
  now?: () => number
}

const clampSeconds = (value: number): number => {
  if (!Number.isFinite(value)) return AUTO_PAGE_DEFAULT_SECONDS
  const rounded = Math.round(value)
  return Math.min(AUTO_PAGE_MAX_SECONDS, Math.max(AUTO_PAGE_MIN_SECONDS, rounded))
}

export class AutoPageController {
  private readonly now: () => number
  private statusValue: AutoPageStatus = 'idle'
  private secondsValue = AUTO_PAGE_DEFAULT_SECONDS
  private reasons = new Set<AutoPagePauseReason>()
  private dueAt = 0
  private pageValue = 0
  private pagesValue = 0
  private hasNextChapterValue = true
  private noticeValue = ''

  constructor(options: AutoPageOptions = {}) {
    this.now = options.now ?? (() => Date.now())
  }

  get status(): AutoPageStatus {
    return this.statusValue
  }

  get seconds(): number {
    return this.secondsValue
  }

  get notice(): string {
    return this.noticeValue
  }

  get position(): AutoPagePosition {
    return {
      page: this.pageValue,
      pages: this.pagesValue,
      hasNextChapter: this.hasNextChapterValue,
    }
  }

  /** 状态条文案；未开始时为空字符串。 */
  get label(): string {
    return this.statusValue === 'idle' ? '' : `自动翻页 · ${this.secondsValue} 秒`
  }

  get pausedReasons(): AutoPagePauseReason[] {
    return [...this.reasons]
  }

  setPosition(position: Partial<AutoPagePosition>): void {
    if (typeof position.page === 'number' && Number.isFinite(position.page)) {
      this.pageValue = Math.max(0, Math.floor(position.page))
    }
    if (typeof position.pages === 'number' && Number.isFinite(position.pages)) {
      this.pagesValue = Math.max(0, Math.floor(position.pages))
    }
    if (typeof position.hasNextChapter === 'boolean') {
      this.hasNextChapterValue = position.hasNextChapter
    }
  }

  setSeconds(value: number): void {
    if (!Number.isFinite(value)) return
    this.secondsValue = clampSeconds(value)
    this.resetTimer()
  }

  start(): void {
    this.reasons.clear()
    this.noticeValue = ''
    this.statusValue = 'running'
    this.resetTimer()
  }

  /** 手动暂停（界面上的「暂停」按钮）。 */
  pause(): void {
    this.addPauseReason('user')
  }

  /** 继续：清掉用户暂停与章末失败原因，原因清空后恢复并重置计时。 */
  resume(): void {
    if (this.statusValue === 'idle') return
    this.reasons.delete('user')
    this.reasons.delete('chapter-failed')
    this.noticeValue = ''
    this.syncStatusFromReasons()
  }

  stop(): void {
    this.statusValue = 'idle'
    this.reasons.clear()
    this.noticeValue = ''
  }

  addPauseReason(reason: AutoPagePauseReason): void {
    if (this.statusValue === 'idle') return
    this.reasons.add(reason)
    this.syncStatusFromReasons()
  }

  removePauseReason(reason: AutoPagePauseReason): void {
    if (!this.reasons.delete(reason)) return
    if (this.statusValue === 'idle') return
    this.syncStatusFromReasons()
  }

  /** 手动翻页后调用：运行中则重新计时（暂停中不动）。 */
  notifyTurn(): void {
    if (this.statusValue === 'running') this.resetTimer()
  }

  /** 章末续章成功：切到新章第 0 页并重新计时。 */
  loadedChapter(chapter: LoadedChapter): void {
    this.pagesValue = Math.max(0, Math.floor(chapter.pages))
    this.pageValue = 0
    this.reasons.delete('loading')
    this.reasons.delete('chapter-failed')
    this.noticeValue = ''
    this.statusValue = 'running'
    this.reasons.delete('user')
    this.syncStatusFromReasons()
    this.resetTimer()
  }

  /** 章末续章失败：暂停并留下提示，用户继续后重试。 */
  failedChapter(message: string): void {
    this.reasons.delete('loading')
    this.reasons.add('chapter-failed')
    this.noticeValue = message
    if (this.statusValue !== 'idle') this.statusValue = 'paused'
  }

  /** 宿主循环调用；到点返回该做什么。 */
  tick(): AutoPageTick {
    if (this.statusValue !== 'running') return { kind: 'idle' }
    if (this.now() < this.dueAt) return { kind: 'wait' }
    if (this.pagesValue <= 0) {
      this.resetTimer()
      return { kind: 'wait' }
    }
    if (this.pageValue < this.pagesValue - 1) {
      this.pageValue += 1
      this.resetTimer()
      return { kind: 'turn', page: this.pageValue }
    }
    if (this.hasNextChapterValue) {
      this.reasons.add('loading')
      this.statusValue = 'paused'
      return { kind: 'load-chapter' }
    }
    this.stop()
    this.noticeValue = AUTO_PAGE_BOOK_END_MESSAGE
    return { kind: 'book-end', message: AUTO_PAGE_BOOK_END_MESSAGE }
  }

  private resetTimer(): void {
    this.dueAt = this.now() + this.secondsValue * 1000
  }

  private syncStatusFromReasons(): void {
    if (this.reasons.size === 0) {
      this.statusValue = 'running'
      this.resetTimer()
    } else {
      this.statusValue = 'paused'
    }
  }
}
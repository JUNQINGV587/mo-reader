/**
 * 翻页动画调度（#126）：同一时间只允许一个动画，负责时长钳制、打断与取消。
 *
 * 逐帧绘制由宿主（CanvasReader）调用 tick() 驱动，时钟注入，测试不需要 rAF。
 */
import { PAGE_TURN_MS, pageTurnFrame } from './page-turn.js'
import type { PageTurnKind, TurnFrame, TurnOffset, TurnSize } from './page-turn.js'

export const TURN_MIN_MS = 260
export const TURN_MAX_MS = 320

export type TurnCancelReason = 'interrupt' | 'hidden' | 'resize' | 'close' | 'setting'

export interface TurnState {
  kind: PageTurnKind
  direction: 1 | -1
  durationMs: number
  progress: number
  eased: number
  frame: TurnFrame
  /** 新页的落点（进度 0 时的目标偏移），供打断时直接画目标页 */
  target: TurnOffset
}

export interface TurnAnimatorOptions {
  now: () => number
  onUpdate: (state: TurnState) => void
  onComplete?: (state: TurnState) => void
  onCancel?: (reason: TurnCancelReason) => void
}

export interface TurnBeginOptions extends TurnSize {
  durationMs?: number
}

interface ActiveTurn {
  kind: PageTurnKind
  direction: 1 | -1
  size: TurnSize
  durationMs: number
  startedAt: number
}

const clampDuration = (value: number): number => Math.min(TURN_MAX_MS, Math.max(TURN_MIN_MS, Math.round(value)))

export class TurnAnimator {
  private readonly now: () => number
  private readonly onUpdate: (state: TurnState) => void
  private readonly onComplete?: (state: TurnState) => void
  private readonly onCancel?: (reason: TurnCancelReason) => void
  private active: ActiveTurn | null = null

  constructor(options: TurnAnimatorOptions) {
    this.now = options.now
    this.onUpdate = options.onUpdate
    this.onComplete = options.onComplete
    this.onCancel = options.onCancel
  }

  get animating(): boolean {
    return this.active !== null
  }

  get durationMs(): number {
    return this.active?.durationMs ?? 0
  }

  get current(): TurnState | null {
    if (!this.active) return null
    return this.stateAt(this.active, this.now())
  }

  begin(kind: PageTurnKind, direction: 1 | -1, options: TurnBeginOptions): void {
    if (this.active) this.cancel('interrupt')
    const size = { width: options.width, height: options.height }
    const requested = options.durationMs ?? (kind === 'none' ? 0 : PAGE_TURN_MS)
    const durationMs = kind === 'none' ? 0 : clampDuration(requested)
    if (durationMs === 0) {
      const instant: ActiveTurn = { kind, direction, size, durationMs: 0, startedAt: this.now() }
      const state = this.stateAt(instant, this.now())
      this.onComplete?.(state)
      return
    }
    this.active = { kind, direction, size, durationMs, startedAt: this.now() }
  }

  tick(): void {
    if (!this.active) return
    const turn = this.active
    const state = this.stateAt(turn, this.now())
    this.onUpdate(state)
    if (state.progress >= 1) {
      this.active = null
      this.onComplete?.(state)
    }
  }

  cancel(reason: TurnCancelReason): void {
    if (!this.active) return
    this.active = null
    this.onCancel?.(reason)
  }

  private stateAt(turn: ActiveTurn, now: number): TurnState {
    const elapsed = Math.max(0, now - turn.startedAt)
    const progress = turn.durationMs === 0 ? 1 : Math.min(1, elapsed / turn.durationMs)
    const frame = pageTurnFrame(turn.kind, turn.direction, progress, turn.size)
    const target = pageTurnFrame(turn.kind, turn.direction, 0, turn.size).to
    return {
      kind: turn.kind,
      direction: turn.direction,
      durationMs: turn.durationMs,
      progress: frame.progress,
      eased: frame.eased,
      frame,
      target,
    }
  }
}
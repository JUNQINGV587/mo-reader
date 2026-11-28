/**
 * 阅读页手势判定（#152）：滑动翻页 / 快速轻扫 / 滚动模式纵向过渡 / 长按选词。
 *
 * 纯函数：只看按下到抬起的位移、时长和翻页形态，输出 none | prev | next | longpress；
 * 计时、选词与翻页动画由 CanvasReader 负责（翻页一律复用现有 turn(±1)）。
 */
import type { ReaderPageAnimation } from './settings.js'

export type ReaderGesture = 'none' | 'prev' | 'next' | 'longpress'

/** 手势物理模式：page 为分页阅读，scroll 为滚动形态的纵向过渡。 */
export type ReaderGestureMode = 'page' | 'scroll'

export interface ReaderGestureInput {
  /** 水平位移（px），向右为正 */
  dx: number
  /** 垂直位移（px），向下为正 */
  dy: number
  /** 按下到抬起的时长（ms） */
  durationMs: number
  /** 当前翻页形态归一化后的手势模式 */
  mode: ReaderGestureMode
}

/** 长按判定：按住 ≥500ms 且位移 <10px 进入选词/查字典。 */
export const LONG_PRESS_MS = 500
export const LONG_PRESS_TOLERANCE = 10

/** 滑动判定：主轴位移 ≥60px，或速度 ≥0.5px/ms 且主轴位移 ≥20px。 */
export const SWIPE_DISTANCE = 60
export const SWIPE_MIN_DISTANCE = 20
export const SWIPE_SPEED = 0.5

/** 翻页形态 → 手势模式；只有 scroll 走纵向过渡，其余形态都按分页处理。 */
export function gestureModeFor(animation: ReaderPageAnimation): ReaderGestureMode {
  return animation === 'scroll' ? 'scroll' : 'page'
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

/** 按下到抬起的整体速度（px/ms）；时长为 0 且有位移按无穷快处理。 */
function speedOf(distance: number, durationMs: number): number {
  if (durationMs > 0) return distance / durationMs
  return distance > 0 ? Number.POSITIVE_INFINITY : 0
}

export function resolveReaderGesture(input: ReaderGestureInput): ReaderGesture {
  const dx = finite(input.dx)
  const dy = finite(input.dy)
  const durationMs = Math.max(0, finite(input.durationMs))
  const distance = Math.hypot(dx, dy)

  // 长按优先：按住够久且几乎没动，进入选词而不是翻页
  if (durationMs >= LONG_PRESS_MS && distance < LONG_PRESS_TOLERANCE) return 'longpress'

  const horizontal = Math.abs(dx) > Math.abs(dy)
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  const fast = speedOf(distance, durationMs) >= SWIPE_SPEED

  if (input.mode === 'scroll') {
    // 滚动形态只认纵向：上滑看下一屏、下滑回上一屏；横向不翻页
    if (horizontal) return 'none'
    if (ay >= SWIPE_DISTANCE || (fast && ay >= SWIPE_MIN_DISTANCE)) return dy < 0 ? 'next' : 'prev'
    return 'none'
  }

  // 分页形态只认水平：纵向与对角线不误翻页
  if (!horizontal) return 'none'
  if (ax >= SWIPE_DISTANCE || (fast && ax >= SWIPE_MIN_DISTANCE)) return dx < 0 ? 'next' : 'prev'
  return 'none'
}

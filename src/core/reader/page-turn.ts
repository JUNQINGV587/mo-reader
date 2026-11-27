/**
 * 翻页形态模型（#126）：覆盖 / 平移 / 仿真 / 滚动 / 无动画。
 *
 * 纯函数：只算「某一刻两页各画在哪里、卷页折线到哪」，由 CanvasReader 负责绘制。
 * 墨水屏与系统「减少动态效果」在这里统一收敛成无动画，渲染层不再各自判断。
 */
import type { ReaderPageAnimation } from './settings.js'

export type PageTurnKind = ReaderPageAnimation

/** 一次翻页动画的时长（毫秒）；票面要求 260–320ms。 */
export const PAGE_TURN_MS = 280

export interface PageTurnEnvironment {
  /** 系统开启「减少动态效果」 */
  reducedMotion?: boolean
  /** 墨水屏模式 */
  inkMode?: boolean
}

/** 实际使用的翻页形态：减少动态效果与墨水屏一律无动画，用户显式选择也不覆盖。 */
export function resolvePageTurn(kind: PageTurnKind, env: PageTurnEnvironment = {}): PageTurnKind {
  if (kind === 'none') return 'none'
  if (env.reducedMotion === true || env.inkMode === true) return 'none'
  return kind
}

/** 该形态的动画时长；无动画为 0，调用方据此跳过逐帧绘制。 */
export function turnDurationMs(kind: PageTurnKind): number {
  return kind === 'none' ? 0 : PAGE_TURN_MS
}

export interface TurnOffset {
  x: number
  y: number
}

/** 仿真卷页的折线参数：折线从哪条边起、折到哪、弯曲多少、阴影多宽。 */
export interface PageTurnCurl {
  edge: 'left' | 'right'
  /** 折线所在的 x（px） */
  foldX: number
  /** 折线的弯曲幅度（px），阴影沿折线画 */
  bulge: number
  /** 折线阴影宽度（px） */
  shadowWidth: number
}

export interface TurnFrame {
  kind: PageTurnKind
  direction: 1 | -1
  /** 原始进度，已钳制到 0–1 */
  progress: number
  /** 缓动后的进度，0–1 */
  eased: number
  /** 旧页绘制偏移 */
  from: TurnOffset
  /** 新页绘制偏移 */
  to: TurnOffset
  /** 仿真卷页参数；其它形态为 null */
  curl: PageTurnCurl | null
}

export interface TurnSize {
  width: number
  height: number
}

/** 缓出：开头快、结尾稳，避免翻页末尾拖沓。 */
function easeOut(progress: number): number {
  return 1 - (1 - progress) ** 3
}

const clampProgress = (value: number): number => {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 某一刻的两页位置；方向 1 为下一页、-1 为上一页，镜像展开。 */
export function pageTurnFrame(
  kind: PageTurnKind,
  direction: 1 | -1,
  progress: number,
  size: TurnSize,
): TurnFrame {
  const raw = clampProgress(progress)
  const eased = easeOut(raw)
  const dir = direction === -1 ? -1 : 1
  const width = Math.max(0, size.width)
  const height = Math.max(0, size.height)
  const frame: TurnFrame = {
    kind,
    direction: dir,
    progress: raw,
    eased,
    from: { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    curl: null,
  }
  if (kind === 'cover') {
    // 新页盖住旧页：旧页不动，新页从一侧滑进来
    frame.to.x = Math.round(dir * (1 - eased) * width)
    return frame
  }
  if (kind === 'slide') {
    // 平移：两页贴在一起同速移动
    frame.from.x = Math.round(-dir * eased * width)
    frame.to.x = Math.round(dir * (1 - eased) * width)
    return frame
  }
  if (kind === 'scroll') {
    // 滚动：两页沿纵向移动
    frame.from.y = Math.round(-dir * eased * height)
    frame.to.y = Math.round(dir * (1 - eased) * height)
    return frame
  }
  if (kind === 'simulate') {
    // 仿真：卷页折线随进度推进，幅度中段最大
    frame.curl = {
      edge: dir > 0 ? 'right' : 'left',
      foldX: Math.round(dir > 0 ? width * (1 - eased) : width * eased),
      bulge: Math.round(Math.sin(Math.PI * eased) * width * 0.08),
      shadowWidth: Math.round(width * 0.05 + Math.sin(Math.PI * eased) * width * 0.03),
    }
    return frame
  }
  return frame
}
/**
 * 阅读页配置：排版预设、页眉页脚、点击区域与动作。
 * 语义对齐「阅读」ReadBookConfig / ReadTipConfig / ClickActionConfigDialog，
 * 数值按 web 端可用范围收敛。
 */

export interface ReaderPreset {
  key: string
  name: string
  fontSize: number
  lineSpacing: number
  paragraphSpacing: number
  indent: number
  padding: { left: number; top: number; right: number; bottom: number }
}

/** 6 套预设：微信读书 + 预设 1~5（阅读的 readConfig.json 有 6 套）。 */
export const READER_PRESETS: ReaderPreset[] = [
  { key: 'wechat', name: '微信读书', fontSize: 24, lineSpacing: 1.8, paragraphSpacing: 6, indent: 2, padding: { left: 22, top: 5, right: 22, bottom: 4 } },
  { key: 'p1', name: '预设 1', fontSize: 22, lineSpacing: 1.6, paragraphSpacing: 4, indent: 2, padding: { left: 16, top: 4, right: 16, bottom: 4 } },
  { key: 'p2', name: '预设 2', fontSize: 20, lineSpacing: 1.5, paragraphSpacing: 0, indent: 2, padding: { left: 14, top: 4, right: 14, bottom: 4 } },
  { key: 'p3', name: '预设 3', fontSize: 26, lineSpacing: 1.9, paragraphSpacing: 8, indent: 2, padding: { left: 24, top: 6, right: 24, bottom: 6 } },
  { key: 'p4', name: '预设 4', fontSize: 18, lineSpacing: 1.6, paragraphSpacing: 4, indent: 2, padding: { left: 16, top: 4, right: 16, bottom: 4 } },
  { key: 'p5', name: '预设 5', fontSize: 28, lineSpacing: 2.0, paragraphSpacing: 10, indent: 2, padding: { left: 28, top: 8, right: 28, bottom: 8 } },
]

/** 点击动作：-1 无 + 阅读的 13 个动作（0~13）。 */
export interface TapAction {
  code: number
  label: string
  available: boolean
}

export const TAP_ACTIONS: TapAction[] = [
  { code: -1, label: '无', available: true },
  { code: 0, label: '菜单', available: true },
  { code: 1, label: '下一页', available: true },
  { code: 2, label: '上一页', available: true },
  { code: 3, label: '下一章', available: true },
  { code: 4, label: '上一章', available: true },
  { code: 5, label: '朗读上段', available: false },
  { code: 6, label: '朗读下段', available: false },
  { code: 7, label: '加书签', available: true },
  { code: 8, label: '正文编辑', available: false },
  { code: 9, label: '替换开关', available: false },
  { code: 10, label: '目录', available: true },
  { code: 11, label: '全文搜索', available: false },
  { code: 12, label: '同步进度', available: false },
  { code: 13, label: '朗读暂停', available: true },
]

export const tapActionLabel = (code: number): string =>
  TAP_ACTIONS.find((action) => action.code === code)?.label ?? '无'

/** 九宫格默认：TL2 TC2 TR1 / ML2 MC0 MR1 / BL2 BC1 BR2（阅读 AppConfig 默认）。 */
export const DEFAULT_TAP_ZONES: number[] = [2, 2, 1, 2, 0, 1, 2, 1, 2]

export const TAP_ZONE_NAMES = ['左上', '上中', '右上', '左中', '中间', '右中', '左下', '下中', '右下']

/** 按点击坐标比例取九宫格序号（0~8）。 */
export function tapZoneIndex(xRatio: number, yRatio: number): number {
  const col = xRatio < 1 / 3 ? 0 : xRatio < 2 / 3 ? 1 : 2
  const row = yRatio < 1 / 3 ? 0 : yRatio < 2 / 3 ? 1 : 2
  return row * 3 + col
}

/** 页眉页脚内容：与阅读 ReadTipConfig.tipValues 对齐（12 项，含「无」）。 */
export interface TipMode {
  code: number
  label: string
}

export const TIP_MODES: TipMode[] = [
  { code: 0, label: '无' },
  { code: 1, label: '章节名' },
  { code: 2, label: '时间' },
  { code: 3, label: '电量' },
  { code: 4, label: '页码' },
  { code: 5, label: '总进度' },
  { code: 6, label: '页码/总页' },
  { code: 7, label: '书名' },
  { code: 8, label: '时间+电量' },
  { code: 9, label: '时间+电量%' },
  { code: 10, label: '电量%' },
  { code: 11, label: '阅读进度' },
]

export interface TipContext {
  bookName: string
  chapterTitle: string
  page: number
  totalPages: number
  /** 全书进度百分比 0~100 */
  bookPercent: number
  /** 当前时间 HH:mm */
  time: string
  batteryPercent?: number
}

export function tipText(mode: number, ctx: TipContext): string {
  const battery = ctx.batteryPercent == null ? '—' : `${ctx.batteryPercent}%`
  switch (mode) {
    case 1:
      return ctx.chapterTitle
    case 2:
      return ctx.time
    case 3:
      return battery
    case 4:
      return String(ctx.page)
    case 5:
      return `${Math.round(ctx.bookPercent)}%`
    case 6:
      return `${ctx.page}/${ctx.totalPages}`
    case 7:
      return ctx.bookName
    case 8:
      return `${ctx.time} · ${battery}`
    case 9:
      return `${ctx.time} · ${battery}`
    case 10:
      return battery
    case 11:
      return `${Math.round(ctx.bookPercent)}%`
    default:
      return ''
  }
}

/** 底栏菜单项；设置里可勾选显示哪些。 */
export interface MenuItem {
  key: string
  label: string
}

export const MENU_ITEMS: MenuItem[] = [
  { key: 'prev', label: '上一章' },
  { key: 'settings', label: '设置' },
  { key: 'toc', label: '目录' },
  { key: 'next', label: '下一章' },
]

export const DEFAULT_MENU_ITEMS = MENU_ITEMS.map((item) => item.key)

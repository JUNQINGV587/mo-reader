/**
 * 阅读页主题：内置三套、用户自定义、Legado 兼容导入导出。
 * 只处理阅读页配色，不影响 App 整体换肤。
 */

export type BuiltinThemeName = 'light' | 'sepia' | 'dark'

export interface ThemeColors {
  bg: string
  text: string
  muted: string
  line: string
}

export interface BuiltinTheme extends ThemeColors {
  readonly name: string
}

export interface CustomTheme extends ThemeColors {
  id: string
  name: string
  createdAt: string
}

export const BUILTIN_THEME_NAMES: BuiltinThemeName[] = ['light', 'sepia', 'dark']

export const BUILTIN_THEMES: Record<BuiltinThemeName, BuiltinTheme> = {
  light: {
    name: '纸白',
    bg: '#f6f1e7',
    text: '#2b2a26',
    muted: '#7c7567',
    line: 'rgba(43,42,38,0.14)',
  },
  sepia: {
    name: '米黄',
    bg: '#f1e5c9',
    text: '#4a3b28',
    muted: '#8a7657',
    line: 'rgba(74,59,40,0.2)',
  },
  dark: {
    name: '夜读',
    bg: '#141518',
    text: '#d8d4c8',
    muted: '#8f897b',
    line: 'rgba(255,255,255,0.14)',
  },
}

export const FULL_THEME_FORMAT = 'mo-reader-themes'
export const FULL_THEME_VERSION = 1
const CUSTOM_ID = /^theme-[a-z0-9-]{6,64}$/i
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTION_COLOR = /^(?:rgb|rgba)\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i

export function isBuiltinThemeName(value: unknown): value is BuiltinThemeName {
  return value === 'light' || value === 'sepia' || value === 'dark'
}

function intToCss(value: number): string {
  const unsigned = value >>> 0
  const alpha = unsigned >>> 24
  const rgb = (unsigned & 0xffffff).toString(16).padStart(6, '0')
  return alpha === 255 ? `#${rgb}` : `#${alpha.toString(16).padStart(2, '0')}${rgb}`
}

/** 把 Legado 的 Android 颜色整数或常见 CSS 颜色统一成可写入画布的颜色。 */
export function normalizeColor(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value === 0) throw new Error('颜色不能为透明')
    return intToCss(value)
  }
  if (typeof value !== 'string') throw new Error('颜色必须是字符串')
  const input = value.trim()
  if (!input) throw new Error('颜色不能为空')
  if (/^-?\d+$/.test(input)) {
    const numeric = Number(input)
    if (numeric === 0) throw new Error('颜色不能为透明')
    return intToCss(numeric)
  }
  if (/^0x[0-9a-f]{1,8}$/i.test(input)) return intToCss(Number.parseInt(input.slice(2), 16))
  if (HEX_COLOR.test(input)) {
    if (input.length === 4) {
      return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}`
    }
    if (input.length === 5) {
      return `#${input[1]}${input[1]}${input[2]}${input[2]}${input[3]}${input[3]}${input[4]}${input[4]}`
    }
    return input.toLowerCase()
  }
  if (FUNCTION_COLOR.test(input)) return input
  throw new Error(`颜色格式不正确：${value}`)
}

/** color input 只接受 #rrggbb，把 rgba 等值近似转换成十六进制。 */
export function toHexColor(value: string, fallback = '#000000'): string {
  try {
    const normalized = normalizeColor(value)
    if (/^#[0-9a-f]{6}$/i.test(normalized)) return normalized
    if (/^#[0-9a-f]{8}$/i.test(normalized)) return normalized.slice(0, 7)
    const match = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
    if (match) {
      const hex = [match[1], match[2], match[3]]
        .map((item) => Math.max(0, Math.min(255, Number(item))).toString(16).padStart(2, '0'))
        .join('')
      return `#${hex}`
    }
  } catch {
    // 使用回退色
  }
  return fallback
}

export function isDarkColor(value: string): boolean {
  const hex = toHexColor(value, '#ffffff')
  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return (red * 299 + green * 587 + blue * 114) / 1000 < 128
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('主题名称缺失')
  const name = value.trim().replace(/[\u0000-\u001f]/g, '')
  if (!name) throw new Error('主题名称不能为空')
  return name.slice(0, 32)
}

function makeId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
  return `theme-${random.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}`
}

export function createCustomTheme(
  input: { name: unknown; bg: unknown; text: unknown; muted?: unknown; line?: unknown },
  options: { id?: unknown; createdAt?: unknown } = {},
): CustomTheme {
  const id = typeof options.id === 'string' && CUSTOM_ID.test(options.id) ? options.id : makeId()
  const createdAt =
    typeof options.createdAt === 'string' && !Number.isNaN(Date.parse(options.createdAt))
      ? new Date(options.createdAt).toISOString()
      : new Date().toISOString()
  return {
    id,
    name: cleanName(input.name),
    bg: normalizeColor(input.bg),
    text: normalizeColor(input.text),
    muted: normalizeColor(input.muted ?? input.text),
    line: normalizeColor(input.line ?? input.muted ?? input.text),
    createdAt,
  }
}

export function resolveThemeColors(
  themeId: string,
  customThemes: CustomTheme[] = [],
): ThemeColors {
  if (isBuiltinThemeName(themeId)) return BUILTIN_THEMES[themeId]
  if (themeId === 'system') return BUILTIN_THEMES.light
  const custom = customThemes.find((theme) => theme.id === themeId)
  if (!custom) return BUILTIN_THEMES.light
  return { bg: custom.bg, text: custom.text, muted: custom.muted, line: custom.line }
}

export function resolveThemeName(themeId: string, customThemes: CustomTheme[] = []): string {
  if (isBuiltinThemeName(themeId)) return BUILTIN_THEMES[themeId].name
  if (themeId === 'system') return BUILTIN_THEMES.light.name
  return customThemes.find((theme) => theme.id === themeId)?.name ?? BUILTIN_THEMES.light.name
}

export function isKnownTheme(themeId: string, customThemes: CustomTheme[] = []): boolean {
  return (
    themeId === 'system' ||
    isBuiltinThemeName(themeId) ||
    customThemes.some((theme) => theme.id === themeId)
  )
}

function pickColor(item: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key]
  }
  return undefined
}

function itemToCustomTheme(
  item: Record<string, unknown>,
  usedIds: Set<string>,
): CustomTheme {
  const name = pickColor(item, ['name', 'themeName', 'title'])
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少主题名称 themeName')
  const bg = pickColor(item, ['bg', 'background', 'backgroundColor', 'pageBackground'])
  if (bg === undefined) throw new Error('缺少背景色 background')
  const text = pickColor(item, ['text', 'textColor', 'contentColor', 'foreground'])
  if (text === undefined) throw new Error('缺少正文色 textColor')
  const muted = pickColor(item, ['muted', 'textAccentColor', 'secondaryTextColor'])
  const line = pickColor(item, ['line', 'dividerColor', 'lineColor'])
  let id = typeof item.id === 'string' && CUSTOM_ID.test(item.id) ? item.id : makeId()
  while (usedIds.has(id)) id = makeId()
  usedIds.add(id)
  return createCustomTheme(
    { name, bg, text, muted, line },
    { id, createdAt: item.createdAt },
  )
}

export interface ThemeImportResult {
  themes: CustomTheme[]
  source: 'mo-reader' | 'legado'
}

function unwrapThemes(parsed: unknown): { list: unknown[]; source: ThemeImportResult['source'] } {
  if (Array.isArray(parsed)) return { list: parsed, source: 'legado' }
  if (!parsed || typeof parsed !== 'object') throw new Error('主题文件必须是 JSON 对象或数组')
  const object = parsed as Record<string, unknown>
  if (object.format === FULL_THEME_FORMAT) {
    if (!Array.isArray(object.themes)) throw new Error('全量主题文件缺少 themes 数组')
    return { list: object.themes, source: 'mo-reader' }
  }
  if (Array.isArray(object.themes)) return { list: object.themes, source: 'mo-reader' }
  if (Array.isArray(object.themeConfig)) return { list: object.themeConfig, source: 'legado' }
  if (object.themeConfig && typeof object.themeConfig === 'object') {
    return { list: [object.themeConfig], source: 'legado' }
  }
  if (object.themeName || object.name) return { list: [object], source: 'legado' }
  throw new Error('没有找到可导入的主题，支持 Legado themeConfig 或墨读全量 JSON')
}

/** 一次解析整个文件；任意一项失败都整体拒绝，不产生半成品。 */
export function parseThemeImport(text: string): ThemeImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('主题文件不是有效 JSON')
  }
  const { list, source } = unwrapThemes(parsed)
  if (list.length === 0) throw new Error('主题文件里没有主题')
  if (list.length > 100) throw new Error('一次最多导入 100 个主题')
  const usedIds = new Set<string>()
  const themes: CustomTheme[] = []
  const errors: string[] = []
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`第 ${index + 1} 个主题不是对象`)
      return
    }
    try {
      themes.push(itemToCustomTheme(raw as Record<string, unknown>, usedIds))
    } catch (error) {
      errors.push(`第 ${index + 1} 个主题：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  if (errors.length) throw new Error(`主题导入失败，未写入任何主题：${errors.slice(0, 3).join('；')}`)
  return { themes, source }
}

export function exportLegadoThemes(themes: CustomTheme[]): Record<string, unknown>[] {
  return themes.map((theme) => ({
    themeName: theme.name,
    textColor: theme.text,
    textAccentColor: theme.muted,
    background: theme.bg,
    isNightTheme: isDarkColor(theme.bg),
  }))
}

export function exportFullThemes(themes: CustomTheme[]): Record<string, unknown> {
  return {
    format: FULL_THEME_FORMAT,
    version: FULL_THEME_VERSION,
    exportedAt: new Date().toISOString(),
    themes,
  }
}

/** 校验服务端保存的自定义主题数组，保证设置里不会出现半成品。 */
export function normalizeCustomThemes(value: unknown): CustomTheme[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('自定义主题必须是数组')
  if (value.length > 100) throw new Error('自定义主题最多 100 个')
  const usedIds = new Set<string>()
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`第 ${index + 1} 个自定义主题格式不正确`)
    const source = item as Record<string, unknown>
    try {
      const theme = createCustomTheme(
        { name: source.name, bg: source.bg, text: source.text, muted: source.muted, line: source.line },
        { id: source.id, createdAt: source.createdAt },
      )
      if (usedIds.has(theme.id)) throw new Error('主题 ID 重复')
      usedIds.add(theme.id)
      return theme
    } catch (error) {
      throw new Error(`第 ${index + 1} 个自定义主题：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

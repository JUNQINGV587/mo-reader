/**
 * 阅读设置：默认值、校验、全局与每书覆盖、预设补丁。
 *
 * 这里只有纯函数，不碰存储与界面；服务端、阅读页和设置面板共用同一份契约。
 * 设置分两层：全局设置（storage 的 global）与每书覆盖（read_configs 表，只存改过的字段）。
 */
import {
  DEFAULT_MENU_ITEMS,
  DEFAULT_TAP_ZONES,
  MENU_ITEMS,
  READER_PRESETS,
  sanitizeTapZones,
  type ReaderPreset,
} from './reader-config.js'
import { createCustomTheme, isKnownTheme, type CustomTheme } from './theme.js'

export type ReaderAlign = 'left' | 'justify'

export type ReaderPageAnimation = 'none' | 'cover' | 'slide' | 'simulate' | 'scroll'

/** 书架皮肤：封面网格 / 简洁列表；只保存在全局层。 */
export type ShelfSkin = 'grid' | 'list'

export interface ReaderPadding {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ReaderReplaceRule {
  id: string
  pattern: string
  replacement: string
  regex: boolean
  enabled: boolean
}

/** 阅读页可用到的全部设置；全局层存全量，每书覆盖层只存子集。 */
export interface ReaderSettings {
  fontId: string
  fontFamily: string
  fontSize: number
  letterSpacing: number
  lineSpacing: number
  paragraphSpacing: number
  indent: number
  bold: boolean
  titleMode: number
  titleSize: number
  align: ReaderAlign
  compressPunctuation: boolean
  kinsoku: boolean
  theme: string
  customThemes: CustomTheme[]
  padding: ReaderPadding
  headerMode: number
  footerMode: number
  showHeaderLine: boolean
  showFooterLine: boolean
  dualColumn: boolean
  inkMode: boolean
  pageAnimation: ReaderPageAnimation
  tapZones: number[]
  menuItems: string[]
  autoPageSeconds: number
  ttsVoice: string
  ttsRate: number
  ttsContinuous: boolean
  replaceRules: ReaderReplaceRule[]
  /** 媒体缓存配额（字节）；只保存在全局层。 */
  mediaQuotaBytes: number
  /** 书架皮肤；只保存在全局层，默认封面网格。 */
  shelfSkin: ShelfSkin
}

/** 每书覆盖层可以改的字段；主题只存 id，自定义主题列表与媒体配额属于全局。 */
export const BOOK_OVERRIDE_FIELDS = [
  'fontId', 'fontFamily', 'fontSize', 'letterSpacing', 'lineSpacing',
  'paragraphSpacing', 'indent', 'bold', 'titleMode', 'titleSize', 'align',
  'compressPunctuation', 'kinsoku', 'theme', 'padding', 'headerMode', 'footerMode',
  'showHeaderLine', 'showFooterLine', 'dualColumn', 'inkMode', 'pageAnimation',
  'tapZones', 'menuItems', 'autoPageSeconds', 'ttsVoice', 'ttsRate',
  'ttsContinuous', 'replaceRules',
] as const satisfies readonly (keyof ReaderSettings)[]

export const READER_SETTING_FIELDS = [
  ...BOOK_OVERRIDE_FIELDS,
  'customThemes', 'mediaQuotaBytes', 'shelfSkin',
] as const satisfies readonly (keyof ReaderSettings)[]

export type SettingsGroupKey = 'layout' | 'page' | 'operate' | 'speak' | 'replace'

export interface SettingsGroup {
  key: SettingsGroupKey
  label: string
  fields: readonly (keyof ReaderSettings)[]
}

/** 设置面板分区：顺序即面板里的展示顺序。 */
export const READER_SETTING_GROUPS: SettingsGroup[] = [
  {
    key: 'layout',
    label: '排版',
    fields: [
      'fontId', 'fontFamily', 'fontSize', 'letterSpacing', 'lineSpacing',
      'paragraphSpacing', 'indent', 'bold', 'titleMode', 'titleSize', 'align',
      'compressPunctuation', 'kinsoku',
    ],
  },
  {
    key: 'page',
    label: '页面',
    fields: [
      'theme', 'customThemes', 'padding', 'headerMode', 'footerMode',
      'showHeaderLine', 'showFooterLine', 'dualColumn', 'inkMode', 'pageAnimation',
    ],
  },
  { key: 'operate', label: '操作', fields: ['tapZones', 'menuItems', 'autoPageSeconds'] },
  { key: 'speak', label: '朗读', fields: ['ttsVoice', 'ttsRate', 'ttsContinuous'] },
  { key: 'replace', label: '替换', fields: ['replaceRules'] },
]

export const READER_ALIGNS: ReaderAlign[] = ['left', 'justify']

export const READER_PAGE_ANIMATIONS: ReaderPageAnimation[] = ['none', 'cover', 'slide', 'simulate', 'scroll']

export const SHELF_SKINS: ShelfSkin[] = ['grid', 'list']

/** 一套全新的默认设置；每次返回独立副本，调用方可放心修改。 */
export function defaultReaderSettings(): ReaderSettings {
  const fallbackPreset = READER_PRESETS[0]!
  return {
    fontId: '',
    fontFamily: '',
    fontSize: fallbackPreset.fontSize,
    letterSpacing: 0,
    lineSpacing: fallbackPreset.lineSpacing,
    paragraphSpacing: fallbackPreset.paragraphSpacing,
    indent: fallbackPreset.indent,
    bold: false,
    titleMode: 0,
    titleSize: 4,
    align: 'left',
    compressPunctuation: true,
    kinsoku: true,
    theme: 'light',
    customThemes: [],
    padding: { ...fallbackPreset.padding },
    headerMode: 1,
    footerMode: 6,
    showHeaderLine: true,
    showFooterLine: true,
    dualColumn: false,
    inkMode: false,
    pageAnimation: 'cover',
    tapZones: [...DEFAULT_TAP_ZONES],
    menuItems: [...DEFAULT_MENU_ITEMS],
    autoPageSeconds: 10,
    ttsVoice: '',
    ttsRate: 1,
    ttsContinuous: true,
    replaceRules: [],
    mediaQuotaBytes: 0,
    shelfSkin: 'grid',
  }
}

export function defaultGroupSettings(group: SettingsGroupKey): Partial<ReaderSettings> {
  const defaults = defaultReaderSettings()
  const fields = READER_SETTING_GROUPS.find((item) => item.key === group)?.fields ?? []
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    // 自定义主题是用户资产，不属于「恢复本节默认」的重置范围
    if (field === 'customThemes') continue
    ;(patch as Record<string, unknown>)[field] = (defaults as unknown as Record<string, unknown>)[field]
  }
  return patch as Partial<ReaderSettings>
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const raw = numberOr(value, Number.NaN)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

const clampStep = (value: unknown, min: number, max: number, step: number, fallback: number): number => {
  const raw = numberOr(value, Number.NaN)
  if (!Number.isFinite(raw)) return fallback
  const bounded = Math.min(max, Math.max(min, raw))
  return Number((Math.round(bounded / step) * step).toFixed(2))
}

const stringOr = (value: unknown, fallback: string, maxLength: number): string =>
  typeof value === 'string' ? value.slice(0, maxLength) : fallback

const boolOr = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const enumOr = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

const indentOr = (value: unknown, fallback: number): number => {
  const raw = numberOr(value, Number.NaN)
  if (!Number.isFinite(raw)) return fallback
  return raw >= 1 ? 2 : 0
}

const normalizePadding = (value: unknown, fallback: ReaderPadding): ReaderPadding => {
  const source = isPlainObject(value) ? value : {}
  return {
    left: clampInt(source.left, 8, 48, fallback.left),
    top: clampInt(source.top, 0, 32, fallback.top),
    right: clampInt(source.right, 8, 48, fallback.right),
    bottom: clampInt(source.bottom, 0, 32, fallback.bottom),
  }
}

const normalizeTapZones = (value: unknown, fallback: number[]): number[] => {
  if (!Array.isArray(value) || value.length !== 9) return [...fallback]
  return value.map((zone, index) =>
    typeof zone === 'number' && Number.isInteger(zone)
      ? Math.min(13, Math.max(-1, zone))
      : fallback[index]!,
  )
}

const MENU_KEYS: Set<string> = new Set(MENU_ITEMS.map((item) => item.key))

const normalizeMenuItems = (value: unknown, fallback: string[]): string[] => {
  if (!Array.isArray(value)) return [...fallback]
  const known: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && MENU_KEYS.has(item) && !known.includes(item)) known.push(item)
  }
  return known.length > 0 ? known : [...fallback]
}

const normalizeReplaceRules = (value: unknown): ReaderReplaceRule[] => {
  if (!Array.isArray(value)) return []
  const rules: ReaderReplaceRule[] = []
  for (const item of value.slice(0, 500)) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' ? item.id : ''
    if (!id) continue
    rules.push({
      id,
      pattern: typeof item.pattern === 'string' ? item.pattern : '',
      replacement: typeof item.replacement === 'string' ? item.replacement : '',
      regex: boolOr(item.regex, false),
      enabled: boolOr(item.enabled, true),
    })
  }
  return rules
}

const normalizeCustomThemeList = (value: unknown): CustomTheme[] => {
  if (!Array.isArray(value)) return []
  const themes: CustomTheme[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, 100)) {
    if (!isPlainObject(item)) continue
    try {
      const theme = createCustomTheme(
        { name: item.name, bg: item.bg, text: item.text, muted: item.muted, line: item.line },
        { id: item.id, createdAt: item.createdAt },
      )
      if (ids.has(theme.id)) continue
      ids.add(theme.id)
      themes.push(theme)
    } catch {
      // 单个坏主题跳过，不让整份设置失效
    }
  }
  return themes
}

const withUnknownFields = <T extends object>(
  known: T,
  source: Record<string, unknown>,
  knownKeys: readonly string[],
): T => {
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!knownKeys.includes(key)) extra[key] = value
  }
  return Object.assign({}, known, extra) as T
}

export interface NormalizeReaderSettingsOptions {
  /** 额外认可的主题 id；内置主题与 system 始终认可。 */
  knownThemeIds?: readonly string[]
}

/** 把任意来源的设置归一成完整契约：缺的补默认、越界钳制、坏值回落，未知字段保留。 */
export function normalizeReaderSettings(
  input: unknown,
  options: NormalizeReaderSettingsOptions = {},
): ReaderSettings {
  const source = isPlainObject(input) ? input : {}
  const defaults = defaultReaderSettings()
  const customThemes = normalizeCustomThemeList(source.customThemes)
  const themeAllowed = (id: string): boolean =>
    options.knownThemeIds?.includes(id) === true || isKnownTheme(id, customThemes)
  const requestedTheme = stringOr(source.theme, defaults.theme, 80)
  const settings: ReaderSettings = {
    fontId: stringOr(source.fontId, defaults.fontId, 80),
    fontFamily: stringOr(source.fontFamily, defaults.fontFamily, 200),
    fontSize: clampInt(source.fontSize, 12, 48, defaults.fontSize),
    letterSpacing: clampStep(source.letterSpacing, 0, 4, 0.5, defaults.letterSpacing),
    lineSpacing: clampStep(source.lineSpacing, 1.2, 2.6, 0.1, defaults.lineSpacing),
    paragraphSpacing: clampInt(source.paragraphSpacing, 0, 24, defaults.paragraphSpacing),
    indent: indentOr(source.indent, defaults.indent),
    bold: boolOr(source.bold, defaults.bold),
    titleMode: clampInt(source.titleMode, 0, 3, defaults.titleMode),
    titleSize: clampInt(source.titleSize, 0, 8, defaults.titleSize),
    align: enumOr(source.align, READER_ALIGNS, defaults.align),
    compressPunctuation: boolOr(source.compressPunctuation, defaults.compressPunctuation),
    kinsoku: boolOr(source.kinsoku, defaults.kinsoku),
    theme: themeAllowed(requestedTheme) ? requestedTheme : defaults.theme,
    customThemes,
    padding: normalizePadding(source.padding, defaults.padding),
    headerMode: clampInt(source.headerMode, 0, 11, defaults.headerMode),
    footerMode: clampInt(source.footerMode, 0, 11, defaults.footerMode),
    showHeaderLine: boolOr(source.showHeaderLine, defaults.showHeaderLine),
    showFooterLine: boolOr(source.showFooterLine, defaults.showFooterLine),
    dualColumn: boolOr(source.dualColumn, defaults.dualColumn),
    inkMode: boolOr(source.inkMode, defaults.inkMode),
    pageAnimation: enumOr(source.pageAnimation, READER_PAGE_ANIMATIONS, defaults.pageAnimation),
    tapZones: normalizeTapZones(source.tapZones, defaults.tapZones),
    menuItems: normalizeMenuItems(source.menuItems, defaults.menuItems),
    autoPageSeconds: clampInt(source.autoPageSeconds, 1, 60, defaults.autoPageSeconds),
    ttsVoice: stringOr(source.ttsVoice, defaults.ttsVoice, 400),
    ttsRate: clampStep(source.ttsRate, 0.5, 2, 0.1, defaults.ttsRate),
    ttsContinuous: boolOr(source.ttsContinuous, defaults.ttsContinuous),
    replaceRules: normalizeReplaceRules(source.replaceRules),
    mediaQuotaBytes: clampInt(source.mediaQuotaBytes, 0, Number.MAX_SAFE_INTEGER, defaults.mediaQuotaBytes),
    shelfSkin: enumOr(source.shelfSkin, SHELF_SKINS, defaults.shelfSkin),
  }
  return withUnknownFields(settings, source, READER_SETTING_FIELDS)
}

const STRING_SETTING_FIELDS = ['fontId', 'fontFamily', 'theme', 'ttsVoice']
const BOOLEAN_SETTING_FIELDS = [
  'bold', 'compressPunctuation', 'kinsoku', 'showHeaderLine', 'showFooterLine',
  'dualColumn', 'inkMode', 'ttsContinuous',
]
const NUMBER_SETTING_FIELDS = [
  'fontSize', 'letterSpacing', 'lineSpacing', 'paragraphSpacing', 'indent', 'titleMode',
  'titleSize', 'headerMode', 'footerMode', 'autoPageSeconds', 'ttsRate', 'mediaQuotaBytes',
]
const ENUM_SETTING_FIELDS: Record<string, readonly string[]> = {
  align: READER_ALIGNS,
  pageAnimation: READER_PAGE_ANIMATIONS,
  shelfSkin: SHELF_SKINS,
}

/** 校验 patch 里某个字段是否可归一；不可归一的字段直接不写，避免坏值覆盖旧值。 */
const canNormalizePatchField = (
  key: string,
  value: unknown,
  customThemeIds: ReadonlySet<string>,
): boolean => {
  if (STRING_SETTING_FIELDS.includes(key)) {
    if (key !== 'theme') return typeof value === 'string'
    return typeof value === 'string' && (isKnownTheme(value, []) || customThemeIds.has(value))
  }
  if (BOOLEAN_SETTING_FIELDS.includes(key)) return typeof value === 'boolean'
  if (NUMBER_SETTING_FIELDS.includes(key)) return typeof value === 'number' && Number.isFinite(value)
  if (key in ENUM_SETTING_FIELDS) {
    return typeof value === 'string' && (ENUM_SETTING_FIELDS[key] as readonly string[]).includes(value)
  }
  if (key === 'padding') return isPlainObject(value)
  // 九宫格只接受本切片支持的动作；隐藏动作与越界值一律不写入，旧值保留。
  if (key === 'tapZones') return Array.isArray(value) && value.length === 9 && !sanitizeTapZones(value).changed
  if (key === 'menuItems') {
    return Array.isArray(value) && value.some((item) => typeof item === 'string' && MENU_KEYS.has(item))
  }
  if (key === 'replaceRules' || key === 'customThemes') return Array.isArray(value)
  return false
}

/**
 * 只归一 patch 里出现、且值可用的字段；用于保存，避免把未提交的字段一起写回，
 * 也避免一个坏值把已有设置改成默认值。
 */
export function normalizeReaderSettingsPatch(
  input: unknown,
  options: NormalizeReaderSettingsOptions = {},
): Partial<ReaderSettings> {
  const source = isPlainObject(input) ? input : {}
  const full = normalizeReaderSettings(source, options)
  const customThemeIds = new Set(
    (options.knownThemeIds ?? []).concat(normalizeCustomThemeList(source.customThemes).map((theme) => theme.id)),
  )
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!(READER_SETTING_FIELDS as readonly string[]).includes(key)) {
      patch[key] = value
      continue
    }
    if (!canNormalizePatchField(key, value, customThemeIds)) continue
    patch[key] =
      key === 'theme'
        ? value
        : (full as unknown as Record<string, unknown>)[key]
  }
  return patch as Partial<ReaderSettings>
}

const BOOK_RECORD_META = new Set(['id', 'bookId', 'createdAt', 'updatedAt'])

/** 读取每书覆盖记录：去掉记录元信息，只留改过的字段和未知字段。 */
export function normalizeBookOverrides(
  record: unknown,
  options: NormalizeReaderSettingsOptions = {},
): Partial<ReaderSettings> {
  const source = isPlainObject(record) ? record : {}
  const patchSource: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!BOOK_RECORD_META.has(key)) patchSource[key] = value
  }
  const patch = normalizeReaderSettingsPatch(patchSource, options)
  // 旧覆盖记录里的九宫格可能含已隐藏动作：读取时收敛为「无动作」，避免意外翻页。
  if (Array.isArray(patchSource.tapZones) && patchSource.tapZones.length === 9) {
    patch.tapZones = sanitizeTapZones(patchSource.tapZones).zones
  }
  // 自定义主题列表、媒体配额与书架皮肤只存在全局层，旧覆盖记录里出现的也丢弃
  delete (patch as Record<string, unknown>).customThemes
  delete (patch as Record<string, unknown>).mediaQuotaBytes
  delete (patch as Record<string, unknown>).shelfSkin
  return patch
}

export function hasBookOverrides(record: unknown): boolean {
  return Object.keys(normalizeBookOverrides(record)).length > 0
}

export function mergeReaderSettings(globalInput: unknown, overridesInput: unknown): ReaderSettings {
  const base = normalizeReaderSettings(globalInput)
  const overrides = normalizeBookOverrides(overridesInput, {
    knownThemeIds: base.customThemes.map((theme) => theme.id),
  })
  const result: ReaderSettings = { ...base, padding: { ...base.padding } }
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'padding') {
      result.padding = normalizePadding(value, base.padding)
      continue
    }
    ;(result as unknown as Record<string, unknown>)[key] = value
  }
  return result
}

const deepEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}

/** 逐字段比较两组设置，返回变化的字段；用于“本书只写改动字段”。 */
export function diffReaderSettings(
  previous: unknown,
  next: unknown,
): Partial<ReaderSettings> {
  const before = normalizeReaderSettings(previous)
  const after = normalizeReaderSettings(next)
  const patch: Partial<ReaderSettings> = {}
  for (const field of READER_SETTING_FIELDS) {
    if (!deepEqual(before[field], after[field])) {
      ;(patch as unknown as Record<string, unknown>)[field] = after[field]
    }
  }
  return patch
}

/** 预设只写排版与页面字段，不改点击区、底栏、朗读和替换。 */
export function presetSettingsPatch(preset: ReaderPreset): Partial<ReaderSettings> {
  return {
    fontSize: preset.fontSize,
    lineSpacing: preset.lineSpacing,
    paragraphSpacing: preset.paragraphSpacing,
    indent: preset.indent,
    padding: { ...preset.padding },
  }
}

export function settingsGroup(key: SettingsGroupKey): SettingsGroup | undefined {
  return READER_SETTING_GROUPS.find((group) => group.key === key)
}

export { MENU_ITEMS, READER_PRESETS }
export type { ReaderPreset }

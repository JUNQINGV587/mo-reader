import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { DEFAULT_MENU_ITEMS, DEFAULT_TAP_ZONES, MENU_ITEMS } from '../core/reader/reader-config.js'
import { READER_ALIGNS, READER_PAGE_ANIMATIONS, SHELF_SKINS } from '../core/reader/settings.js'

/** 旧记录里的越界数字读时先夹到合法范围；类型不对则交给 zod 默认值。 */
const clampNumber = (min: number, max: number, integer = false) => (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const next = Math.min(max, Math.max(min, value))
  return integer ? Math.round(next) : next
}

const pickBoolean = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

const pickIndent = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? (value >= 1 ? 2 : 0) : undefined

/** 不在允许表里的枚举值回落默认，避免旧记录整条校验失败。 */
const pickEnum = <T extends string>(allowed: readonly T[], fallback: T) => (value: unknown): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback

/** 点击区必须是 9 项；缺项/坏项按九宫格默认值补齐，越界项夹到 -1..13。 */
const pickTapZones = (value: unknown): number[] => {
  if (!Array.isArray(value) || value.length !== 9) return DEFAULT_TAP_ZONES
  return value.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item)) return DEFAULT_TAP_ZONES[index]
    return Math.min(13, Math.max(-1, Math.round(item)))
  })
}

/** 底栏按钮只保留已知项；一个都不认识时回落默认四项。 */
const pickMenuItems = (value: unknown): string[] => {
  const known = MENU_ITEMS.map((item) => item.key)
  if (!Array.isArray(value)) return DEFAULT_MENU_ITEMS
  const filtered = [...new Set(value.filter((item): item is string => typeof item === 'string' && known.includes(item)))]
  return filtered.length > 0 ? filtered : DEFAULT_MENU_ITEMS
}

const identified = z.object({ id: z.string().min(1).max(4096) }).passthrough()

/** 搜索作业里被跳过的书源；只存在于 kind=search 的作业记录。 */
const jobSkippedSource = z
  .object({
    bookSourceUrl: z.string().max(8192).default(''),
    sourceName: z.string().max(4096).default(''),
    reason: z.string().max(4096).default(''),
  })
  .passthrough()

const jobRecordObject = z
  .object({
    id: z.string().min(1).max(4096),
    kind: z.string().min(1).max(80).default('download'),
    bookId: z.string().max(4096).default(''),
    bookName: z.string().max(4096).default(''),
    status: z.enum(['queued', 'running', 'paused', 'done', 'failed', 'cancelled']).default('queued'),
    fromIndex: z.number().int().min(0).default(0),
    toIndex: z.number().int().min(0).default(0),
    all: z.boolean().default(false),
    total: z.number().int().min(0).default(0),
    completed: z.number().int().min(0).default(0),
    failed: z.number().int().min(0).default(0),
    skipped: z.number().int().min(0).default(0),
    skippedSources: z.array(jobSkippedSource).optional(),
    bytes: z.number().int().min(0).default(0),
    error: z.string().max(4096).default(''),
    createdAt: z.number().int().min(0).default(0),
    updatedAt: z.number().int().min(0).default(0),
  })
  .passthrough()

/**
 * 旧搜索作业把跳过源存在 skipped 数组里，和下载作业的 skipped 数字冲突（#151 的遗留记录）。
 * 读盘时迁到 skippedSources，避免一条旧记录让整个 mo_reader 域无法激活。
 */
function migrateJobRecord(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.skipped)) return value
  const { skipped, ...rest } = record
  return {
    ...rest,
    skipped: 0,
    skippedSources: Array.isArray(rest.skippedSources) ? rest.skippedSources : skipped,
  }
}

/** 下载/导出等后台作业：服务重启后据它恢复暂停态，故记录需带完整进度字段。 */
const jobRecord = z.preprocess(migrateJobRecord, jobRecordObject)

/**
 * 已下载章节的索引：只记「哪一章、多少字节、什么时候下的」，正文仍只在文字缓存文件里。
 * key 由 bookId + 章序号派生（见 download.ts 的 downloadEntryKey），一书记录数 = 已下载章数。
 */
const downloadEntry = z
  .object({
    id: z.string().min(1).max(4096),
    bookId: z.string().min(1).max(4096),
    chapterIndex: z.number().int().min(0).default(0),
    chapterUrl: z.string().min(1).max(8192),
    chapterTitle: z.string().max(4096).default(''),
    sourceUrl: z.string().max(8192).default(''),
    bytes: z.number().int().min(0).default(0),
    createdAt: z.number().int().min(0).default(0),
    updatedAt: z.number().int().min(0).default(0),
  })
  .passthrough()

/** 媒体条目里的单个文件：路径相对媒体缓存根，id 是下发给前端的不可猜测短摘要。 */
const mediaFile = z
  .object({
    id: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    mime: z.string().max(200).default(''),
    bytes: z.number().int().min(0).default(0),
    path: z.string().min(1).max(8192),
  })
  .passthrough()

/**
 * 已下载媒体的索引（#112）：漫画一章一条（files 多张图），音视频一章一条（files 一个）。
 * key 由 bookId + 章序号派生（见 media-cache.ts 的 mediaEntryKey）；
 * 只有整章文件全部落盘后 service 才写入本表，因此「有索引」即「可离线播放」。
 */
const mediaEntry = z
  .object({
    id: z.string().min(1).max(4096),
    bookId: z.string().min(1).max(4096),
    chapterIndex: z.number().int().min(0).default(0),
    chapterUrl: z.string().min(1).max(8192),
    chapterTitle: z.string().max(4096).default(''),
    sourceUrl: z.string().max(8192).default(''),
    kind: z.enum(['image', 'audio', 'video']),
    mime: z.string().max(200).default(''),
    bytes: z.number().int().min(0).default(0),
    files: z.array(mediaFile).default([]),
    createdAt: z.number().int().min(0).default(0),
    updatedAt: z.number().int().min(0).default(0),
  })
  .passthrough()

/**
 * 墨读的新领域：与旧实现的 `reader` 域分开，避免旧记录过不了新 schema。
 * 旧数据按设计不迁移，书源/书架/进度在 M1 起重新导入。
 */
export const ReaderDomain = defineDomain({
  name: 'mo_reader',
  version: 1,
  layout: 'per-record',
  global: {
    schema: z
      .object({
        theme: z.string().min(1).max(80).default('light'),
        customThemes: z
          .array(
            z
              .object({
                id: z.string().min(1).max(80),
                name: z.string().min(1).max(32),
                bg: z.string().min(1).max(80),
                text: z.string().min(1).max(80),
                muted: z.string().min(1).max(80),
                line: z.string().min(1).max(80),
                createdAt: z.string().min(1).max(80),
              })
              .passthrough(),
          )
          .max(100)
          .default([]),
        fontId: z.string().max(80).default(''),
        fontFamily: z.string().max(200).default(''),
        fontSize: z.preprocess(clampNumber(12, 48, true), z.number().int().min(12).max(48).default(24)),
        letterSpacing: z.preprocess(clampNumber(0, 4), z.number().min(0).max(4).default(0)),
        lineSpacing: z.preprocess(clampNumber(1.2, 2.6), z.number().min(1.2).max(2.6).default(1.8)),
        paragraphSpacing: z.preprocess(clampNumber(0, 24, true), z.number().int().min(0).max(24).default(6)),
        indent: z.preprocess(pickIndent, z.number().int().min(0).max(2).default(2)),
        bold: z.preprocess(pickBoolean, z.boolean().default(false)),
        titleMode: z.preprocess(clampNumber(0, 3, true), z.number().int().min(0).max(3).default(0)),
        titleSize: z.preprocess(clampNumber(0, 8, true), z.number().int().min(0).max(8).default(4)),
        align: z.preprocess(pickEnum(READER_ALIGNS, 'left'), z.enum(['left', 'justify']).default('left')),
        compressPunctuation: z.preprocess(pickBoolean, z.boolean().default(true)),
        kinsoku: z.preprocess(pickBoolean, z.boolean().default(true)),
        padding: z
          .object({
            left: z.preprocess(clampNumber(8, 48, true), z.number().int().min(8).max(48).default(22)),
            top: z.preprocess(clampNumber(0, 32, true), z.number().int().min(0).max(32).default(5)),
            right: z.preprocess(clampNumber(8, 48, true), z.number().int().min(8).max(48).default(22)),
            bottom: z.preprocess(clampNumber(0, 32, true), z.number().int().min(0).max(32).default(4)),
          })
          .default({ left: 22, top: 5, right: 22, bottom: 4 }),
        pageAnimation: z.preprocess(
          pickEnum(READER_PAGE_ANIMATIONS, 'cover'),
          z.enum(['none', 'cover', 'slide', 'simulate', 'scroll']).default('cover'),
        ),
        headerMode: z.preprocess(clampNumber(0, 11, true), z.number().int().min(0).max(11).default(1)),
        footerMode: z.preprocess(clampNumber(0, 11, true), z.number().int().min(0).max(11).default(6)),
        showHeaderLine: z.preprocess(pickBoolean, z.boolean().default(true)),
        showFooterLine: z.preprocess(pickBoolean, z.boolean().default(true)),
        dualColumn: z.preprocess(pickBoolean, z.boolean().default(false)),
        inkMode: z.preprocess(pickBoolean, z.boolean().default(false)),
        tapZones: z.preprocess(
          pickTapZones,
          z.array(z.number().int().min(-1).max(13)).length(9).default(DEFAULT_TAP_ZONES),
        ),
        menuItems: z.preprocess(pickMenuItems, z.array(z.string()).default(DEFAULT_MENU_ITEMS)),
        replaceRules: z
          .array(
            z
              .object({
                id: z.string().min(1),
                pattern: z.string().default(''),
                replacement: z.string().default(''),
                regex: z.boolean().default(false),
                enabled: z.boolean().default(true),
              })
              .passthrough(),
          )
          .default([]),
        autoPageSeconds: z.preprocess(clampNumber(1, 60, true), z.number().int().min(1).max(60).default(10)),
        ttsVoice: z.string().max(400).default(''),
        ttsRate: z.preprocess(clampNumber(0.5, 2), z.number().min(0.5).max(2).default(1)),
        ttsContinuous: z.preprocess(pickBoolean, z.boolean().default(true)),
        /** 媒体缓存配额（字节）；0 表示跟随环境变量或默认 50GB。 */
        mediaQuotaBytes: z.preprocess(
          clampNumber(0, Number.MAX_SAFE_INTEGER, true),
          z.number().int().min(0).default(0),
        ),
        /** 书架皮肤（#140）：grid 封面网格 / list 简洁列表；只存在全局层。 */
        shelfSkin: z.preprocess(
          pickEnum(SHELF_SKINS, 'grid'),
          z.enum(['grid', 'list']).default('grid'),
        ),
        /** WebDAV 同步（#131）：地址、账号、密码只存服务端，读取设置时整组剔除。 */
        webdavUrl: z.string().max(2048).default(''),
        webdavUsername: z.string().max(200).default(''),
        webdavPassword: z.string().max(500).default(''),
        webdavAllowPrivate: z.preprocess(pickBoolean, z.boolean().default(false)),
      })
      .passthrough(),
    initial: {
      theme: 'light',
      customThemes: [],
      fontId: '',
      fontFamily: '',
      fontSize: 24,
      letterSpacing: 0,
      lineSpacing: 1.8,
      paragraphSpacing: 6,
      indent: 2,
      bold: false,
      titleMode: 0,
      titleSize: 4,
      align: 'left',
      compressPunctuation: true,
      kinsoku: true,
      padding: { left: 22, top: 5, right: 22, bottom: 4 },
      pageAnimation: 'cover',
      headerMode: 1,
      footerMode: 6,
      showHeaderLine: true,
      showFooterLine: true,
      dualColumn: false,
      inkMode: false,
      tapZones: DEFAULT_TAP_ZONES,
      menuItems: DEFAULT_MENU_ITEMS,
      autoPageSeconds: 10,
      ttsVoice: '',
      ttsRate: 1,
      ttsContinuous: true,
      replaceRules: [],
      mediaQuotaBytes: 0,
      shelfSkin: 'grid',
      webdavUrl: '',
      webdavUsername: '',
      webdavPassword: '',
      webdavAllowPrivate: false,
    },
  },
  tables: {
    books: domainTable(identified),
    chapters: domainTable(
      z.object({ id: z.string().min(1).max(4096), bookId: z.string().min(1).max(4096) }).passthrough(),
    ),
    sources: domainTable(identified),
    dict_rules: domainTable(identified),
    groups: domainTable(identified),
    notes: domainTable(identified),
    bookmarks: domainTable(identified),
    read_records: domainTable(identified),
    /** 每本书的设置覆盖层：只存本书改过的字段，读取时与全局设置深合并。 */
    read_configs: domainTable(
      z.object({ id: z.string().min(1).max(4096), bookId: z.string().min(1).max(4096) }).passthrough(),
    ),
    jobs: domainTable(jobRecord),
    download_entries: domainTable(downloadEntry),
    media_entries: domainTable(mediaEntry),
    subscriptions: domainTable(identified),
  },
})

export async function openReaderStorage(ctx: any) {
  const domain = await ctx.storageDomain.open(ReaderDomain)
  return {
    domain,
    books: domain.table('books'),
    chapters: domain.table('chapters'),
    sources: domain.table('sources'),
    dictRules: domain.table('dict_rules'),
    groups: domain.table('groups'),
    notes: domain.table('notes'),
    bookmarks: domain.table('bookmarks'),
    readRecords: domain.table('read_records'),
    readConfigs: domain.table('read_configs'),
    jobs: domain.table('jobs'),
    downloadEntries: domain.table('download_entries'),
    mediaEntries: domain.table('media_entries'),
    subscriptions: domain.table('subscriptions'),
    settings: domain.global,
  }
}

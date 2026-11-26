import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { DEFAULT_MENU_ITEMS, DEFAULT_TAP_ZONES } from '../core/reader/reader-config.js'

const identified = z.object({ id: z.string().min(1).max(4096) }).passthrough()

/** 下载/导出等后台作业：服务重启后据它恢复暂停态，故记录需带完整进度字段。 */
const jobRecord = z
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
    bytes: z.number().int().min(0).default(0),
    error: z.string().max(4096).default(''),
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
        fontSize: z.number().int().min(12).max(48).default(24),
        fontId: z.string().max(80).default(''),
        lineSpacing: z.number().min(1).max(3).default(1.8),
        paragraphSpacing: z.number().int().min(0).max(40).default(6),
        indent: z.number().int().min(0).max(2).default(2),
        padding: z
          .object({
            left: z.number().int().min(0).max(80).default(22),
            top: z.number().int().min(0).max(80).default(5),
            right: z.number().int().min(0).max(80).default(22),
            bottom: z.number().int().min(0).max(80).default(4),
          })
          .default({ left: 22, top: 5, right: 22, bottom: 4 }),
        pageAnimation: z.enum(['none', 'cover', 'slide', 'simulate', 'scroll']).default('cover'),
        headerMode: z.number().int().min(0).max(11).default(1),
        footerMode: z.number().int().min(0).max(11).default(6),
        showHeaderLine: z.boolean().default(true),
        showFooterLine: z.boolean().default(true),
        tapZones: z.array(z.number().int().min(-1).max(13)).length(9).default(DEFAULT_TAP_ZONES),
        menuItems: z.array(z.string()).default(DEFAULT_MENU_ITEMS),
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
      })
      .passthrough(),
    initial: {
      theme: 'light',
      customThemes: [],
      fontSize: 22,
      fontId: '',
      lineSpacing: 1.9,
      paragraphSpacing: 6,
      indent: 2,
      padding: { left: 22, top: 5, right: 22, bottom: 4 },
      pageAnimation: 'cover',
      headerMode: 1,
      footerMode: 6,
      showHeaderLine: true,
      showFooterLine: true,
      tapZones: DEFAULT_TAP_ZONES,
      menuItems: DEFAULT_MENU_ITEMS,
      replaceRules: [],
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
    jobs: domainTable(jobRecord),
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
    jobs: domain.table('jobs'),
    subscriptions: domain.table('subscriptions'),
    settings: domain.global,
  }
}

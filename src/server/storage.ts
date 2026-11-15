import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { DEFAULT_MENU_ITEMS, DEFAULT_TAP_ZONES } from '../core/reader/reader-config.js'

const identified = z.object({ id: z.string().min(1).max(4096) }).passthrough()

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
        theme: z.enum(['light', 'sepia', 'dark', 'system']).default('light'),
        fontSize: z.number().int().min(12).max(48).default(24),
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
      fontSize: 22,
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
    groups: domainTable(identified),
    notes: domainTable(identified),
    bookmarks: domainTable(identified),
    read_records: domainTable(identified),
    jobs: domainTable(identified),
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
    groups: domain.table('groups'),
    notes: domain.table('notes'),
    bookmarks: domain.table('bookmarks'),
    readRecords: domain.table('read_records'),
    jobs: domain.table('jobs'),
    subscriptions: domain.table('subscriptions'),
    settings: domain.global,
  }
}

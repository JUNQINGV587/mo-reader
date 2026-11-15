import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

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
        theme: z.enum(['light', 'dark', 'system']).default('system'),
        fontSize: z.number().int().min(12).max(48).default(24),
        lineSpacing: z.number().min(1).max(3).default(1.8),
      })
      .passthrough(),
    initial: { theme: 'system', fontSize: 24, lineSpacing: 1.8 },
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

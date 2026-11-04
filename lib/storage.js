import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { DEFAULT_SETTINGS } from './settings.js'

export { DEFAULT_SETTINGS } from './settings.js'

const record = shape => z.object(shape).passthrough()
const identified = record({ id: z.string().min(1).max(4096) })

export const ReaderDomain = defineDomain({
  name: 'reader',
  version: 1,
  layout: 'per-record',
  global: {
    schema: record({
      replacements: z.array(z.any()).max(200),
      autoDownloadNewChapters: z.boolean(),
      fontSize: z.number().min(12).max(48),
      lineHeight: z.number().min(1).max(3),
      fontFamily: z.string().min(1).max(100),
      readerTheme: z.string().min(1).max(50),
      ttsRate: z.number().min(0.5).max(4),
    }),
    initial: DEFAULT_SETTINGS,
  },
  tables: {
    sources: domainTable(identified),
    books: domainTable(identified),
    chapters: domainTable(record({ id: z.string().min(1).max(4096), bookId: z.string().min(1).max(4096) })),
    jobs: domainTable(identified),
    notes: domainTable(identified),
  },
})

export async function openReaderStorage(ctx) {
  const domain = await ctx.storageDomain.open(ReaderDomain)
  return {
    domain,
    sources: domain.table('sources'),
    books: domain.table('books'),
    chapters: domain.table('chapters'),
    jobs: domain.table('jobs'),
    notes: domain.table('notes'),
    settings: domain.global,
  }
}

export function entries(table) {
  return [...table.entries()].map(([, value]) => value)
}

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
      // Older profiles predate the motion settings; default every new key on
      // read so upgrading a profile never makes its stored global fail schema
      // validation (which would take the whole reader service down).
      mode: z.enum(['paged', 'scroll']).default(DEFAULT_SETTINGS.mode),
      flipStyle: z.enum(['slide', 'curl', 'flip', 'fade']).default(DEFAULT_SETTINGS.flipStyle).transform(value => value === 'curl' ? 'flip' : value),
      measureWidth: z.number().min(600).max(1200).default(DEFAULT_SETTINGS.measureWidth),
      animations: z.boolean().default(DEFAULT_SETTINGS.animations),
      motionQuality: z.enum(['auto', 'high', 'low']).default(DEFAULT_SETTINGS.motionQuality),
      ambience: z.enum(['full', 'paper', 'off']).default(DEFAULT_SETTINGS.ambience),
      reducedMotion: z.enum(['system', 'on', 'off']).default(DEFAULT_SETTINGS.reducedMotion),
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

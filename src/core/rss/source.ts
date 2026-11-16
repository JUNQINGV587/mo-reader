import { z } from 'zod'

/** Legado RssSource 的最小子集：RSS 2.0/Atom 直接抓取。 */
export const RssSourceSchema = z
  .object({
    sourceUrl: z.string().min(1),
    sourceName: z.string().min(1),
    sourceGroup: z.string().optional().default(''),
    sourceType: z.number().int().optional().default(0),
    enabled: z.boolean().optional().default(true),
    header: z.string().optional().default(''),
  })
  .passthrough()

export type RssSource = z.infer<typeof RssSourceSchema>

export function parseRssSource(input: unknown): RssSource {
  return RssSourceSchema.parse(input)
}

function normalizeList(input: unknown): unknown[] {
  if (typeof input === 'string') {
    const text = input.trim()
    if (!text) return []
    return normalizeList(JSON.parse(text))
  }
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (Array.isArray(record.sources)) return record.sources
    if (Array.isArray(record.rssSources)) return record.rssSources
    if (record.sourceUrl) return [record]
  }
  return []
}

export function parseRssSources(input: unknown): RssSource[] {
  return normalizeList(input).map((item) => parseRssSource(item))
}

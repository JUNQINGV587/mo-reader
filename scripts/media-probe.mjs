#!/usr/bin/env node
// M2 媒体源探针：node scripts/media-probe.mjs "快看漫画" "斗罗大陆"
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ReaderService } from '../dist/server/service.js'

const SOURCE_DIR = process.env.MO_READER_SOURCE_DIR ?? join(homedir(), '.dsh/storages/mo_reader/sources')
const want = process.argv[2] ?? '快看漫画'
const key = process.argv[3] ?? '斗罗大陆'

function table() {
  const map = new Map()
  return {
    entries: () => map.entries(),
    values: () => map.values(),
    keys: () => map.keys(),
    get: (k) => map.get(k),
    put: (k, v) => map.set(k, v),
    delete: (k) => map.delete(k),
    deleteMany: (keys) => { let n = 0; for (const k of keys) if (map.delete(k)) n += 1; return n },
  }
}
function makeDb() {
  const settings = { theme: 'system', fontSize: 24, lineSpacing: 1.8 }
  return {
    sources: table(), books: table(), chapters: table(), readRecords: table(), notes: table(),
    bookmarks: table(), subscriptions: table(), jobs: table(), groups: table(),
    settings: { get: () => ({ ...settings }), set: (next) => Object.assign(settings, next) },
  }
}

let source = null
for (const file of readdirSync(SOURCE_DIR)) {
  if (!file.endsWith('.json')) continue
  try {
    const raw = JSON.parse(readFileSync(join(SOURCE_DIR, file), 'utf8'))
    const s = raw.record ?? raw
    if (s?.bookSourceName === want) { source = { ...s, enabled: true }; break }
  } catch {}
}
if (!source) { console.log('未找到书源', want); process.exit(1) }

const service = Object.create(ReaderService.prototype)
service.db = makeDb()
await service.importSources({ payload: JSON.stringify([source]) })
console.log('书源', source.bookSourceName, 'type', source.bookSourceType)

const search = await service.searchBooks({ key, sourceUrls: [source.bookSourceUrl] }).catch((e) => ({ error: e }))
const books = search.books ?? []
console.log('搜索', books.length, books.slice(0, 3).map((b) => b.name))
if (!books.length) process.exit(0)
const book = books[0]
const info = await service.getBookInfo({ sourceUrl: source.bookSourceUrl, bookUrl: book.bookUrl }).catch((e) => ({ error: e }))
const infoBook = { ...book, ...(info.info ?? {}) }
const tocUrl = infoBook.tocUrl || infoBook.bookUrl
const toc = await service.getToc({ sourceUrl: source.bookSourceUrl, tocUrl }).catch((e) => ({ error: e }))
const chapters = (toc.chapters ?? []).filter((c) => !c.isVolume && c.url)
console.log('目录', toc.chapters?.length ?? 0, '可读章', chapters.length)
if (!chapters.length) process.exit(0)
const chapter = chapters[Math.min(chapters.length - 1, Math.floor(chapters.length / 3))]
const content = await service.getContent({ sourceUrl: source.bookSourceUrl, chapterUrl: chapter.url }).catch((e) => ({ error: e }))
console.log('章节', chapter.title)
console.log('kind', content.kind, 'images', content.images?.length ?? 0, 'mediaUrl', content.mediaUrl ?? '', 'chars', (content.content ?? '').length)
console.log('样例', JSON.stringify({ images: (content.images ?? []).slice(0, 3), mediaUrl: content.mediaUrl, error: content.error }))

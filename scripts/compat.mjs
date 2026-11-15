#!/usr/bin/env node
// 书源兼容矩阵探针：对公开书源跑 搜索 → 详情 → 目录 → 正文 四级链路，
// 记录每级耗时/错误/命中数，输出 .scratch/compat/report.json 与终端摘要。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ReaderService } from '../dist/server/service.js'

function table() {
  const map = new Map()
  return {
    entries: () => map.entries(),
    values: () => map.values(),
    keys: () => map.keys(),
    get: (key) => map.get(key),
    put: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    deleteMany: (keys) => {
      let n = 0
      for (const key of keys) if (map.delete(key)) n += 1
      return n
    },
  }
}

function makeDb() {
  const settings = { theme: 'system', fontSize: 24, lineSpacing: 1.8 }
  return {
    sources: table(),
    books: table(),
    chapters: table(),
    readRecords: table(),
    settings: { get: () => ({ ...settings }), set: (next) => Object.assign(settings, next) },
  }
}

const file = process.argv[2]
if (!file) {
  console.error('用法: node scripts/compat.mjs <bookSource.json> [索引,...] [关键词]')
  process.exit(1)
}
const parsed = JSON.parse(readFileSync(file, 'utf8'))
const all = Array.isArray(parsed) ? parsed : (parsed.bookSources ?? [parsed])
const wanted = process.argv[3]
  ? process.argv[3].split(',').map((n) => Number(n.trim()))
  : all.map((_, i) => i)
const key = process.argv[4] ?? '剑来'

const service = Object.create(ReaderService.prototype)
service.db = makeDb()
await service.importSources({ payload: JSON.stringify(all) })

async function stage(fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { ok: true, ms: Date.now() - started, value }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

async function probe(index) {
  const source = all[index]
  // 公开源包里不少源默认 enabled=false；矩阵按启用状态测。
  if (source?.bookSourceUrl) {
    service.db.sources.put(source.bookSourceUrl, { ...source, id: source.bookSourceUrl, enabled: true })
  }
  const out = {
    index,
    name: source?.bookSourceName ?? `#${index}`,
    url: source?.bookSourceUrl ?? '',
    search: null,
    info: null,
    toc: null,
    content: null,
  }

  const search = await stage(() => service.searchBooks({ key, sourceUrls: [out.url] }))
  out.search = { ok: search.ok, ms: search.ms }
  if (!search.ok) {
    out.search.error = search.error
    return out
  }
  if (search.value.errors.length) {
    out.search.ok = false
    out.search.error = search.value.errors[0].message
    return out
  }
  const books = search.value.books
  out.search.count = books.length
  const book = books[0]
  if (!book) return out
  out.book = { name: book.name, author: book.author, bookUrl: book.bookUrl, coverUrl: book.coverUrl }

  const info = await stage(() => service.getBookInfo({ sourceUrl: out.url, bookUrl: book.bookUrl }))
  out.info = { ok: info.ok, ms: info.ms }
  if (info.ok) out.info.fields = Object.keys(info.value.info ?? {})
  else out.info.error = info.error

  const tocUrl = info.ok ? (info.value.info?.tocUrl ?? book.bookUrl) : book.bookUrl
  const toc = await stage(() => service.getToc({ sourceUrl: out.url, tocUrl }))
  out.toc = { ok: toc.ok, ms: toc.ms }
  if (!toc.ok) {
    out.toc.error = toc.error
    return out
  }
  const chapters = (toc.value.chapters ?? []).filter((c) => c.url)
  out.toc.count = chapters.length
  if (!chapters.length) return out

  // 首章常是「感言/公告」空章：依次试首章、第二章、中间章、末章，取正文最长的一个。
  const candidates = [...new Set([0, 1, Math.floor(chapters.length / 2), chapters.length - 1])]
    .filter((index) => index >= 0 && index < chapters.length)
    .map((index) => ({ index, chapter: chapters[index] }))
  const tried = []
  let best = null
  for (const { index, chapter } of candidates) {
    const content = await stage(() => service.getContent({ sourceUrl: out.url, chapterUrl: chapter.url }))
    tried.push({ index, ok: content.ok, ms: content.ms })
    if (!content.ok) continue
    const text = String(content.value.content ?? '')
    const attempt = { ok: true, ms: content.ms, index, title: chapter.title, length: text.length, preview: text.slice(0, 60) }
    if (!best || attempt.length > best.length) best = attempt
    if (best.length >= 200) break
  }
  out.content = best ? { ...best, tried } : { ok: false, ms: 0, tried }
  return out
}

const results = await Promise.all(wanted.map((index) => probe(index)))
mkdirSync('.scratch/compat', { recursive: true })
writeFileSync(
  '.scratch/compat/report.json',
  JSON.stringify({ at: new Date().toISOString(), key, results }, null, 2),
)
for (const r of results) {
  const parts = [
    `${r.index} ${r.name}`,
    r.search?.ok ? `搜索 ${r.search.count} 本 ${r.search.ms}ms` : `搜索失败 ${r.search?.error ?? '?'}`,
  ]
  if (r.info) parts.push(r.info.ok ? `详情 ${r.info.ms}ms` : `详情失败 ${r.info.error}`)
  if (r.toc) parts.push(r.toc.ok ? `目录 ${r.toc.count} 章 ${r.toc.ms}ms` : `目录失败 ${r.toc.error}`)
  if (r.content)
    parts.push(r.content.ok ? `正文 ${r.content.length} 字 ${r.content.ms}ms` : `正文失败 ${r.content.error}`)
  console.log(parts.join(' | '))
}

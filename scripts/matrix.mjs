#!/usr/bin/env node
// A 线兼容矩阵：从已安装书源里挑 10 个公开源，跑 搜索 → 详情 → 目录 → 正文。
// 用法: node scripts/matrix.mjs [关键词] [名称1,名称2,...]
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ReaderService } from '../dist/server/service.js'

const SOURCE_DIR = process.env.MO_READER_SOURCE_DIR ?? join(homedir(), '.dsh/storages/mo_reader/sources')
const DEFAULT_NAMES = ['快眼看书', '企鹅阅读', '顶点小说', '小说网吧', '起点中文', '轻菠萝包', '大美书网', '七猫小说', '番茄小说', '米读小说']

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
    notes: table(),
    bookmarks: table(),
    subscriptions: table(),
    jobs: table(),
    groups: table(),
    settings: { get: () => ({ ...settings }), set: (next) => Object.assign(settings, next) },
  }
}

const key = process.argv[2] ?? '完美世界'
const names = process.argv[3] ? process.argv[3].split(',').map((s) => s.trim()) : DEFAULT_NAMES

const wanted = new Map(names.map((name) => [name, null]))
for (const file of readdirSync(SOURCE_DIR)) {
  if (!file.endsWith('.json')) continue
  try {
    const raw = JSON.parse(readFileSync(join(SOURCE_DIR, file), 'utf8'))
    const source = raw.record ?? raw
    const name = source?.bookSourceName
    if (!name) continue
    for (const want of names) {
      if (!wanted.get(want) && name.includes(want)) wanted.set(want, { ...source, enabled: true })
    }
  } catch {
    /* 跳过坏文件 */
  }
}

const sources = names.map((name) => ({ name, source: wanted.get(name) })).filter((item) => item.source)
const missing = names.filter((name) => !wanted.get(name))
if (missing.length) console.error('未找到书源:', missing.join('、'))

const service = Object.create(ReaderService.prototype)
service.db = makeDb()
await service.importSources({ payload: JSON.stringify(sources.map((item) => item.source)) })

async function stage(fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { ok: true, ms: Date.now() - started, value }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  }
}

const rows = []
for (const { name, source } of sources) {
  const row = { name, url: source.bookSourceUrl, search: null, info: null, toc: null, content: null }
  const search = await stage(() => service.searchBooks({ key, sourceUrls: [source.bookSourceUrl] }))
  if (!search.ok) {
    row.search = { ok: false, ms: search.ms, error: search.error }
    rows.push(row)
    continue
  }
  const books = search.value.books ?? []
  row.search = { ok: books.length > 0, ms: search.ms, books: books.length, error: search.value.errors?.[0]?.message }
  const book = books[0]
  if (!book) {
    rows.push(row)
    continue
  }
  row.title = book.name
  const info = await stage(() => service.getBookInfo({ sourceUrl: source.bookSourceUrl, bookUrl: book.bookUrl }))
  const infoBook = { ...book }
  if (info.ok) {
    for (const [field, value] of Object.entries(info.value.info ?? {})) {
      if (value !== '' && value !== null && value !== undefined) infoBook[field] = value
    }
  }
  row.info = {
    ok: Boolean(infoBook?.name),
    ms: info.ms,
    name: infoBook?.name,
    author: infoBook?.author,
    cover: Boolean(infoBook?.coverUrl),
    error: info.ok ? undefined : info.error,
  }
  const tocUrl = infoBook.tocUrl || infoBook.bookUrl || book.bookUrl
  const toc = await stage(() => service.getToc({ sourceUrl: source.bookSourceUrl, tocUrl }))
  const chapters = toc.ok ? toc.value.chapters ?? [] : []
  row.toc = { ok: chapters.length > 0, ms: toc.ms, chapters: chapters.length, error: toc.ok ? undefined : toc.error }
  const readable = chapters.filter((item) => !item.isVolume && item.url)
  const chapter = readable[Math.min(readable.length - 1, Math.floor(readable.length / 3))] ?? chapters[0]
  if (!chapter) {
    rows.push(row)
    continue
  }
  const content = await stage(() => service.getContent({ sourceUrl: source.bookSourceUrl, chapterUrl: chapter.url }))
  const text = content.ok ? content.value.content ?? '' : ''
  row.chapter = { title: chapter.title, url: chapter.url }
  row.content = {
    ok: text.replace(/\s/g, '').length > 100,
    ms: content.ms,
    chars: text.length,
    error: content.ok ? undefined : content.error,
  }
  rows.push(row)
}

mkdirSync('.scratch/compat', { recursive: true })
const report = { key, at: new Date().toISOString(), rows }
writeFileSync('.scratch/compat/matrix.json', JSON.stringify(report, null, 2))

for (const row of rows) {
  const mark = (stage) => (stage?.ok ? '✓' : '✗')
  console.log(
    [
      mark(row.search),
      mark(row.info),
      mark(row.toc),
      mark(row.content),
      row.name,
      row.search?.books ?? 0,
      row.toc?.chapters ?? 0,
      row.content?.chars ?? 0,
      (row.chapter?.title ?? '').slice(0, 12),
      row.search?.error ?? row.info?.error ?? row.toc?.error ?? row.content?.error ?? '',
    ].join('\t'),
  )
}
console.log(`可读: ${rows.filter((row) => row.content?.ok).length}/${rows.length}`)

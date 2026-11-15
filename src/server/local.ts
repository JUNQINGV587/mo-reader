import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { parseEpub } from '../core/import/epub.js'
import { parseTxt, type ImportedBook, type ImportedChapter } from '../core/import/txt.js'

export interface LocalBookRecord {
  book: Record<string, unknown>
  chapters: ImportedChapter[]
}

const cache = new Map<string, LocalBookRecord>()

function localRoot(): string {
  return process.env.MO_READER_LOCAL_ROOT || join(homedir(), '.dsh', 'reader', 'local')
}

export function localBookId(url: string): string {
  const match = /^local:\/\/([^/]+)/.exec(url.trim())
  return match?.[1] ?? ''
}

export async function importLocalBuffer(
  fileName: string,
  buffer: Uint8Array,
): Promise<{ book: Record<string, unknown>; chapters: ImportedChapter[] }> {
  const ext = extname(fileName).toLowerCase()
  const parsed: ImportedBook =
    ext === '.epub' ? await parseEpub(buffer, fileName) : parseTxt(buffer, fileName)
  if (parsed.chapters.length === 0) throw new Error('没有解析到章节')

  const id = createHash('sha1').update(Buffer.from(buffer)).digest('hex').slice(0, 24)
  const now = new Date().toISOString()
  const readable = parsed.chapters.filter((chapter) => !chapter.isVolume)
  const book = {
    id,
    name: (parsed.name || '未命名').slice(0, 80),
    author: parsed.author,
    bookUrl: `local://${id}`,
    origin: 'local',
    originName: '本地',
    type: 0,
    group: '',
    coverUrl: '',
    intro: parsed.intro,
    totalChapterNum: readable.length,
    wordCount: '',
    rating: '',
    pinned: false,
    latestChapterTitle: readable.at(-1)?.title ?? '',
    lastReadAt: 0,
    createdAt: now,
    updatedAt: now,
  }
  const dir = join(localRoot(), id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'book.json'), JSON.stringify({ book, chapters: parsed.chapters }), 'utf8')
  cache.set(id, { book, chapters: parsed.chapters })
  return { book, chapters: parsed.chapters }
}

export async function readLocalBook(id: string): Promise<LocalBookRecord | null> {
  const cached = cache.get(id)
  if (cached) return cached
  try {
    const raw = await readFile(join(localRoot(), id, 'book.json'), 'utf8')
    const record = JSON.parse(raw) as LocalBookRecord
    cache.set(id, record)
    return record
  } catch {
    return null
  }
}

export async function localToc(id: string): Promise<Array<Record<string, unknown>>> {
  const record = await readLocalBook(id)
  if (!record) return []
  return record.chapters.map((chapter, index) => ({
    id: `${id}:${index}`,
    bookId: id,
    index,
    title: chapter.title,
    url: chapter.isVolume ? '' : `local://${id}/${index}`,
    isVolume: Boolean(chapter.isVolume),
    isRead: false,
  }))
}

export async function localContent(
  id: string,
  index: number,
): Promise<{ title: string; content: string } | null> {
  const record = await readLocalBook(id)
  const chapter = record?.chapters[index]
  if (!chapter) return null
  return { title: chapter.title, content: chapter.content }
}

export async function removeLocalBook(id: string): Promise<void> {
  cache.delete(id)
  await rm(join(localRoot(), id), { recursive: true, force: true })
}

import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { parseEpub } from '../core/import/epub.js'
import { parseMobi } from '../core/import/mobi.js'
import { parsePdf } from '../core/import/pdf.js'
import { parseTxt, type ImportedBook, type ImportedChapter } from '../core/import/txt.js'
import { isPdfPageChapters } from '../core/pdf-pages.js'

export interface LocalBookRecord {
  book: Record<string, unknown>
  chapters: ImportedChapter[]
}

const cache = new Map<string, LocalBookRecord>()

/** PDF 原文件在书目录里的固定文件名；老版本导入的 PDF 只有 book.json，没有它。 */
export const LOCAL_PDF_ORIGINAL = 'original.pdf'

/** 本地书 id 是文件字节 sha1 的前 24 位小写十六进制，路由与路径拼接只认这个形状。 */
const LOCAL_BOOK_ID_PATTERN = /^[0-9a-f]{24}$/

export function localRoot(): string {
  return process.env.MO_READER_LOCAL_ROOT || join(homedir(), '.dsh', 'reader', 'local')
}

export function localBookId(url: string): string {
  const match = /^local:\/\/([^/]+)/.exec(url.trim())
  return match?.[1] ?? ''
}

/** 书目录只接受合法 id，调用方拿到的路径不会被外部输入带出本地书根目录。 */
export function localBookDir(id: string): string | null {
  return LOCAL_BOOK_ID_PATTERN.test(id) ? join(localRoot(), id) : null
}

/** 兼容新老两种本地书记录：新记录看 localFormat，旧记录看章节标题。 */
export function isLocalPdfRecord(record: LocalBookRecord | null | undefined): boolean {
  if (!record) return false
  return record.book.localFormat === 'pdf' || isPdfPageChapters(record.chapters)
}

/** 原文件是否存在；只有合法 id 且目录里真的有 original.pdf 才算有。 */
export async function hasLocalPdfOriginal(id: string): Promise<boolean> {
  const dir = localBookDir(id)
  if (!dir) return false
  try {
    const info = await stat(join(dir, LOCAL_PDF_ORIGINAL))
    return info.isFile()
  } catch {
    return false
  }
}

export async function importLocalBuffer(
  fileName: string,
  buffer: Uint8Array,
): Promise<{ book: Record<string, unknown>; chapters: ImportedChapter[] }> {
  const ext = extname(fileName).toLowerCase()
  let parsed: ImportedBook
  if (ext === '.txt') parsed = parseTxt(buffer, fileName)
  else if (ext === '.epub') parsed = await parseEpub(buffer, fileName)
  else if (ext === '.pdf') parsed = await parsePdf(buffer, fileName)
  else if (ext === '.mobi' || ext === '.azw' || ext === '.azw3')
    parsed = await parseMobi(buffer, fileName)
  else
    throw new Error(
      `暂不支持的本地格式：${ext || '无扩展名'}（支持 TXT、EPUB、PDF、MOBI、AZW、AZW3）`,
    )
  if (parsed.chapters.length === 0) throw new Error('没有解析到章节')

  const id = createHash('sha1').update(Buffer.from(buffer)).digest('hex').slice(0, 24)
  const now = new Date().toISOString()
  const readable = parsed.chapters.filter((chapter) => !chapter.isVolume)
  const isPdf = ext === '.pdf'
  const book: Record<string, unknown> = {
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
  if (isPdf) book.localFormat = 'pdf'
  const dir = join(localRoot(), id)
  await mkdir(dir, { recursive: true })
  // PDF 额外保留原始字节，供阅读页按 Range 直接预览；先写原文件再写书档，避免留下半本书。
  if (isPdf) await writeFile(join(dir, LOCAL_PDF_ORIGINAL), Buffer.from(buffer))
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

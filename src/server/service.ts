import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { VERSION } from '../core/version.js'
import { parseSource, type BookSource } from '../core/model/source.js'
import { fetchText } from '../core/net/http.js'
import { buildRequest, buildSearchRequest, parseHeaders, splitUrlOptions, type RequestSpec } from '../core/source/url.js'
import {
  analyzeBookInfo,
  analyzeContent,
  analyzeSearch,
  analyzeToc,
} from '../core/source/analyze.js'
import { openReaderStorage } from './storage.js'
import {
  importLocalBuffer,
  localBookId,
  localContent,
  localToc,
  readLocalBook,
  removeLocalBook,
} from './local.js'

export { REMOTE_METHODS } from '../core/remote-methods.js'
import { REMOTE_METHODS } from '../core/remote-methods.js'

type Args = Record<string, unknown> | undefined

function stringArg(args: Args, name: string): string {
  const value = args?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少参数 ${name}`)
  }
  return value.trim()
}

const SAFE_KEY = /^[a-z][a-z0-9_-]+$/

/**
 * 存储的 per-record key 只能是路径安全的小写串；书源的 bookSourceUrl
 * 常是完整 URL，用 sha1 生成稳定 key，兼容旧数据里本身就是安全串的 key。
 */
function sourceKey(bookSourceUrl: string): string {
  return SAFE_KEY.test(bookSourceUrl)
    ? bookSourceUrl
    : `src-${createHash('sha1').update(bookSourceUrl).digest('hex').slice(0, 24)}`
}

export class ReaderService extends TypertRemoteService {
  static inject = ['storageDomain', 'timer']

  db: any = null

  constructor(ctx: any, _options: any = {}) {
    super(ctx, 'reader')
    const service: any = this
    for (const name of REMOTE_METHODS) {
      // 与旧实现同一套运行时注册方式：程序化地套用 @Remote 的初始化器。
      ;(Remote as any)(name)(null, {
        name,
        private: false,
        static: false,
        addInitializer(fn: any) {
          fn.call(service)
        },
      })
    }
  }

  async [Service.init]() {
    this.db = await openReaderStorage(this.ctx)
    const ctx = this.ctx as any
    ctx.effect(
      () => async () => {
        await this.db?.domain?.close?.()
        this.db = null
      },
      'reader: close storage',
    )
  }

  async state() {
    return {
      ok: true,
      version: VERSION,
      methods: REMOTE_METHODS,
    }
  }

  async listSources() {
    const sources: BookSource[] = []
    for (const [, value] of this.requireDb().sources.entries()) {
      sources.push(value as BookSource)
    }
    sources.sort((a, b) => (a.bookSourceName ?? '').localeCompare(b.bookSourceName ?? '', 'zh'))
    return { sources }
  }

  async importSources(args: Args) {
    const payload = stringArg(args, 'payload')
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new Error('不是合法的 JSON')
    }

    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).bookSources)
        ? (parsed as any).bookSources
        : [parsed]

    let added = 0
    let updated = 0
    const errors: Array<{ url: string; message: string }> = []

    for (const item of list) {
      try {
        const source = parseSource(item)
        const key = sourceKey(source.bookSourceUrl)
        const existed = this.requireDb().sources.get(key) !== undefined
        await this.requireDb().sources.put(key, { ...source, id: key })
        if (existed) updated += 1
        else added += 1
      } catch (error) {
        errors.push({
          url: typeof (item as any)?.bookSourceUrl === 'string' ? (item as any).bookSourceUrl : '',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { added, updated, total: list.length, errors }
  }

  async saveSource(args: Args) {
    const raw = args?.source
    const source = parseSource(raw)
    const key = sourceKey(source.bookSourceUrl)
    await this.requireDb().sources.put(key, { ...source, id: key })
    return { source: { ...source, id: key } }
  }

  async deleteSources(args: Args) {
    const urls = args?.urls
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new Error('缺少参数 urls')
    }
    const db = this.requireDb()
    const keys = urls
      .filter((url): url is string => typeof url === 'string' && url.length > 0)
      // 兼容两种入参：存储 key（src-<sha1>）或书源 URL。
      .map((url) => (db.sources.get(url) !== undefined ? url : sourceKey(url)))
    const deleted = await db.sources.deleteMany(keys)
    return { deleted }
  }

  /** 批量启停：入参是存储 key（listSources 返回的 id），一次写盘。 */
  async setSourcesEnabled(args: Args) {
    const ids = Array.isArray(args?.ids)
      ? (args!.ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (ids.length === 0) throw new Error('缺少参数 ids')
    const enabled = args?.enabled !== false
    const db = this.requireDb()
    let updated = 0
    for (const id of ids) {
      const source = db.sources.get(id) as BookSource | undefined
      if (!source) continue
      await db.sources.put(id, { ...source, enabled })
      updated += 1
    }
    return { updated }
  }

  async searchBooks(args: Args) {
    const key = stringArg(args, 'key')
    const page = typeof args?.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
    const wanted = Array.isArray(args?.sourceUrls)
      ? new Set(args!.sourceUrls.filter((url): url is string => typeof url === 'string'))
      : null

    const sources: BookSource[] = []
    for (const [, value] of this.requireDb().sources.entries()) {
      const source = value as BookSource
      if (source.enabled === false) continue
      if (wanted && !wanted.has(source.bookSourceUrl)) continue
      sources.push(source)
    }

    const settled = await Promise.allSettled(
      sources.map(async (source) => {
        const request = buildSearchRequest(source, key, page)
        if (!request) throw new Error('书源没有搜索地址')
        const raw = await this.fetch(request, source)
        return analyzeSearch(raw.text, source, raw.url)
      }),
    )

    const books: ReturnType<typeof analyzeSearch> = []
    const errors: Array<{ sourceUrl: string; message: string }> = []
    settled.forEach((result, index) => {
      const source = sources[index]!
      if (result.status === 'fulfilled') {
        books.push(...result.value)
      } else {
        errors.push({
          sourceUrl: source.bookSourceUrl,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    })
    return { books, errors }
  }

  async getBookInfo(args: Args) {
    const bookUrl = stringArg(args, 'bookUrl')
    if (bookUrl.startsWith('local://')) {
      const record = await readLocalBook(localBookId(bookUrl))
      if (!record) throw new Error('本地书不存在')
      return { info: record.book, url: bookUrl }
    }
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    const raw = await this.fetch({ url: bookUrl, method: 'GET', headers: {} }, source)
    const info = analyzeBookInfo(raw.text, source, raw.url, raw.url)
    return { info, url: raw.url }
  }

  async getToc(args: Args) {
    const tocUrl = stringArg(args, 'tocUrl')
    if (tocUrl.startsWith('local://')) {
      const chapters = await localToc(localBookId(tocUrl))
      if (chapters.length === 0) throw new Error('本地书不存在或没有章节')
      return { chapters, url: tocUrl }
    }
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    const raw = await this.fetch({ url: tocUrl, method: 'GET', headers: {} }, source)
    const chapters = analyzeToc(raw.text, source, raw.url)
    return { chapters, url: raw.url }
  }

  async getContent(args: Args) {
    const chapterUrl = stringArg(args, 'chapterUrl')
    const localMatch = /^local:\/\/([^/]+)\/(\d+)/.exec(chapterUrl)
    if (localMatch) {
      const chapter = await localContent(localMatch[1]!, Number(localMatch[2]))
      if (!chapter) throw new Error('本地章节不存在')
      return { content: chapter.content, url: chapterUrl }
    }
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    const raw = await this.fetch({ url: chapterUrl, method: 'GET', headers: {} }, source)
    const content = analyzeContent(raw.text, source, raw.url)
    return { content, url: raw.url }
  }

  async debugSource(args: Args) {
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    const type = stringArg(args, 'type')
    const started = Date.now()
    let request: RequestSpec | null = null

    if (type === 'search') {
      request = buildSearchRequest(source, stringArg(args, 'key'), 1)
    } else {
      const url = stringArg(args, 'url')
      if (type === 'bookInfo' || type === 'toc' || type === 'content') {
        request = buildRequest(url, { baseUrl: source.bookSourceUrl, source })
      }
    }
    if (!request) throw new Error('无法生成请求地址')

    const raw = await this.fetch(request, source)
    let result: unknown = null
    if (type === 'search') result = analyzeSearch(raw.text, source, raw.url)
    else if (type === 'bookInfo') result = analyzeBookInfo(raw.text, source, raw.url, raw.url)
    else if (type === 'toc') result = analyzeToc(raw.text, source, raw.url)
    else if (type === 'content') result = analyzeContent(raw.text, source, raw.url)

    return {
      type,
      request: { url: request.url, method: request.method },
      status: raw.status,
      url: raw.url,
      elapsedMs: Date.now() - started,
      raw: raw.text.slice(0, 200_000),
      result,
    }
  }

  async importLocalBook(args: Args) {
    const fileName = stringArg(args, 'fileName')
    const data = stringArg(args, 'dataBase64')
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) throw new Error('文件为空')
    const { book, chapters } = await importLocalBuffer(fileName, buffer)
    const id = String(book.id)
    const existing = this.requireDb().books.get(id) as Record<string, unknown> | undefined
    const record = { ...book, createdAt: existing?.createdAt ?? book.createdAt }
    await this.requireDb().books.put(id, record)
    return { book: record, chapters: chapters.length }
  }

  async addBook(args: Args) {
    const book = args?.book
    if (!book || typeof book !== 'object') throw new Error('缺少参数 book')
    const source = book as Record<string, unknown>
    const origin = typeof source.origin === 'string' ? source.origin : ''
    const bookUrl = typeof source.bookUrl === 'string' ? source.bookUrl : ''
    const name = typeof source.name === 'string' ? source.name : ''
    if (!origin || !bookUrl || !name) throw new Error('书缺少 origin/bookUrl/name')

    const id = createHash('sha1').update(`${origin}|${bookUrl}`).digest('hex')
    const now = new Date().toISOString()
    const existing = this.requireDb().books.get(id) as Record<string, unknown> | undefined
    const record = { ...source, id, createdAt: existing?.createdAt ?? now, updatedAt: now }
    await this.requireDb().books.put(id, record)
    return { book: record }
  }

  async updateBook(args: Args) {
    const id = stringArg(args, 'id')
    const patch = args?.patch
    if (!patch || typeof patch !== 'object') throw new Error('缺少参数 patch')
    const existing = this.requireDb().books.get(id) as Record<string, unknown> | undefined
    if (!existing) throw new Error(`书不存在：${id}`)
    const record = {
      ...existing,
      ...(patch as Record<string, unknown>),
      id,
      updatedAt: new Date().toISOString(),
    }
    await this.requireDb().books.put(id, record)
    return { book: record }
  }

  async listBooks() {
    const books: Array<Record<string, unknown>> = []
    for (const [id, value] of this.requireDb().books.entries()) {
      const record = this.requireDb().readRecords.get(id)
      books.push({ ...(value as Record<string, unknown>), progress: record ?? null })
    }
    books.sort((a, b) => {
      const left = String(a.lastReadAt ?? a.updatedAt ?? '')
      const right = String(b.lastReadAt ?? b.updatedAt ?? '')
      return right.localeCompare(left)
    })
    return { books }
  }

  async removeBooks(args: Args) {
    const ids = args?.ids
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('缺少参数 ids')
    const keys = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    const localIds = keys.filter((id) => {
      const book = this.requireDb().books.get(id) as Record<string, unknown> | undefined
      return book?.origin === 'local'
    })
    const deleted = await this.requireDb().books.deleteMany(keys)
    for (const id of keys) await this.requireDb().readRecords.delete(id)
    for (const id of localIds) await removeLocalBook(id).catch(() => undefined)
    return { deleted }
  }

  async saveProgress(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const record = {
      id: bookId,
      bookId,
      chapterIndex: Number(args?.chapterIndex ?? 0) || 0,
      chapterTitle: typeof args?.chapterTitle === 'string' ? args.chapterTitle : '',
      chapterUrl: typeof args?.chapterUrl === 'string' ? args.chapterUrl : '',
      position: Number(args?.position ?? 0) || 0,
      updatedAt: new Date().toISOString(),
    }
    await this.requireDb().readRecords.put(bookId, record)
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (book) {
      await this.requireDb().books.put(bookId, { ...book, lastReadAt: record.updatedAt })
    }
    return { progress: record }
  }

  async getProgress(args: Args) {
    const bookId = stringArg(args, 'bookId')
    return { progress: this.requireDb().readRecords.get(bookId) ?? null }
  }

  async listBookmarks(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const bookmarks: Array<Record<string, unknown>> = []
    for (const [, value] of this.requireDb().bookmarks.entries()) {
      const record = value as Record<string, unknown>
      if (record.bookId === bookId) bookmarks.push(record)
    }
    bookmarks.sort((a, b) => {
      const chapter = Number(a.chapterIndex ?? 0) - Number(b.chapterIndex ?? 0)
      if (chapter !== 0) return chapter
      return Number(a.page ?? 0) - Number(b.page ?? 0)
    })
    return { bookmarks }
  }

  async saveBookmark(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const chapterIndex = Number(args?.chapterIndex ?? 0) || 0
    const page = Number(args?.page ?? 0) || 0
    const type = typeof args?.type === 'string' && args.type ? args.type : 'bookmark'
    const id = createHash('sha1')
      .update(`${bookId}|${chapterIndex}|${page}|${type}`)
      .digest('hex')
      .slice(0, 24)
    const existing = this.requireDb().bookmarks.get(id) as Record<string, unknown> | undefined
    const record = {
      id,
      bookId,
      type,
      chapterIndex,
      chapterTitle: typeof args?.chapterTitle === 'string' ? args.chapterTitle : '',
      chapterUrl: typeof args?.chapterUrl === 'string' ? args.chapterUrl : '',
      page,
      text: typeof args?.text === 'string' ? args.text : '',
      note: typeof args?.note === 'string' ? args.note : '',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    await this.requireDb().bookmarks.put(id, record)
    return { bookmark: record }
  }

  async deleteBookmark(args: Args) {
    const id = stringArg(args, 'id')
    const deleted = await this.requireDb().bookmarks.delete(id)
    return { deleted }
  }

  async getSettings() {
    return { settings: this.requireDb().settings.get() }
  }

  async saveSettings(args: Args) {
    const patch = args?.settings
    if (!patch || typeof patch !== 'object') throw new Error('缺少参数 settings')
    const current = this.requireDb().settings.get()
    const next = { ...current, ...(patch as Record<string, unknown>) }
    await this.requireDb().settings.set(next)
    return { settings: next }
  }

  private requireDb(): any {
    if (!this.db) throw new Error('存储尚未就绪')
    return this.db
  }

  private getSource(url: string): BookSource {
    const db = this.requireDb()
    const direct = db.sources.get(url)
    if (direct) return direct as BookSource
    const hashed = db.sources.get(sourceKey(url))
    if (hashed) return hashed as BookSource
    for (const [, value] of db.sources.entries()) {
      if ((value as BookSource).bookSourceUrl === url) return value as BookSource
    }
    throw new Error(`书源不存在：${url}`)
  }

  private async fetch(request: RequestSpec, source: BookSource) {
    // URL 自带 `,{...}` 选项（目录/正文常见，且可能 percent-encode）优先。
    const inline = splitUrlOptions(request.url)
    return fetchText(inline.url, {
      method: inline.method !== 'GET' ? inline.method : request.method,
      body: inline.body ?? request.body,
      headers: { ...parseHeaders(source.header), ...inline.headers, ...request.headers },
    })
  }
}

export default ReaderService

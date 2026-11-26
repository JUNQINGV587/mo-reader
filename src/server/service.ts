import { createHash } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { VERSION } from '../core/version.js'
import { parseSource, type BookSource } from '../core/model/source.js'
import { dictRuleKey, parseDictRule, type DictRule } from '../core/model/dict.js'
import { AnalyzeRule } from '../core/rules/analyze-rule.js'
import { analyzeExplore, parseExploreCategories } from '../core/source/explore.js'
import { isExploreEnabled } from '../core/source/filter.js'
import { parseRssSources } from '../core/rss/source.js'
import { parseFeed } from '../core/rss/feed.js'
import {
  fetchText,
  openMediaStream,
  type MediaStreamOptions,
  type MediaStreamResult,
} from '../core/net/http.js'
import { assertPublicHttpUrl } from '../core/net/guard.js'
import {
  buildExploreRequest,
  buildRequest,
  buildSearchRequest,
  parseHeaders,
  splitUrlOptions,
  type RequestSpec,
} from '../core/source/url.js'
import {
  analyzeBookInfo,
  analyzeChapterContent,
  analyzeContent,
  analyzeSearch,
  analyzeToc,
  contentKindOf,
  contentKindOfType,
  htmlToText,
} from '../core/source/analyze.js'
import { buildReviewSummaryRequest, parseReviewSummary, reviewRule, summaryIsConfigured } from '../core/source/review.js'
import { mapSwitchProgress, matchBookName, sameAuthorName } from '../core/source/switch.js'
import { openReaderStorage } from './storage.js'
import { clearChapterCache, readCachedChapter } from './cache.js'
import {
  DEFAULT_RETRY_BASE_MS,
  DOWNLOAD_KIND,
  DownloadCoordinator,
  downloadEntryKey,
  ensureChapterCached,
  isActiveJob,
  recoverInterruptedJobs,
  type ChapterDownload,
  type DownloadHost,
} from './download.js'
import {
  MEDIA_DOWNLOAD_KIND,
  MediaDownloadCoordinator,
  type MediaChapterDownload,
  type MediaDownloadHost,
  type MediaEntryKind,
  type MediaFileRecord,
} from './media-download.js'
import {
  clearMediaDir,
  mediaEntryKey,
  mediaFileName,
  mediaFileIdOf,
  mediaRoot,
  mediaFilePresent,
  mediaStoreId,
  prepareMediaDir,
  saveMediaStream,
} from './media-cache.js'
import { buildEpub } from './epub-export.js'
import { assertEmbeddableFont } from './pdf-export.js'
import { loadCoverImage } from './export-cover.js'
import {
  EXPORT_KIND,
  ExportCoordinator,
  cleanupExpiredExports,
  contentTypeOf,
  exportArtifactExists,
  exportRoot,
  type ExportFormat,
  type ExportHost,
} from './exports.js'
import {
  EXPORT_ROUTE_PATH,
  LOCAL_MEDIA_ROUTE_PATH,
  LOCAL_PDF_ROUTE_PATH,
  registerArtifactRoute,
  registerProtectedFileRoute,
  type ArtifactDescriptor,
  type FileArtifactDescriptor,
} from './routes.js'
import {
  MEDIA_ROUTE_PATH,
  MediaRegistry,
  contentTypeForExt,
  defaultExtForKind,
  extFromUrl,
  mediaUrlOf,
  registerMediaRoute,
  safeMediaName,
  type MediaEntry,
  type MediaKind,
} from './media.js'
import { listCustomFonts, readCustomFont, removeCustomFont, saveCustomFont } from './fonts.js'
import { isKnownTheme, normalizeCustomThemes } from '../core/reader/theme.js'
import { parseShelfImport, shelfDedupKeys } from '../core/reader/shelf-transfer.js'
import {
  LOCAL_PDF_ORIGINAL,
  hasLocalPdfOriginal,
  importLocalBuffer,
  isLocalPdfRecord,
  localBookId,
  localContent,
  localRoot,
  localToc,
  readLocalBook,
  removeLocalBook,
} from './local.js'

export { REMOTE_METHODS } from '../core/remote-methods.js'
import { REMOTE_METHODS } from '../core/remote-methods.js'

type Args = Record<string, unknown> | undefined

/** pageHint 只是服务端按约 800 字/页给出的粗估，真实定位由阅读器 findPageFor 完成。 */
const SEARCH_PAGE_HINT_CHARS = 800
/** 结果片段在首个命中前后各保留的字数。 */
const SEARCH_SNIPPET_CONTEXT = 30

/** 重新导入同一文件时，这些用户侧状态要沿用旧记录，否则书架位置与阅读进度会被重置。 */
const LOCAL_BOOK_KEEP_FIELDS = [
  'createdAt',
  'pinned',
  'group',
  'lastReadAt',
  'simulateEnabled',
  'simulateStartDate',
  'simulateStartChapter',
  'simulateDailyChapters',
  'durChapterIndex',
  'durChapterTitle',
] as const

function countOccurrences(value: string, key: string): number {
  if (!key) return 0
  let count = 0
  let index = value.indexOf(key)
  while (index >= 0) {
    count += 1
    index = value.indexOf(key, index + key.length)
  }
  return count
}

function searchSnippet(value: string, start: number, length: number): string {
  const from = Math.max(0, start - SEARCH_SNIPPET_CONTEXT)
  const to = Math.min(value.length, start + length + SEARCH_SNIPPET_CONTEXT)
  const body = value.slice(from, to).replace(/\s+/g, ' ').trim()
  return `${from > 0 ? '…' : ''}${body}${to < value.length ? '…' : ''}`
}

function stringArg(args: Args, name: string): string {
  const value = args?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`缺少参数 ${name}`)
  }
  return value.trim()
}

const SAFE_KEY = /^[a-z][a-z0-9_-]+$/

function sameRequest(a: RequestSpec, b: RequestSpec): boolean {
  return a.url === b.url && a.method === b.method && (a.body ?? '') === (b.body ?? '')
}

/**
 * 存储的 per-record key 只能是路径安全的小写串；书源的 bookSourceUrl
 * 常是完整 URL，用 sha1 生成稳定 key，兼容旧数据里本身就是安全串的 key。
 */
function sourceKey(bookSourceUrl: string): string {
  return SAFE_KEY.test(bookSourceUrl)
    ? bookSourceUrl
    : `src-${createHash('sha1').update(bookSourceUrl).digest('hex').slice(0, 24)}`
}

/** 在线检查并发上限与超时范围：一次只打 8 个源，单请求 0.5–30 秒。 */
const SOURCE_CHECK_CONCURRENCY = 8
const SOURCE_CHECK_TIMEOUT_MS = 5000
const SOURCE_CHECK_TIMEOUT_MIN_MS = 500
const SOURCE_CHECK_TIMEOUT_MAX_MS = 30_000

interface SourceCheckResult {
  url: string
  ok: boolean
  status: number | null
  elapsedMs: number
  error: string
}

function clampCheckTimeout(value: unknown): number {
  const raw =
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : SOURCE_CHECK_TIMEOUT_MS
  return Math.min(SOURCE_CHECK_TIMEOUT_MAX_MS, Math.max(SOURCE_CHECK_TIMEOUT_MIN_MS, raw))
}

function checkErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时'
    return error.message || '请求失败'
  }
  return String(error)
}

async function checkOneSource(url: string, timeoutMs: number): Promise<SourceCheckResult> {
  const started = Date.now()
  try {
    const response = await fetchText(url, { timeoutMs })
    const ok = response.status >= 200 && response.status < 400
    return {
      url,
      ok,
      status: response.status,
      elapsedMs: Date.now() - started,
      error: ok ? '' : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      url,
      ok: false,
      status: null,
      elapsedMs: Date.now() - started,
      error: checkErrorMessage(error),
    }
  }
}

export class ReaderService extends TypertRemoteService {
  static inject = ['storageDomain', 'timer']

  db: any = null

  /** 下载作业协调器，按需创建；测试可直接改 downloadRetryBaseMs 缩短重试间隔。 */
  downloadsCoordinator: DownloadCoordinator | null = null

  /** 导出作业协调器，按需创建；产物落导出目录并由受保护路由下发。 */
  exportsCoordinator: ExportCoordinator | null = null

  /** 媒体离线下载协调器（#112），按需创建；与文字下载共用作业表与暂停/重试语义。 */
  mediaDownloadsCoordinator: MediaDownloadCoordinator | null = null

  /** 媒体代理登记表：token 只在内存里，服务重启即失效。 */
  mediaRegistry: MediaRegistry | null = null

  /** 上游流式抓取实现，默认 openMediaStream；测试可替换成不联网的假实现。 */
  mediaStreamOpener: ((url: string, options: MediaStreamOptions) => Promise<MediaStreamResult>) | null = null

  downloadRetryBaseMs = DEFAULT_RETRY_BASE_MS

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
    // 重启后残留的 running/queued 作业没人接手：标为暂停并注明原因。
    try {
      await recoverInterruptedJobs(this.db.jobs)
    } catch {
      // 作业恢复失败不应阻止服务启动。
    }
    // 导出产物只保留 24 小时：启动时扫一次，导出前再顺带清（不启定时器）。
    try {
      await cleanupExpiredExports(this.db.jobs)
    } catch {
      // 清理失败不影响启动。
    }
    this.registerExportRoute()
    this.registerLocalPdfRoute()
    this.registerMediaRoute()
    this.registerLocalMediaRoute()
    const ctx = this.ctx as any
    ctx.effect(
      () => async () => {
        try {
          await this.exportsCoordinator?.shutdown()
        } finally {
          this.exportsCoordinator = null
        }
        try {
          await this.mediaDownloadsCoordinator?.shutdown()
        } finally {
          this.mediaDownloadsCoordinator = null
        }
        try {
          await this.downloadsCoordinator?.shutdown()
        } finally {
          this.downloadsCoordinator = null
        }
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

  /** 导出书源为 Legado 兼容 JSON：去掉内部存储 id，其余字段原样保留。 */
  async exportSources(args: Args) {
    const raw = args?.ids
    const ids = Array.isArray(raw)
      ? raw
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
          .map((id) => id.trim())
      : []
    if (ids.length === 0) throw new Error('缺少参数 ids')
    const db = this.requireDb()
    const sources: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    for (const id of ids) {
      // 兼容两种入参：存储 key（listSources 返回的 id）或书源 URL。
      const key = db.sources.get(id) !== undefined ? id : sourceKey(id)
      if (seen.has(key)) continue
      const source = db.sources.get(key) as (BookSource & { id?: string }) | undefined
      if (!source) continue
      seen.add(key)
      const out: Record<string, unknown> = { ...source }
      delete out.id
      sources.push(out)
    }
    if (sources.length === 0) throw new Error('书源不存在')
    return { json: JSON.stringify(sources, null, 2), count: sources.length }
  }

  /**
   * 在线可达性检查：逐条请求书源地址，按输入顺序返回结果。
   * 与静态结构检查（checkReport）无关，只回答「现在能不能连上」。
   */
  async checkSources(args: Args) {
    const raw = args?.urls
    const urls = Array.isArray(raw)
      ? raw
          .filter((url): url is string => typeof url === 'string' && url.trim().length > 0)
          .map((url) => url.trim())
      : []
    if (urls.length === 0) throw new Error('缺少参数 urls')
    const timeoutMs = clampCheckTimeout(args?.timeoutMs)
    const results: SourceCheckResult[] = new Array(urls.length)
    let cursor = 0
    const worker = async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= urls.length) return
        results[index] = await checkOneSource(urls[index], timeoutMs)
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SOURCE_CHECK_CONCURRENCY, urls.length) }, () => worker()),
    )
    return { results }
  }

  async listDictRules() {
    const rules: DictRule[] = []
    for (const [, value] of this.requireDb().dictRules.entries()) {
      rules.push(value as DictRule)
    }
    rules.sort((a, b) => {
      const left = typeof a.customOrder === 'number' ? a.customOrder : Number.MAX_SAFE_INTEGER
      const right = typeof b.customOrder === 'number' ? b.customOrder : Number.MAX_SAFE_INTEGER
      if (left !== right) return left - right
      return (a.name ?? '').localeCompare(b.name ?? '', 'zh')
    })
    return { rules }
  }

  /** 新增或更新一条字典规则：id 由名称+地址稳定生成，编辑时沿用旧 id。 */
  async saveDictRule(args: Args) {
    const raw = args?.rule
    if (!raw || typeof raw !== 'object') throw new Error('缺少参数 rule')
    const rule = parseDictRule(raw)
    const db = this.requireDb()
    const incoming = raw as Record<string, unknown>
    const requestedId = typeof incoming.id === 'string' && incoming.id.trim() ? incoming.id.trim() : ''
    const key = requestedId && db.dictRules.get(requestedId) !== undefined ? requestedId : dictRuleKey(rule.name, rule.url)
    const existing = db.dictRules.get(key) as DictRule | undefined
    const customOrder = this.resolveDictOrder(incoming, existing)
    const saved = { ...rule, id: key, customOrder } as DictRule
    await db.dictRules.put(key, saved)
    return { rule: saved }
  }

  async deleteDictRules(args: Args) {
    const ids = Array.isArray(args?.ids)
      ? (args!.ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.length > 0)
      : []
    if (ids.length === 0) throw new Error('缺少参数 ids')
    const deleted = await this.requireDb().dictRules.deleteMany(ids)
    return { deleted }
  }

  /** 导入 Legado 字典数组或 { dictRules: [...] }；单条失败只记错误，不中断整批。 */
  async importDictRules(args: Args) {
    const payload = stringArg(args, 'payload')
    let parsed: unknown
    try {
      parsed = JSON.parse(payload)
    } catch {
      throw new Error('不是合法的 JSON')
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).dictRules)
        ? ((parsed as any).dictRules as unknown[])
        : null
    if (!list) throw new Error('字典数据格式不正确')

    const db = this.requireDb()
    let added = 0
    let updated = 0
    const errors: Array<{ name: string; message: string }> = []
    for (const item of list) {
      try {
        if (!item || typeof item !== 'object') throw new Error('字典规则格式不正确')
        const rule = parseDictRule(item)
        const key = dictRuleKey(rule.name, rule.url)
        const existing = db.dictRules.get(key) as DictRule | undefined
        const incoming = item as Record<string, unknown>
        const customOrder = this.resolveDictOrder(incoming, existing)
        await db.dictRules.put(key, { ...rule, id: key, customOrder })
        if (existing) updated += 1
        else added += 1
      } catch (error) {
        errors.push({
          name: typeof (item as any)?.name === 'string' ? (item as any).name : '',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { added, updated, total: list.length, errors }
  }

  /** 导出 Legado 兼容数组（去掉内部 id，保留自定义字段）。 */
  async exportDictRules() {
    const { rules } = await this.listDictRules()
    return rules.map((rule) => {
      const out: Record<string, unknown> = { ...rule }
      delete out.id
      return out
    })
  }

  /** 服务端代查字典：替换 {{key}}，透传 header，按规则提取纯文本。 */
  async lookupDict(args: Args) {
    const ruleId = stringArg(args, 'ruleId')
    const key = stringArg(args, 'key')
    const record = this.requireDb().dictRules.get(ruleId) as DictRule | undefined
    if (!record) throw new Error(`字典不存在：${ruleId}`)
    if (record.enabled === false) throw new Error('字典未启用')
    const headers = parseHeaders(typeof record.header === 'string' ? record.header : '')
    const target = record.url.split('{{key}}').join(encodeURIComponent(key))
    const raw = await fetchText(target, { headers })
    const extracted = new AnalyzeRule(raw.text, { baseUrl: raw.url }).getString(record.rule)
    return { name: record.name, text: htmlToText(extracted), url: raw.url }
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

  async listExploreSources() {
    const sources: Array<{
      bookSourceUrl: string
      bookSourceName: string
      bookSourceGroup: string
      bookSourceType: number
    }> = []
    for (const [, value] of this.requireDb().sources.entries()) {
      const source = value as BookSource
      if (source.enabled === false) continue
      if (!isExploreEnabled(source)) continue
      if (!source.exploreUrl || !source.exploreUrl.trim()) continue
      sources.push({
        bookSourceUrl: source.bookSourceUrl,
        bookSourceName: source.bookSourceName,
        bookSourceGroup: source.bookSourceGroup ?? '',
        bookSourceType: source.bookSourceType ?? 0,
      })
    }
    // 发现页按「书源分组 → 书源 → 分类」组织，服务端先定好分组/名称顺序。
    sources.sort(
      (a, b) =>
        a.bookSourceGroup.localeCompare(b.bookSourceGroup, 'zh') ||
        a.bookSourceName.localeCompare(b.bookSourceName, 'zh'),
    )
    return { sources }
  }

  async getExploreCategories(args: Args) {
    const source = this.exploreSource(stringArg(args, 'sourceUrl'))
    let categories: ReturnType<typeof parseExploreCategories>
    try {
      categories = parseExploreCategories(source.exploreUrl, source.bookSourceUrl, { source })
    } catch (error) {
      throw new Error(`发现分类解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (categories.length === 0) throw new Error('未解析到发现分类')
    return { categories }
  }

  async exploreBooks(args: Args) {
    const source = this.exploreSource(stringArg(args, 'sourceUrl'))
    const categoryUrl = stringArg(args, 'categoryUrl')
    const page = typeof args?.page === 'number' && args.page > 0 ? Math.floor(args.page) : 1
    const request = buildExploreRequest(source, categoryUrl, page)
    if (!request) throw new Error('书源没有发现地址')
    // 分类地址必须随页码变化才可能翻页；否则同一地址会反复返回同一页。
    const hasPageRule = /\{\{\s*page\s*\}\}/i.test(categoryUrl)
    const nextRequest = buildExploreRequest(source, categoryUrl, page + 1)
    const canPaginate = Boolean(hasPageRule && nextRequest && !sameRequest(request, nextRequest))
    if (page > 1 && !canPaginate) {
      return { books: [], page, hasMore: false, url: request.url }
    }
    const raw = await this.fetch(request, source)
    if (raw.status >= 400) throw new Error(`HTTP ${raw.status}`)
    const books = analyzeExplore(raw.text, source, raw.url)
    return { books, page, hasMore: books.length > 0 && canPaginate, url: raw.url }
  }

  /** 换源候选：按书名搜所有启用书源，排除当前来源；同作者、书名匹配度高的在前。 */
  async findSourceCandidates(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const db = this.requireDb()
    const book = db.books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    const currentOrigin = String(book.origin ?? '')
    if (currentOrigin === 'local') throw new Error('本地书不支持换源')
    const bookName = String(book.name ?? '').trim()
    if (!bookName) throw new Error('书名不能为空')

    const sourceUrls: string[] = []
    for (const [, value] of db.sources.entries()) {
      const source = value as BookSource
      if (source.enabled === false) continue
      if (source.bookSourceUrl === currentOrigin) continue
      sourceUrls.push(source.bookSourceUrl)
    }
    if (sourceUrls.length === 0) return { candidates: [], errors: [] }

    const found = (await this.searchBooks({ key: bookName, sourceUrls })) as {
      books: ReturnType<typeof analyzeSearch>
      errors: Array<{ sourceUrl: string; message: string }>
    }
    const bookAuthor = String(book.author ?? '')
    const candidates = found.books.map((item) => {
      const name = String(item.name ?? '')
      const nameMatch = matchBookName(bookName, name)
      return {
        sourceUrl: String(item.origin ?? ''),
        sourceName: String(item.originName ?? ''),
        bookUrl: String(item.bookUrl ?? ''),
        name,
        author: String(item.author ?? ''),
        kind: String(item.kind ?? ''),
        latestChapter: String(item.lastChapter ?? ''),
        coverUrl: String(item.coverUrl ?? ''),
        sameAuthor: sameAuthorName(bookAuthor, item.author),
        nameMatch,
        possiblyNotSameBook: nameMatch === 'none',
      }
    })
    const rank = (item: (typeof candidates)[number]) => {
      const nameRank = item.nameMatch === 'exact' ? 0 : item.nameMatch === 'contains' ? 1 : 2
      // 作者权重高于书名，保证同作者候选始终排在前面。
      return (item.sameAuthor ? 0 : 10) + nameRank
    }
    candidates.sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.sourceName.localeCompare(right.sourceName, 'zh') ||
        left.name.localeCompare(right.name, 'zh'),
    )
    return { candidates, errors: found.errors }
  }

  /** 预览目标详情与目录；只读，不写书、不写目录。 */
  async previewSourceCandidate(args: Args) {
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    if (source.enabled === false) throw new Error('书源已停用')
    const target = await this.loadSwitchTarget(source, stringArg(args, 'bookUrl'))
    return {
      book: {
        sourceUrl: source.bookSourceUrl,
        sourceName: source.bookSourceName,
        bookUrl: target.bookUrl,
        tocUrl: target.tocUrl,
        name: target.info.name,
        author: target.info.author,
        kind: target.info.kind,
        coverUrl: target.info.coverUrl,
        intro: target.info.intro,
        totalChapterNum: target.chapters.length,
        latestChapterTitle: target.latestChapter,
      },
      chapterCount: target.chapters.length,
      latestChapter: target.latestChapter,
      chapters: target.chapters.slice(0, 20),
    }
  }

  /** 换源：先完整抓取并校验目标详情与目录，全部成功后才写入书目和进度。 */
  async switchBookSource(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const sourceUrl = stringArg(args, 'sourceUrl')
    const bookUrl = stringArg(args, 'bookUrl')
    const db = this.requireDb()
    const book = db.books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    if (String(book.origin ?? '') === 'local') throw new Error('本地书不支持换源')
    const source = this.getSource(sourceUrl)
    if (source.enabled === false) throw new Error('书源已停用')

    // 目标详情、目录与进度映射任何一步失败，都在写入前抛出。
    const target = await this.loadSwitchTarget(source, bookUrl)
    const previousProgress = db.readRecords.get(bookId) as Record<string, unknown> | undefined
    const mapped = mapSwitchProgress(target.chapters, previousProgress ?? null)
    const now = new Date().toISOString()

    const updatedBook: Record<string, unknown> = {
      ...book,
      id: bookId,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName,
      bookUrl: target.bookUrl,
      tocUrl: target.tocUrl,
      coverUrl: target.info.coverUrl || String(book.coverUrl ?? ''),
      intro: target.info.intro || String(book.intro ?? ''),
      totalChapterNum: target.chapters.length,
      latestChapterTitle: target.latestChapter,
      updatedAt: now,
    }
    const nextProgress = mapped
      ? {
          ...(previousProgress ?? {}),
          id: bookId,
          bookId,
          chapterIndex: mapped.chapterIndex,
          chapterTitle: mapped.chapterTitle,
          chapterUrl: mapped.chapterUrl,
          position: mapped.position,
          updatedAt: now,
        }
      : null

    await db.books.put(bookId, updatedBook)
    if (nextProgress) {
      try {
        await db.readRecords.put(bookId, nextProgress)
      } catch (error) {
        // 进度写失败时把书目恢复原样，避免只改了一半。
        await db.books.put(bookId, book)
        throw error
      }
    }
    return { book: updatedBook, chapters: target.chapters, progress: nextProgress }
  }

  private async loadSwitchTarget(source: BookSource, bookUrl: string) {
    const detail = await this.fetch({ url: bookUrl, method: 'GET', headers: {} }, source)
    if (detail.status >= 400) throw new Error(`目标详情请求失败：HTTP ${detail.status}`)
    const info = analyzeBookInfo(detail.text, source, detail.url, detail.url)
    if (!info.name || !info.name.trim()) throw new Error('目标详情没有书名')
    const tocUrl = String(info.tocUrl || detail.url).trim()
    const toc = await this.fetch({ url: tocUrl, method: 'GET', headers: {} }, source)
    if (toc.status >= 400) throw new Error(`目标目录请求失败：HTTP ${toc.status}`)
    const chapters = analyzeToc(toc.text, source, toc.url)
    const readable = chapters.filter(
      (chapter) => !chapter.isVolume && String(chapter.url ?? '').trim(),
    )
    if (readable.length === 0) throw new Error('目标目录为空')
    const last = readable[readable.length - 1]!
    return {
      info,
      chapters,
      bookUrl: detail.url,
      tocUrl: toc.url || tocUrl,
      latestChapter: String(info.lastChapter ?? '').trim() || String(last.title ?? '').trim(),
    }
  }

  private exploreSource(url: string): BookSource {
    const source = this.getSource(url)
    if (source.enabled === false) throw new Error('书源已停用')
    if (!isExploreEnabled(source)) throw new Error('书源未开启发现')
    if (!source.exploreUrl || !source.exploreUrl.trim()) throw new Error('书源没有发现分类')
    return source
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
    const sourceUrl = stringArg(args, 'sourceUrl')
    const source = this.getSource(sourceUrl)
    const kind = contentKindOf(source)
    if (kind === 'text') {
      const cached = await readCachedChapter(sourceUrl, chapterUrl)
      if (cached !== null) {
        // 老缓存可能没有索引记录：阅读命中时顺手补登，统计与「已下载」徽标才看得到。
        await this.registerKnownDownload(args, sourceUrl, chapterUrl, Buffer.byteLength(cached, 'utf8'))
        return { kind, content: cached, images: [], mediaUrl: '', url: chapterUrl, cached: true }
      }
    }
    // 本地优先（#112）：整章文件都在才用本地地址；缺失或损坏时清掉索引，继续走在线代理。
    let localMissing = false
    if (kind === 'images' || kind === 'audio' || kind === 'video') {
      const local = await this.localMediaContent(args, kind, chapterUrl)
      if (local?.localMissing === true) localMissing = true
      else if (local) return local
    }
    // 本地索引失效时把原因带回前端，让阅读页提示「已改用在线」。
    const localHint = localMissing ? { localMissing: true } : {}
    // 媒体地址对外只暴露代理 token：真实地址、书源 header 都留在服务端这次登记的条目里。
    const sourceHeaders = parseHeaders(source.header)
    if (kind === 'audio' || kind === 'video') {
      const mediaRule = source.ruleContent?.content ?? ''
      if (!mediaRule) {
        // 没有解析规则时章节地址本身就是媒体地址：Referer 优先用书籍页，拿不到再用章节页。
        const bookUrl = typeof args?.bookUrl === 'string' ? args.bookUrl : ''
        const proxied = await this.proxyMediaUrl(chapterUrl, {
          headers: sourceHeaders,
          kind,
          referer: bookUrl || chapterUrl,
        })
        return { kind, content: '', images: [], mediaUrl: proxied || chapterUrl, url: chapterUrl, ...localHint }
      }
      const raw = await this.fetch({ url: chapterUrl, method: 'GET', headers: {} }, source)
      const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
      const proxied = parsed.mediaUrl
        ? await this.proxyMediaUrl(parsed.mediaUrl, { headers: sourceHeaders, kind, referer: raw.url })
        : ''
      return { ...parsed, mediaUrl: proxied || parsed.mediaUrl, content: '', url: raw.url, ...localHint }
    }
    const raw = await this.fetch({ url: chapterUrl, method: 'GET', headers: {} }, source)
    const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
    if (kind === 'images') {
      // 同一章里重复的图片地址复用 token，避免一页几十张图把登记表撑满。
      const images = await Promise.all(
        parsed.images.map(async (image) => {
          const proxied = await this.proxyMediaUrl(image, {
            headers: sourceHeaders,
            kind: 'image',
            referer: raw.url,
            dedupeKey: `${raw.url}|${image}`,
          })
          // 代理登记失败（私网 / 非法地址 / DNS 不通过）时退回原地址，先保证能看。
          return proxied || image
        }),
      )
      return { ...parsed, images, content: parsed.text, url: raw.url, ...localHint }
    }
    return { ...parsed, content: parsed.text, url: raw.url }
  }

  private bookContentKind(book: Record<string, unknown>): 'text' | 'images' | 'audio' | 'video' {
    const origin = String(book.origin ?? '')
    const type = Number(book.type ?? 0)
    const fromRecord = contentKindOfType(type)
    if (!origin || origin === 'local') return fromRecord
    try {
      return contentKindOf(this.getSource(origin))
    } catch {
      // 书源已删 / 未导入时按书目记录兜底，非文本书仍能给出明确拒绝。
      if (fromRecord !== 'text') return fromRecord
      throw new Error(`书源不存在：${origin}`)
    }
  }

  /** 书内搜索的一章正文：本地正文 > 已缓存正文 > 在线抓取。 */
  private async chapterTextForSearch(
    book: Record<string, unknown>,
    chapter: Record<string, unknown>,
  ): Promise<string> {
    const origin = String(book.origin ?? '')
    const url = String(chapter.url ?? '')
    const localMatch = /^local:\/\/([^/]+)\/(\d+)/.exec(url)
    if (localMatch) {
      const local = await localContent(localMatch[1]!, Number(localMatch[2]))
      if (!local) throw new Error('本地章节不存在')
      return local.content
    }
    const cached = await readCachedChapter(origin, url)
    if (cached !== null && cached.trim()) return cached
    const source = this.getSource(origin)
    const raw = await this.fetch({ url, method: 'GET', headers: {} }, source)
    if (raw.status >= 400) throw new Error(`HTTP ${raw.status}`)
    const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
    if (parsed.kind !== 'text') throw new Error('该章节不是文本类型')
    return parsed.text
  }

  async searchInBook(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const key = stringArg(args, 'key')
    const db = this.requireDb()
    const book = db.books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    if (this.bookContentKind(book) !== 'text') {
      throw new Error('该书不是文本类型，无法搜索')
    }

    const origin = String(book.origin ?? '')
    const tocUrl = String(book.tocUrl || book.bookUrl || '')
    if (!tocUrl) throw new Error('书没有目录地址')
    const toc = await (this as any).getToc({ tocUrl, sourceUrl: origin })
    const chapters = (toc?.chapters ?? []) as Array<Record<string, unknown>>

    const rawFrom = Number(args?.fromIndex ?? 0)
    const fromIndex = Number.isFinite(rawFrom)
      ? Math.max(0, Math.min(chapters.length, Math.floor(rawFrom)))
      : 0
    // 单批上限固定 200 章；maxChapters 只能调小，避免长书一次阻塞。
    const rawMax = Number(args?.maxChapters ?? 200)
    const maxChapters = Number.isFinite(rawMax) ? Math.max(1, Math.min(200, Math.floor(rawMax))) : 200
    const window = chapters.slice(fromIndex, fromIndex + maxChapters)
    const nextIndex = fromIndex + window.length

    const results: Array<{
      chapterIndex: number
      chapterTitle: string
      count: number
      snippet: string
      pageHint: number
    }> = []
    const errors: Array<{ chapterIndex: number; chapterTitle: string; message: string }> = []
    for (let offset = 0; offset < window.length; offset += 1) {
      const chapterIndex = fromIndex + offset
      const chapter = window[offset]!
      if (chapter.isVolume || !chapter.url) continue
      const chapterTitle = String(chapter.title ?? '')
      try {
        const text = htmlToText(await this.chapterTextForSearch(book, chapter))
        const count = countOccurrences(text, key)
        if (count > 0) {
          const first = text.indexOf(key)
          results.push({
            chapterIndex,
            chapterTitle,
            count,
            snippet: searchSnippet(text, first, key.length),
            pageHint: Math.floor(first / SEARCH_PAGE_HINT_CHARS) + 1,
          })
        }
      } catch (error) {
        errors.push({
          chapterIndex,
          chapterTitle,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { results, nextIndex, done: nextIndex >= chapters.length, errors }
  }

  async cacheBook(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 20) || 20))
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    if (String(book.origin) === 'local') {
      return { cached: 0, failed: 0, bytes: 0, total: 0, message: '本地书无需缓存' }
    }
    const sourceUrl = String(book.origin || '')
    const toc = await (this as any).getToc({ tocUrl: String(book.tocUrl || book.bookUrl || ''), sourceUrl })
    const chapters = (toc?.chapters ?? []) as Array<{ url?: string; title?: string }>
    const start = Number(book.durChapterIndex ?? 0) || 0
    const host = this.downloadHost()
    const retryBase = this.retryBase()
    let cached = 0
    let failed = 0
    let bytes = 0
    for (let i = start; i < chapters.length && cached + failed < limit; i += 1) {
      const url = chapters[i]?.url
      if (!url) continue
      try {
        // 与整本下载共用同一段单章逻辑：命中缓存直接计完成，否则抓取并写缓存。
        const result = await ensureChapterCached(host, sourceUrl, url, retryBase, {
          bookId,
          chapterIndex: i,
          chapterTitle: chapters[i]?.title ?? '',
        })
        if (!result.cached) bytes += result.bytes
        cached += 1
      } catch {
        failed += 1
      }
    }
    return { cached, failed, bytes, total: chapters.length, start }
  }

  async startDownload(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const options: { fromIndex?: number; toIndex?: number; all?: boolean } = {}
    if (args?.all === true || args?.all === 'true') options.all = true
    if (args?.fromIndex !== undefined && args?.fromIndex !== null && args?.fromIndex !== '') {
      options.fromIndex = Number(args.fromIndex)
    }
    if (args?.toIndex !== undefined && args?.toIndex !== null && args?.toIndex !== '') {
      options.toIndex = Number(args.toIndex)
    }
    return this.downloadManager().start(bookId, options)
  }

  /** 媒体离线下载（#112）：漫画按章、音视频按单个文件；与文字下载同一套作业语义。 */
  async startMediaDownload(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const options: { fromIndex?: number; toIndex?: number; all?: boolean } = {}
    if (args?.all === true || args?.all === 'true') options.all = true
    if (args?.fromIndex !== undefined && args?.fromIndex !== null && args?.fromIndex !== '') {
      options.fromIndex = Number(args.fromIndex)
    }
    if (args?.toIndex !== undefined && args?.toIndex !== null && args?.toIndex !== '') {
      options.toIndex = Number(args.toIndex)
    }
    return this.mediaManager().start(bookId, options)
  }

  async pauseJob(args: Args) {
    const id = stringArg(args, 'id')
    switch (this.jobKindOf(id)) {
      case 'export':
        return this.exportManager().pause(id)
      case 'media':
        return this.mediaManager().pause(id)
      default:
        return this.downloadManager().pause(id)
    }
  }

  async resumeJob(args: Args) {
    const id = stringArg(args, 'id')
    switch (this.jobKindOf(id)) {
      case 'export':
        return this.exportManager().resume(id)
      case 'media':
        return this.mediaManager().resume(id)
      default:
        return this.downloadManager().resume(id)
    }
  }

  /** 取消对文字下载、媒体下载、导出三种作业通用：按 jobs 表里的 kind 分派。 */
  async cancelJob(args: Args) {
    const id = stringArg(args, 'id')
    switch (this.jobKindOf(id)) {
      case 'export':
        return this.exportManager().cancel(id)
      case 'media':
        return this.mediaManager().cancel(id)
      default:
        return this.downloadManager().cancel(id)
    }
  }

  async retryDownload(args: Args) {
    const id = stringArg(args, 'id')
    switch (this.jobKindOf(id)) {
      case 'export':
        return this.exportManager().retry(id)
      case 'media':
        return this.mediaManager().retry(id)
      default:
        return this.downloadManager().retry(id)
    }
  }

  async getJob(args: Args) {
    const id = stringArg(args, 'id')
    const live = this.exportsCoordinator?.peek(id)
    if (live) return { job: { ...live } }
    const media = this.mediaDownloadsCoordinator?.peek(id)
    if (media) return { job: { ...media } }
    const record = this.db?.jobs?.get?.(id) as Record<string, unknown> | undefined
    if (record?.kind === MEDIA_DOWNLOAD_KIND) return this.mediaManager().get(id)
    return this.downloadManager().get(id)
  }

  async listJobs(args: Args) {
    const filter = {
      bookId: typeof args?.bookId === 'string' ? args.bookId : undefined,
      kind: typeof args?.kind === 'string' ? args.kind : undefined,
      status: typeof args?.status === 'string' ? args.status : undefined,
    }
    // 三个协调器各自的实时进度合并展示；同一作业以后写入者（更新更实时）为准。
    const merged = new Map<string, { id: string; updatedAt?: number }>()
    for (const job of this.downloadManager().list(filter)) merged.set(job.id, job)
    for (const job of this.mediaManager().list(filter)) merged.set(job.id, job)
    for (const job of this.exportsCoordinator?.list(filter) ?? []) merged.set(job.id, job)
    return {
      jobs: [...merged.values()].sort(
        (left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0),
      ),
    }
  }

  /** 测试/关停用：等待所有下载协程收尾。 */
  async waitForDownloads() {
    await this.downloadManager().waitIdle()
  }

  /** 测试/关停用：等待所有媒体下载协程收尾。 */
  async waitForMediaDownloads() {
    await this.mediaManager().waitIdle()
  }

  /** 测试/关停用：等待所有导出协程收尾。 */
  async waitForExports() {
    await this.exportsCoordinator?.waitIdle()
  }

  /** 按书聚合下载结果：书架/详情只调一次就能显示进度、体积与当前作业。 */
  async getDownloadSummary(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    const entries = this.downloadEntriesOf(bookId)
    const bytes = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
    const job = this.downloadManager().list({ bookId, kind: DOWNLOAD_KIND })[0] ?? null
    const requested = Number(args?.total)
    const total = Math.max(
      entries.length,
      Number(book.totalChapterNum) || 0,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
    )
    return {
      summary: {
        bookId,
        total,
        downloaded: entries.length,
        failed: job?.failed ?? 0,
        skipped: job?.skipped ?? 0,
        bytes,
        job,
      },
    }
  }

  /** 按书聚合媒体下载结果：详情页与阅读页据此显示「已离线 / 下载中」。 */
  async getMediaDownloadSummary(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    const entries = this.mediaEntriesOf(bookId)
    const bytes = entries.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0)
    let kind: MediaEntryKind | '' = ''
    try {
      kind = this.mediaKindOfBook(book)
    } catch {
      // 文本/本地书没有媒体下载，摘要返回空类型即可，详情页据此隐藏入口。
      kind = ''
    }
    const job = kind ? (this.mediaManager().list({ bookId, kind: MEDIA_DOWNLOAD_KIND })[0] ?? null) : null
    const requested = Number(args?.total)
    const total = Math.max(
      entries.length,
      Number(book.totalChapterNum) || 0,
      Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0,
    )
    return {
      summary: {
        bookId,
        kind,
        total,
        downloaded: entries.length,
        failed: job?.failed ?? 0,
        skipped: job?.skipped ?? 0,
        bytes,
        job,
      },
    }
  }

  /** 按书删除媒体缓存与索引；文字缓存、阅读进度等一概不动。 */
  async deleteMediaDownloads(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const db = this.requireDb()
    const active = this.mediaManager()
      .list({ bookId, kind: MEDIA_DOWNLOAD_KIND })
      .find((job) => isActiveJob(job.status))
    if (active) {
      await this.mediaManager().cancel(active.id)
      // 等在途章节收尾，否则刚删掉的文件可能被回写、索引也被补登回来。
      await this.mediaManager().waitIdle()
    }
    const entries = this.mediaEntriesOf(bookId)
    let removed = 0
    let bytes = 0
    for (const entry of entries) {
      const storeId = mediaStoreId(bookId, Number(entry.chapterIndex ?? 0))
      await clearMediaDir(storeId)
      bytes += Number(entry.bytes) || 0
      removed += 1
    }
    const table = this.mediaEntriesTable()
    if (entries.length && table) await table.deleteMany(entries.map((entry) => String(entry.id)))
    return { removed, bytes, bookId }
  }

  /** 按书删除文字缓存与索引；书、章节、书签、笔记、进度一概不动。 */
  async deleteDownloads(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const db = this.requireDb()
    const active = this.downloadManager()
      .list({ bookId, kind: DOWNLOAD_KIND })
      .find((job) => isActiveJob(job.status))
    if (active) {
      await this.downloadManager().cancel(active.id)
      // 等在途章节收尾，否则刚删掉的文件可能被回写、索引也被补登回来。
      await this.downloadManager().waitIdle()
    }
    const book = db.books.get(bookId) as Record<string, unknown> | undefined
    const fallbackSource = String(book?.origin ?? '')
    const entries = this.downloadEntriesOf(bookId)
    let removed = 0
    let bytes = 0
    for (const entry of entries) {
      await clearChapterCache(String(entry.sourceUrl || fallbackSource), String(entry.chapterUrl))
      bytes += Number(entry.bytes) || 0
      removed += 1
    }
    if (entries.length) await db.downloadEntries.deleteMany(entries.map((entry) => String(entry.id)))
    return { removed, bytes }
  }

  /** 清空全部文字缓存，索引同步清空；不残留指向已删文件的记录。 */
  async clearDownloads() {
    const db = this.requireDb()
    const active = this.downloadManager()
      .list({ kind: DOWNLOAD_KIND })
      .filter((job) => isActiveJob(job.status))
    for (const job of active) await this.downloadManager().cancel(job.id)
    if (active.length) await this.downloadManager().waitIdle()
    const table = this.downloadEntriesTable()
    const keys = table ? (Array.from(table.keys()) as string[]) : []
    await clearChapterCache('')
    if (keys.length) await db.downloadEntries.deleteMany(keys)
    return { removed: keys.length }
  }

  async exportBook(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const limit = Math.max(1, Math.min(2000, Number(args?.limit ?? 50) || 50))
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (!book) throw new Error('书不存在')
    const sourceUrl = String(book.origin || '')
    const toc = await (this as any).getToc({ tocUrl: String(book.tocUrl || book.bookUrl || ''), sourceUrl })
    const chapters = (toc?.chapters ?? []) as Array<{ url?: string; title?: string }>
    const format = args?.format === 'epub' ? 'epub' : 'txt'
    const parts: string[] = []
    const entries: Array<{ title: string; text: string }> = []
    for (const chapter of chapters) {
      if (!chapter.url || parts.length >= limit) continue
      const cached = await readCachedChapter(sourceUrl, chapter.url)
      let text = cached ?? ''
      if (!text) {
        try {
          const content = await (this as any).getContent({ sourceUrl, chapterUrl: chapter.url })
          if (content?.kind && content.kind !== 'text') continue
          text = String(content?.content ?? '')
        } catch {
          continue
        }
      }
      if (!text) continue
      const title = chapter.title || `第${parts.length + 1}章`
      entries.push({ title, text })
      parts.push(`${title}\n\n${text}`)
    }
    if (!parts.length) throw new Error('没有可导出的章节')
    if (format === 'epub') {
      const data = await buildEpub({
        title: String(book.name || '未命名'),
        author: String(book.author || ''),
        chapters: entries,
      })
      return {
        fileName: `${String(book.name || 'book')}.epub`,
        chapters: entries.length,
        format: 'epub',
        dataBase64: data.toString('base64'),
      }
    }
    const body = `${String(book.name || '未命名')}\n作者：${String(book.author || '')}\n\n${parts.join('\n\n')}`
    return {
      fileName: `${String(book.name || 'book')}.txt`,
      chapters: parts.length,
      format: 'txt',
      dataBase64: Buffer.from(body, 'utf8').toString('base64'),
    }
  }

  /**
   * 发起全本导出（TXT / EPUB / PDF）：不截断目录，缓存优先、未缓存的在线抓，单章失败只计失败。
   * 同一本书同一格式同时只保留一个活动作业；PDF 必须在创建作业前确认中文字体可用。
   */
  async startExport(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const format = String(args?.format ?? 'txt').trim().toLowerCase()
    if (format !== 'txt' && format !== 'epub' && format !== 'pdf') {
      throw new Error('暂只支持 TXT / EPUB / PDF 导出')
    }
    if (format === 'pdf') {
      // 校验放在起作业之前：没有可用中文字体时直接拒绝，不排半成品作业。
      const fontId = typeof args?.fontId === 'string' ? args.fontId.trim() : ''
      if (!fontId) throw new Error('请先上传中文字体')
      try {
        const { font, data } = await readCustomFont(fontId)
        if (font.format !== 'truetype' && font.format !== 'opentype') throw new Error('字体格式不可嵌入')
        assertEmbeddableFont(data)
      } catch {
        throw new Error('请先上传中文字体')
      }
      return this.exportManager().start(bookId, 'pdf', { fontId })
    }
    return this.exportManager().start(bookId, format as ExportFormat)
  }

  /** 导出完成后的受保护下载地址；产物超过 24 小时按不可用处理。 */
  async getExportDownload(args: Args) {
    const jobId = stringArg(args, 'jobId')
    const record = this.requireDb().jobs.get(jobId) as Record<string, unknown> | undefined
    if (!record || record.kind !== EXPORT_KIND) throw new Error('作业不存在')
    if (record.status !== 'done') throw new Error('导出尚未完成')
    const filePath = String(record.filePath ?? '')
    if (!filePath || !(await exportArtifactExists(filePath))) throw new Error('导出文件已过期')
    return {
      url: this.exportDownloadUrl(jobId),
      fileName: String(record.fileName || `导出.${String(record.format || 'txt')}`),
    }
  }

  async getReviewSummary(args: Args) {
    const source = this.getSource(stringArg(args, 'sourceUrl'))
    const rule = reviewRule(source)
    if (!rule || !summaryIsConfigured(rule)) {
      return { supported: false, counts: {}, keys: {}, reason: '该源未配置段评' }
    }
    const book = {
      bookUrl: stringArg(args, 'bookUrl'),
      name: typeof args?.bookName === 'string' ? args.bookName : '',
      author: typeof args?.bookAuthor === 'string' ? args.bookAuthor : '',
    }
    const chapter = {
      url: stringArg(args, 'chapterUrl'),
      title: typeof args?.chapterTitle === 'string' ? args.chapterTitle : '',
      index: typeof args?.chapterIndex === 'number' ? args.chapterIndex : 0,
    }
    const request = buildReviewSummaryRequest(rule, source, book, chapter)
    if (!request) {
      return { supported: false, counts: {}, keys: {}, reason: '该源未配置段评' }
    }
    const raw = await this.fetch(request, source)
    const parsed = parseReviewSummary(raw.text, rule, source, book, chapter, raw.url)
    if (!parsed) return { supported: true, counts: {}, keys: {}, url: raw.url }
    return { supported: true, counts: parsed.counts, keys: parsed.keys, url: raw.url }
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
    const record: Record<string, unknown> = { ...book }
    // 同一文件重新导入会命中同一 id：解析字段用新的，用户设置保留旧的。
    if (existing) {
      for (const field of LOCAL_BOOK_KEEP_FIELDS) {
        if (existing[field] !== undefined) record[field] = existing[field]
      }
    }
    await this.requireDb().books.put(id, record)
    return { book: record, chapters: chapters.length }
  }

  /** 详情页用来判断本地书是否为 PDF、是否需要补原文件；非本地书按「不是 PDF」返回。 */
  async getLocalPdfStatus(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const book = this.requireDb().books.get(bookId) as Record<string, unknown> | undefined
    if (!book || book.origin !== 'local') {
      return { bookId, isPdf: false, hasOriginal: false, needsReimport: false }
    }
    const record = await readLocalBook(bookId)
    const isPdf = book.localFormat === 'pdf' || isLocalPdfRecord(record)
    const hasOriginal = isPdf ? await hasLocalPdfOriginal(bookId) : false
    const name = typeof book.name === 'string' ? book.name.trim() : ''
    return {
      bookId,
      isPdf,
      hasOriginal,
      needsReimport: isPdf && !hasOriginal,
      // 有原文件时给出可直接交给 pdf.js 的地址；缺文件时不返回地址，前端据此提示重新导入。
      ...(isPdf && hasOriginal ? { originalUrl: this.localPdfUrl(bookId) } : {}),
      ...(name ? { fileName: `${name}.pdf` } : {}),
    }
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

  async importBooks(args: Args) {
    const payload = stringArg(args, 'payload')
    // 先完成整批解析和校验，再落任何一本书。
    const parsed = parseShelfImport(payload)
    const existingKeys = new Set<string>()
    for (const [, value] of this.requireDb().books.entries()) {
      const record = value as Record<string, unknown>
      const identity = {
        name: typeof record.name === 'string' ? record.name : '',
        author: typeof record.author === 'string' ? record.author : '',
        origin: typeof record.origin === 'string' ? record.origin : '',
        bookUrl: typeof record.bookUrl === 'string' ? record.bookUrl : '',
      }
      for (const key of shelfDedupKeys(identity)) existingKeys.add(key)
    }

    const now = new Date().toISOString()
    const pending: Array<{
      record: Record<string, unknown>
      progress: Record<string, unknown> | null
    }> = []
    let skipped = parsed.duplicates

    for (const book of parsed.books) {
      const keys = shelfDedupKeys(book)
      if (keys.some((key) => existingKeys.has(key))) {
        skipped += 1
        continue
      }

      const localId = book.origin === 'local' ? localBookId(book.bookUrl) : ''
      let localMissing = false
      if (book.origin === 'local') {
        const local = localId ? await readLocalBook(localId) : null
        localMissing = !local
      }
      const metadataOnly = book.metadataOnly || localMissing
      const id =
        localId ||
        createHash('sha1')
          .update(`${book.origin}|${book.bookUrl}`)
          .digest('hex')

      const { progress, ...meta } = book
      const record: Record<string, unknown> = {
        ...meta,
        id,
        metadataOnly,
        localMissing,
        createdAt: meta.createdAt || now,
        updatedAt: now,
      }
      const pendingProgress =
        progress && (progress.chapterIndex > 0 || progress.chapterTitle || progress.chapterUrl || progress.position > 0)
          ? {
              id,
              bookId: id,
              chapterIndex: progress.chapterIndex,
              chapterTitle: progress.chapterTitle,
              chapterUrl: progress.chapterUrl,
              position: progress.position,
              updatedAt: progress.updatedAt || now,
            }
          : null

      pending.push({ record, progress: pendingProgress })
      for (const key of keys) existingKeys.add(key)
      existingKeys.add(`url:${book.origin}|${book.bookUrl}`)
    }

    for (const item of pending) {
      await this.requireDb().books.put(String(item.record.id), item.record)
      if (item.progress) await this.requireDb().readRecords.put(String(item.progress.id), item.progress)
    }

    return {
      total: parsed.books.length + parsed.duplicates,
      added: pending.length,
      skipped,
      duplicates: parsed.duplicates,
      localMissing: pending.filter((item) => item.record.localMissing === true).length,
    }
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
    // 索引扫一遍按书汇总，书架卡片不必逐本发远程调用；没有索引记录的书按 0 显示。
    const counts = new Map<string, { downloaded: number; bytes: number }>()
    for (const [, value] of this.downloadEntriesTable()?.entries() ?? []) {
      const entry = value as Record<string, unknown>
      const bookId = String(entry.bookId ?? '')
      if (!bookId) continue
      const current = counts.get(bookId) ?? { downloaded: 0, bytes: 0 }
      current.downloaded += 1
      current.bytes += Number(entry.bytes) || 0
      counts.set(bookId, current)
    }
    for (const [id, value] of this.requireDb().books.entries()) {
      const record = this.requireDb().readRecords.get(id)
      const download = counts.get(id) ?? { downloaded: 0, bytes: 0 }
      books.push({ ...(value as Record<string, unknown>), progress: record ?? null, download })
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

  /**
   * 保存阅读进度。文本进度与 PDF 原版进度共用一条 read_records 记录，
   * 这里读-改-写合并、只覆盖显式传入的字段，避免一种模式保存时抹掉另一种模式的进度。
   */
  async saveProgress(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const existing = (this.requireDb().readRecords.get(bookId) ?? {}) as Record<string, unknown>
    const record: Record<string, unknown> = {
      id: bookId,
      bookId,
      chapterIndex: 0,
      chapterTitle: '',
      chapterUrl: '',
      position: 0,
      ...existing,
    }
    if (args?.chapterIndex !== undefined) record.chapterIndex = Number(args.chapterIndex ?? 0) || 0
    if (typeof args?.chapterTitle === 'string') record.chapterTitle = args.chapterTitle
    if (typeof args?.chapterUrl === 'string') record.chapterUrl = args.chapterUrl
    if (args?.position !== undefined) record.position = Number(args.position ?? 0) || 0
    // PDF 原版进度：页码 0 起、缩放百分比限制在 50–300、是否适应宽度。
    if (args?.pdfPage !== undefined) {
      const page = Math.floor(Number(args.pdfPage))
      if (Number.isFinite(page) && page >= 0) record.pdfPage = page
    }
    if (args?.pdfZoom !== undefined) {
      const zoom = Number(args.pdfZoom)
      if (Number.isFinite(zoom)) record.pdfZoom = Math.min(300, Math.max(50, Math.round(zoom)))
    }
    if (typeof args?.pdfFitWidth === 'boolean') record.pdfFitWidth = args.pdfFitWidth
    record.updatedAt = new Date().toISOString()
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

  async listNotes(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const notes: Array<Record<string, unknown>> = []
    for (const [, value] of this.requireDb().notes.entries()) {
      const record = value as Record<string, unknown>
      if (record.bookId === bookId) notes.push(record)
    }
    notes.sort((a, b) => {
      const chapter = Number(a.chapterIndex ?? 0) - Number(b.chapterIndex ?? 0)
      if (chapter !== 0) return chapter
      return Number(a.page ?? 0) - Number(b.page ?? 0)
    })
    return { notes }
  }

  async saveNote(args: Args) {
    const bookId = stringArg(args, 'bookId')
    const chapterIndex = Number(args?.chapterIndex ?? 0) || 0
    const page = Number(args?.page ?? 0) || 0
    const type = typeof args?.type === 'string' && args.type ? args.type : 'note'
    const quote = typeof args?.quote === 'string' ? args.quote : ''
    const content = typeof args?.content === 'string' ? args.content : ''
    const id = createHash('sha1')
      .update(`${bookId}|${chapterIndex}|${page}|${type}|${quote}`)
      .digest('hex')
      .slice(0, 24)
    const existing = this.requireDb().notes.get(id) as Record<string, unknown> | undefined
    const record = {
      id,
      bookId,
      type,
      chapterIndex,
      chapterTitle: typeof args?.chapterTitle === 'string' ? args.chapterTitle : '',
      chapterUrl: typeof args?.chapterUrl === 'string' ? args.chapterUrl : '',
      page,
      quote,
      content,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    await this.requireDb().notes.put(id, record)
    return { note: record }
  }

  async deleteNote(args: Args) {
    const id = stringArg(args, 'id')
    const deleted = await this.requireDb().notes.delete(id)
    return { deleted: deleted ? 1 : 0 }
  }

  async listRssSources() {
    const rssSources: Array<Record<string, unknown>> = []
    for (const [, value] of this.requireDb().subscriptions.entries()) {
      rssSources.push(value as Record<string, unknown>)
    }
    rssSources.sort((a, b) => String(a.sourceName ?? '').localeCompare(String(b.sourceName ?? ''), 'zh'))
    return { rssSources }
  }

  async importRssSources(args: Args) {
    const list = parseRssSources(args?.sources ?? args?.payload ?? args)
    if (list.length === 0) throw new Error('没有可导入的订阅源')
    let added = 0
    let updated = 0
    const errors: Array<{ name: string; message: string }> = []
    for (const source of list) {
      try {
        const id = `src-${createHash('sha1').update(source.sourceUrl).digest('hex').slice(0, 24)}`
        const existing = this.requireDb().subscriptions.get(id) as Record<string, unknown> | undefined
        const record = {
          ...source,
          id,
          sourceGroup: source.sourceGroup ?? '',
          enabled: source.enabled !== false,
          updatedAt: new Date().toISOString(),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        }
        await this.requireDb().subscriptions.put(id, record)
        if (existing) updated += 1
        else added += 1
      } catch (error) {
        errors.push({ name: source.sourceName, message: (error as Error).message })
      }
    }
    return { added, updated, errors }
  }

  async deleteRssSource(args: Args) {
    const id = stringArg(args, 'id')
    const deleted = await this.requireDb().subscriptions.delete(id)
    return { deleted: deleted ? 1 : 0 }
  }

  async getRssArticles(args: Args) {
    const id = stringArg(args, 'id')
    const record = this.requireDb().subscriptions.get(id) as Record<string, unknown> | undefined
    if (!record) throw new Error('订阅源不存在')
    const headers = parseHeaders(typeof record.header === 'string' ? record.header : '')
    const result = await fetchText(String(record.sourceUrl), { headers })
    const feed = parseFeed(result.text, result.url)
    return { feed, sourceName: String(record.sourceName ?? '') }
  }

  async getSettings() {
    return { settings: this.requireDb().settings.get() }
  }

  async saveSettings(args: Args) {
    const patch = args?.settings
    if (!patch || typeof patch !== 'object') throw new Error('缺少参数 settings')
    const current = this.requireDb().settings.get()
    const changedFont = typeof (patch as any).fontId === 'string' && (patch as any).fontId !== current.fontId
    if (changedFont && (patch as any).fontId) {
      const fonts = await listCustomFonts()
      if (!fonts.some((font) => font.id === (patch as any).fontId)) throw new Error('字体不存在')
    }
    const patchRecord = patch as Record<string, unknown>
    const customThemes =
      patchRecord.customThemes === undefined
        ? current.customThemes ?? []
        : normalizeCustomThemes(patchRecord.customThemes)
    const requestedTheme = patchRecord.theme
    if (requestedTheme !== undefined) {
      if (typeof requestedTheme !== 'string' || !requestedTheme) throw new Error('主题无效')
      if (!isKnownTheme(requestedTheme, customThemes)) throw new Error('主题不存在')
    }
    const nextTheme =
      typeof requestedTheme === 'string' && isKnownTheme(requestedTheme, customThemes)
        ? requestedTheme
        : isKnownTheme(current.theme, customThemes)
          ? current.theme
          : 'light'
    const next = { ...current, ...patchRecord, theme: nextTheme, customThemes }
    await this.requireDb().settings.set(next)
    return { settings: next }
  }

  async listFonts() {
    return { fonts: await listCustomFonts() }
  }

  async uploadFont(args: Args) {
    const fileName = stringArg(args, 'fileName')
    const data = stringArg(args, 'dataBase64')
    if (data.length > 28 * 1024 * 1024) throw new Error('字体文件不能超过 20MB')
    const buffer = Buffer.from(data, 'base64')
    if (buffer.length === 0) throw new Error('字体文件为空')
    const result = await saveCustomFont(fileName, buffer)
    return result
  }

  async getFont(args: Args) {
    const id = stringArg(args, 'id')
    const { font, data, mime } = await readCustomFont(id)
    return { font, mime, dataBase64: data.toString('base64') }
  }

  async deleteFont(args: Args) {
    const id = stringArg(args, 'id')
    const result = await removeCustomFont(id)
    const current = this.requireDb().settings.get()
    if (result.deleted && current.fontId === id) {
      await this.requireDb().settings.set({ ...current, fontId: '' })
    }
    return result
  }

  private exportManager(): ExportCoordinator {
    if (!this.exportsCoordinator) {
      this.exportsCoordinator = new ExportCoordinator(this.exportHost())
    }
    return this.exportsCoordinator
  }

  private exportHost(): ExportHost {
    return {
      db: () => this.requireDb(),
      loadToc: async (book) => {
        const toc = await (this as any).getToc({
          tocUrl: String(book.tocUrl || book.bookUrl || ''),
          sourceUrl: String(book.origin || ''),
        })
        return (toc?.chapters ?? []) as Array<{ title?: string; url?: string; isVolume?: boolean }>
      },
      readChapter: async (book, chapterIndex, chapter) => {
        const sourceUrl = String(book.origin || '')
        const chapterUrl = String(chapter.url || '')
        // 缓存优先：已下载过的章节直接拼进导出文件，不再走网络。
        const cached = await readCachedChapter(sourceUrl, chapterUrl)
        if (cached) return cached
        const content = await (this as any).getContent({
          sourceUrl,
          chapterUrl,
          bookId: String(book.id || ''),
          chapterIndex,
          chapterTitle: chapter.title ?? '',
        })
        if (content?.kind && content.kind !== 'text') throw new Error('章节不是文本')
        const text = String(content?.content ?? '')
        if (!text.trim()) throw new Error('章节正文为空')
        return text
      },
      loadCover: (book) => this.fetchExportCover(book),
      loadFont: async (fontId) => {
        const { font, data } = await readCustomFont(fontId)
        return { data, format: font.format }
      },
    }
  }

  /** 导出封面：任何失败都只当没有封面，绝不阻断整本导出。 */
  private async fetchExportCover(book: Record<string, unknown>) {
    return loadCoverImage(String(book.coverUrl ?? ''))
  }

  /** 作业分派：活动作业先问协调器，再读 jobs 表里的 kind。 */
  private jobKindOf(id: string): 'export' | 'media' | 'download' {
    if (this.exportsCoordinator?.peek(id)) return 'export'
    if (this.mediaDownloadsCoordinator?.peek(id)) return 'media'
    const record = this.db?.jobs?.get?.(id) as Record<string, unknown> | undefined
    if (record?.kind === EXPORT_KIND) return 'export'
    if (record?.kind === MEDIA_DOWNLOAD_KIND) return 'media'
    return 'download'
  }

  /** 受保护路由的产物定位：只认 jobs 表里 kind=export 且 status=done 的那条记录。 */
  private async locateExportArtifact(jobId: string): Promise<ArtifactDescriptor | null> {
    const jobs = this.db?.jobs
    if (!jobs || typeof jobs.get !== 'function') return null
    const record = jobs.get(jobId) as Record<string, unknown> | undefined
    if (!record || record.kind !== EXPORT_KIND) return null
    if (record.status !== 'done') return null
    const filePath = String(record.filePath ?? '')
    if (!filePath) return null
    const format = String(record.format ?? 'txt')
    return {
      filePath,
      fileName: String(record.fileName || `导出.${format}`),
      contentType: contentTypeOf(format),
    }
  }

  /** PDF 原文件地址：宿主还没监听时返回相对路径，浏览器里同样能取到。 */
  private localPdfUrl(bookId: string): string {
    let origin = ''
    try {
      const value = (this.ctx as any)?.webServer?.getOrigin?.()
      if (typeof value === 'string') origin = value.replace(/\/+$/, '')
    } catch {
      // 拿不到 origin 不影响取文件：相对地址在页面里同样可用。
    }
    return `${origin}${LOCAL_PDF_ROUTE_PATH}/${bookId}`
  }

  private exportDownloadUrl(jobId: string): string {
    let origin = ''
    try {
      const value = (this.ctx as any)?.webServer?.getOrigin?.()
      if (typeof value === 'string') origin = value.replace(/\/+$/, '')
    } catch {
      // 宿主还没监听时退回相对地址，页面内照样能下载。
    }
    return `${origin}${EXPORT_ROUTE_PATH}/${encodeURIComponent(jobId)}`
  }

  /** 宿主存在 webServer 时才注册下载路由，并随服务销毁释放。 */
  private registerExportRoute(): void {
    const ctx = this.ctx as any
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['webServer'], (webCtx: any) => {
      const webServer = webCtx?.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      if (typeof webCtx.effect !== 'function') return
      webCtx.effect(
        () => {
          try {
            return registerArtifactRoute(webServer, {
              path: EXPORT_ROUTE_PATH,
              auth: 'required',
              root: () => exportRoot(),
              locate: (jobId: string) => this.locateExportArtifact(jobId),
            })
          } catch {
            // 同一宿主里已经注册过同路径路由时不重复注册，也不让启动失败。
            return () => {}
          }
        },
        'reader: export download route',
      )
    })
  }

  /** PDF 原文件路由：书 id 只做白名单校验，磁盘路径由服务端自己拼。 */
  private registerLocalPdfRoute(): void {
    const ctx = this.ctx as any
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['webServer'], (webCtx: any) => {
      const webServer = webCtx?.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      if (typeof webCtx.effect !== 'function') return
      webCtx.effect(
        () => {
          try {
            return registerProtectedFileRoute(webServer, {
              path: LOCAL_PDF_ROUTE_PATH,
              auth: 'required',
              idPattern: /^[0-9a-f]{24}$/,
              root: () => localRoot(),
              locate: async (bookId: string): Promise<FileArtifactDescriptor | null> => {
                const book = this.db?.books?.get?.(bookId) as Record<string, unknown> | undefined
                if (!book || book.origin !== 'local') return null
                const record = await readLocalBook(bookId)
                if (!record) return null
                const name = typeof book.name === 'string' ? book.name.trim() : ''
                return {
                  filePath: `${bookId}/${LOCAL_PDF_ORIGINAL}`,
                  fileName: `${name || '本地 PDF'}.pdf`,
                  contentType: 'application/pdf',
                }
              },
            })
          } catch {
            // 同一宿主里已经注册过同路径路由时不重复注册，也不让启动失败。
            return () => {}
          }
        },
        'reader: local pdf route',
      )
    })
  }

  /** 媒体代理登记表按需创建：测试里可以直接换成自定义 TTL 的实例。 */
  private mediaRegistryInstance(): MediaRegistry {
    if (!this.mediaRegistry) this.mediaRegistry = new MediaRegistry()
    return this.mediaRegistry
  }

  /** 宿主对外地址；还没监听时返回空串，代理地址退化成相对路径。 */
  private mediaOrigin(): string {
    try {
      const value = (this.ctx as any)?.webServer?.getOrigin?.()
      if (typeof value === 'string') return value.replace(/\/+$/, '')
    } catch {
      // 拿不到 origin 不影响播放：相对地址在页面里同样可用。
    }
    return ''
  }

  /**
   * 登记一条媒体地址并返回代理 URL；私网 / 非法地址登记失败时返回空串，
   * 由调用方回退原始地址——代理挂了也不该让整章阅读失败。
   */
  private async proxyMediaUrl(
    rawUrl: string,
    options: {
      headers?: Record<string, string>
      kind?: MediaKind
      referer?: string
      ext?: string
      dedupeKey?: string
    } = {},
  ): Promise<string> {
    if (!/^https?:\/\//i.test(rawUrl)) return ''
    const kind = options.kind ?? 'other'
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    const referer = options.referer || headers.Referer || headers.referer || ''
    if (referer) headers.Referer = referer
    try {
      // 登记前先过 SSRF 守卫：代理抓取时还会逐跳再查一次。
      await assertPublicHttpUrl(rawUrl)
    } catch {
      return ''
    }
    const ext = options.ext ?? extFromUrl(rawUrl, defaultExtForKind(kind))
    const token = this.mediaRegistryInstance().register(rawUrl, {
      headers,
      kind,
      ext,
      dedupeKey: options.dedupeKey,
    })
    return mediaUrlOf(this.mediaOrigin(), token, safeMediaName(rawUrl), ext)
  }

  /** 代理抓取已登记的媒体地址；测试替换 mediaStreamOpener 即可不联网。 */
  async openMediaEntry(
    entry: MediaEntry,
    options: { method: 'GET' | 'HEAD'; range?: string },
  ): Promise<MediaStreamResult> {
    const opener = this.mediaStreamOpener ?? openMediaStream
    return opener(entry.url, { method: options.method, headers: entry.headers, range: options.range })
  }

  /** 媒体代理路由：默认要求登录态，只认登记过的 token。 */
  private registerMediaRoute(): void {
    const ctx = this.ctx as any
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['webServer'], (webCtx: any) => {
      const webServer = webCtx?.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      if (typeof webCtx.effect !== 'function') return
      webCtx.effect(
        () => {
          try {
            return registerMediaRoute(webServer, {
              path: MEDIA_ROUTE_PATH,
              auth: 'required',
              registry: () => this.mediaRegistryInstance(),
              origin: () => this.mediaOrigin(),
              openStream: (entry, request) => this.openMediaEntry(entry, request),
            })
          } catch {
            // 同一宿主里已经注册过同路径路由时不重复注册，也不让启动失败。
            return () => {}
          }
        },
        'reader: media proxy route',
      )
    })
  }

  /** 本地媒体文件地址：id 是索引里的不可猜测摘要，路径由服务端反查。 */
  private localMediaUrl(fileId: string): string {
    return `${this.mediaOrigin()}${LOCAL_MEDIA_ROUTE_PATH}/${fileId}`
  }

  /** 受保护路由的产物定位：只认索引里登记过的文件，磁盘路径不从 URL 取。 */
  private locateLocalMediaFile(fileId: string): FileArtifactDescriptor | null {
    const table = this.mediaEntriesTable()
    if (!table) return null
    for (const [, value] of table.entries()) {
      const entry = value as Record<string, unknown>
      const files = Array.isArray(entry.files) ? (entry.files as Array<Record<string, unknown>>) : []
      const file = files.find((item) => String(item.id ?? '') === fileId)
      if (!file) continue
      const name = String(file.name ?? 'media')
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot + 1) : ''
      const title = String(entry.chapterTitle ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '媒体'
      const fileName = ext ? `${title.slice(0, 80)}.${ext}` : title.slice(0, 80)
      return {
        filePath: String(file.path ?? ''),
        fileName,
        contentType: String(file.mime ?? '') || contentTypeForExt(ext),
        disposition: 'inline',
      }
    }
    return null
  }

  /** 本地媒体文件路由：URL 只带文件摘要，Range / HEAD 与 PDF 原文件路由一致。 */
  private registerLocalMediaRoute(): void {
    const ctx = this.ctx as any
    if (typeof ctx?.inject !== 'function') return
    ctx.inject(['webServer'], (webCtx: any) => {
      const webServer = webCtx?.webServer
      if (!webServer || typeof webServer.register !== 'function') return
      if (typeof webCtx.effect !== 'function') return
      webCtx.effect(
        () => {
          try {
            return registerProtectedFileRoute(webServer, {
              path: LOCAL_MEDIA_ROUTE_PATH,
              auth: 'required',
              idPattern: /^[0-9a-f]{24}$/,
              root: () => mediaRoot(),
              locate: (fileId: string) => this.locateLocalMediaFile(fileId),
            })
          } catch {
            // 同一宿主里已经注册过同路径路由时不重复注册，也不让启动失败。
            return () => {}
          }
        },
        'reader: local media route',
      )
    })
  }

  private downloadManager(): DownloadCoordinator {
    if (!this.downloadsCoordinator) {
      this.downloadsCoordinator = new DownloadCoordinator(this.downloadHost())
    }
    return this.downloadsCoordinator
  }

  private downloadHost(): DownloadHost {
    return {
      db: () => this.requireDb(),
      getContent: (args) => (this as any).getContent(args),
      loadToc: async (book) => {
        const toc = await (this as any).getToc({
          tocUrl: String(book.tocUrl || book.bookUrl || ''),
          sourceUrl: String(book.origin || ''),
        })
        return (toc?.chapters ?? []) as Array<{ title: string; url: string; isVolume: boolean }>
      },
      currentChapterIndex: (bookId, book) => {
        const record = this.requireDb().readRecords?.get(bookId)
        const index = Number(record?.chapterIndex ?? book.durChapterIndex ?? 0)
        return Number.isFinite(index) ? index : 0
      },
      retryBaseMs: () => this.downloadRetryBaseMs,
      recordChapterDownload: (entry) => this.putDownloadEntry(entry),
    }
  }

  private mediaManager(): MediaDownloadCoordinator {
    if (!this.mediaDownloadsCoordinator) {
      this.mediaDownloadsCoordinator = new MediaDownloadCoordinator(this.mediaDownloadHost())
    }
    return this.mediaDownloadsCoordinator
  }

  private mediaDownloadHost(): MediaDownloadHost {
    return {
      db: () => this.requireDb(),
      loadToc: async (book) => {
        const toc = await (this as any).getToc({
          tocUrl: String(book.tocUrl || book.bookUrl || ''),
          sourceUrl: String(book.origin || ''),
        })
        return (toc?.chapters ?? []) as Array<{ title: string; url: string; isVolume: boolean }>
      },
      currentChapterIndex: (bookId, book) => {
        const record = this.requireDb().readRecords?.get(bookId)
        const index = Number(record?.chapterIndex ?? book.durChapterIndex ?? 0)
        return Number.isFinite(index) ? index : 0
      },
      retryBaseMs: () => this.downloadRetryBaseMs,
      mediaKind: (_bookId, book) => this.mediaKindOfBook(book),
      downloadChapterMedia: (args) => this.downloadChapterMediaForJob(args),
      recordMediaDownload: (entry) => this.putMediaEntry(entry),
      chapterMediaBytes: (bookId, chapterIndex, kind) =>
        this.mediaChapterBytes(bookId, chapterIndex, kind),
      discardChapterMedia: async (bookId, chapterIndex) => {
        await clearMediaDir(mediaStoreId(bookId, chapterIndex))
      },
    }
  }

  /** 书目记录 + 书源决定媒体类型；文本/本地书没有可下载媒体。 */
  private mediaKindOfBook(book: Record<string, unknown>): MediaEntryKind {
    const kind = this.bookContentKind(book)
    if (kind === 'images') return 'image'
    if (kind === 'audio' || kind === 'video') return kind
    throw new Error('这本书是文本类型，请用文字下载')
  }

  /** 媒体索引表；旧测试的假 db 可能没有这张表，按「无索引」处理。 */
  private mediaEntriesTable(): any | undefined {
    const table = this.requireDb().mediaEntries
    return table && typeof table.entries === 'function' ? table : undefined
  }

  private mediaEntriesOf(bookId: string): Array<Record<string, unknown>> {
    const table = this.mediaEntriesTable()
    if (!table) return []
    const entries: Array<Record<string, unknown>> = []
    for (const [, value] of table.entries()) {
      const entry = value as Record<string, unknown>
      if (String(entry.bookId ?? '') === bookId) entries.push(entry)
    }
    entries.sort((left, right) => Number(left.chapterIndex ?? 0) - Number(right.chapterIndex ?? 0))
    return entries
  }

  /** 发布可播索引：只在整章文件全部落盘后调用，重复登记保留最初时间。 */
  private async putMediaEntry(entry: MediaChapterDownload): Promise<void> {
    const table = this.mediaEntriesTable()
    if (!table) return
    const key = mediaEntryKey(entry.bookId, entry.chapterIndex)
    const existing = table.get(key) as Record<string, unknown> | undefined
    const now = Date.now()
    await table.put(key, {
      ...existing,
      id: key,
      bookId: entry.bookId,
      chapterIndex: entry.chapterIndex,
      chapterUrl: entry.chapterUrl,
      chapterTitle: entry.chapterTitle || String(existing?.chapterTitle ?? ''),
      sourceUrl: entry.sourceUrl,
      kind: entry.kind,
      mime: entry.mime,
      bytes: entry.bytes,
      files: entry.files,
      createdAt: Number(existing?.createdAt ?? 0) || now,
      updatedAt: now,
    })
  }

  /**
   * 本地优先：索引存在且每个文件都还在才返回本地地址；
   * 文件缺失/损坏时删掉索引并回退在线，阅读本身不报错（args.preferOnline 可强制在线）。
   * 无索引返回 null；索引存在但文件不完整返回 { localMissing: true }，供前端提示已改用在线。
   */
  private async localMediaContent(
    args: Args,
    kind: 'images' | 'audio' | 'video',
    chapterUrl: string,
  ): Promise<Record<string, unknown> | null> {
    if (args?.preferOnline === true) return null
    const bookId = typeof args?.bookId === 'string' ? args.bookId : ''
    const chapterIndex = Number(args?.chapterIndex)
    if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return null
    const table = this.mediaEntriesTable()
    if (!table) return null
    const key = mediaEntryKey(bookId, chapterIndex)
    const entry = table.get(key) as Record<string, unknown> | undefined
    if (!entry) return null
    const expected = kind === 'images' ? 'image' : kind
    if (String(entry.kind ?? '') !== expected) return null
    const files = Array.isArray(entry.files) ? (entry.files as Array<Record<string, unknown>>) : []
    if (!files.length) {
      await table.delete(key)
      return { localMissing: true }
    }
    const storeId = mediaStoreId(bookId, chapterIndex)
    const urls: string[] = []
    for (const file of files) {
      const id = String(file.id ?? '')
      const name = String(file.name ?? '')
      if (!id || !name || !(await mediaFilePresent(storeId, name))) {
        // 磁盘文件被删或损坏：索引立即作废，回退在线播放并提示。
        await table.delete(key)
        return { localMissing: true }
      }
      urls.push(this.localMediaUrl(id))
    }
    if (kind === 'images') {
      return { kind: 'images', images: urls, content: '', mediaUrl: '', url: chapterUrl, local: true }
    }
    return { kind, content: '', images: [], mediaUrl: urls[0], url: chapterUrl, local: true }
  }

  /** 续跑优化：本章已完整落盘则返回字节数，供协调器跳过重复下载。 */
  private async mediaChapterBytes(
    bookId: string,
    chapterIndex: number,
    kind: MediaEntryKind,
  ): Promise<number | null> {
    const table = this.mediaEntriesTable()
    if (!table) return null
    const entry = table.get(mediaEntryKey(bookId, chapterIndex)) as Record<string, unknown> | undefined
    if (!entry) return null
    const expected = kind === 'image' ? 'image' : kind
    if (String(entry.kind ?? '') !== expected) return null
    const files = Array.isArray(entry.files) ? (entry.files as Array<Record<string, unknown>>) : []
    if (!files.length) return null
    const storeId = mediaStoreId(bookId, chapterIndex)
    for (const file of files) {
      if (!(await mediaFilePresent(storeId, String(file.name ?? '')))) return null
    }
    const bytes = files.reduce((sum, file) => sum + (Number(file.bytes) || 0), 0)
    return bytes || Number(entry.bytes) || 0
  }

  /**
   * 解析本章的真实媒体地址（不登记代理）：下载器要抓原始 URL + 书源 header，
   * 不能去抓对外的 /reader/media/<token> 相对地址。
   * HLS（.m3u8）暂不在本票范围，返回 skip 让作业计为跳过而不是失败。
   */
  private async resolveChapterMediaItems(options: {
    sourceUrl: string
    chapterUrl: string
    bookUrl: string
    kind: MediaEntryKind
  }): Promise<{ items: Array<{ url: string; headers: Record<string, string>; ext: string }>; skip?: string }> {
    const source = this.getSource(options.sourceUrl)
    const sourceHeaders = parseHeaders(source.header)
    if (options.kind === 'audio' || options.kind === 'video') {
      const mediaRule = source.ruleContent?.content ?? ''
      if (!mediaRule) {
        if (this.isHlsMediaUrl(options.chapterUrl)) return { items: [], skip: 'HLS 暂不支持离线下载' }
        return {
          items: [
            {
              url: options.chapterUrl,
              headers: this.mediaHeadersWithReferer(sourceHeaders, options.bookUrl || options.chapterUrl),
              ext: extFromUrl(options.chapterUrl, defaultExtForKind(options.kind)),
            },
          ],
        }
      }
      const raw = await this.fetch({ url: options.chapterUrl, method: 'GET', headers: {} }, source)
      const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
      const mediaUrl = String(parsed.mediaUrl ?? '')
      if (!mediaUrl) throw new Error('没有解析到媒体地址')
      if (this.isHlsMediaUrl(mediaUrl)) return { items: [], skip: 'HLS 暂不支持离线下载' }
      return {
        items: [
          {
            url: mediaUrl,
            headers: this.mediaHeadersWithReferer(sourceHeaders, raw.url),
            ext: extFromUrl(mediaUrl, defaultExtForKind(options.kind)),
          },
        ],
      }
    }
    const raw = await this.fetch({ url: options.chapterUrl, method: 'GET', headers: {} }, source)
    const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
    const images = (Array.isArray(parsed.images) ? parsed.images : []).filter((image) => /^https?:\/\//i.test(image))
    if (!images.length) throw new Error('本章没有图片')
    return {
      items: images.map((image) => ({
        url: image,
        headers: this.mediaHeadersWithReferer(sourceHeaders, raw.url),
        ext: extFromUrl(image, defaultExtForKind('image')),
      })),
    }
  }

  private mediaHeadersWithReferer(
    headers: Record<string, string>,
    referer: string,
  ): Record<string, string> {
    const next: Record<string, string> = { ...headers }
    if (referer) next.Referer = referer
    return next
  }

  private isHlsMediaUrl(url: string): boolean {
    return /\.m3u8(?:[?#]|$)/i.test(url)
  }

  /** 单章媒体下载：全部文件写成功才返回条目；任何失败清空整章目录。 */
  private async downloadChapterMediaForJob(args: {
    bookId: string
    book: Record<string, unknown>
    chapterIndex: number
    chapterTitle: string
    chapterUrl: string
    sourceUrl: string
    kind: MediaEntryKind
    signal?: AbortSignal
  }): Promise<{ skipped: boolean; reason?: string; entry?: MediaChapterDownload }> {
    const storeId = mediaStoreId(args.bookId, args.chapterIndex)
    await prepareMediaDir(storeId)
    try {
      const resolved = await this.resolveChapterMediaItems({
        sourceUrl: args.sourceUrl,
        chapterUrl: args.chapterUrl,
        bookUrl: String(args.book.bookUrl || ''),
        kind: args.kind,
      })
      if (resolved.skip) {
        await clearMediaDir(storeId)
        return { skipped: true, reason: resolved.skip }
      }
      const files: MediaFileRecord[] = []
      let bytes = 0
      let mime = ''
      for (let index = 0; index < resolved.items.length; index += 1) {
        if (args.signal?.aborted) throw new Error('媒体下载已中断')
        const saved = await this.downloadMediaFile(storeId, index, resolved.items[index]!, args.signal)
        files.push({
          id: saved.id,
          name: saved.name,
          mime: saved.mime,
          bytes: saved.bytes,
          path: `${storeId}/${saved.name}`,
        })
        bytes += saved.bytes
        if (!mime) mime = saved.mime
      }
      if (!files.length) throw new Error('没有可下载的媒体')
      return {
        skipped: false,
        entry: {
          bookId: args.bookId,
          chapterIndex: args.chapterIndex,
          chapterTitle: args.chapterTitle,
          chapterUrl: args.chapterUrl,
          sourceUrl: args.sourceUrl,
          kind: args.kind,
          mime,
          bytes,
          files,
        },
      }
    } catch (error) {
      await clearMediaDir(storeId)
      throw error
    }
  }

  /** 单个媒体文件：流式落盘，避免整部视频进内存。 */
  private async downloadMediaFile(
    storeId: string,
    index: number,
    item: { url: string; headers: Record<string, string>; ext: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string; mime: string; bytes: number }> {
    const name = mediaFileName(index, item.ext)
    const opener = this.mediaStreamOpener ?? openMediaStream
    const { response } = await opener(item.url, { method: 'GET', headers: item.headers })
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    const mime =
      (response.headers.get('content-type') ?? '').split(';')[0]!.trim() || contentTypeForExt(item.ext)
    const bytes = await saveMediaStream(storeId, name, response.body, signal)
    if (!bytes) throw new Error('媒体文件为空')
    return { id: mediaFileIdOf(storeId, index), name, mime, bytes }
  }

  /** 下载索引表；旧测试的假 db 可能没有这张表，按「无索引」处理。 */
  private downloadEntriesTable(): any | undefined {
    const table = this.requireDb().downloadEntries
    return table && typeof table.entries === 'function' ? table : undefined
  }

  private downloadEntriesOf(bookId: string): Array<Record<string, unknown>> {
    const table = this.downloadEntriesTable()
    if (!table) return []
    const entries: Array<Record<string, unknown>> = []
    for (const [, value] of table.entries()) {
      const entry = value as Record<string, unknown>
      if (String(entry.bookId ?? '') === bookId) entries.push(entry)
    }
    entries.sort((left, right) => Number(left.chapterIndex ?? 0) - Number(right.chapterIndex ?? 0))
    return entries
  }

  /** 索引只记归属：一章一条，重复登记保留最初的时间并更新字节数。 */
  private async putDownloadEntry(entry: ChapterDownload): Promise<void> {
    const table = this.downloadEntriesTable()
    if (!table) return
    const key = downloadEntryKey(entry.bookId, entry.chapterIndex)
    const existing = table.get(key) as Record<string, unknown> | undefined
    // 重复登记（典型是每次阅读命中缓存）内容没变就不写，避免无意义的落盘。
    if (
      existing &&
      Number(existing.bytes) === entry.bytes &&
      String(existing.chapterUrl ?? '') === entry.chapterUrl &&
      String(existing.sourceUrl ?? '') === entry.sourceUrl
    ) {
      return
    }
    const now = Date.now()
    await table.put(key, {
      ...existing,
      id: key,
      bookId: entry.bookId,
      chapterIndex: entry.chapterIndex,
      chapterUrl: entry.chapterUrl,
      chapterTitle: entry.chapterTitle || String(existing?.chapterTitle ?? ''),
      sourceUrl: entry.sourceUrl,
      bytes: entry.bytes,
      createdAt: Number(existing?.createdAt ?? 0) || now,
      updatedAt: now,
    })
  }

  /** 阅读命中老缓存时补登索引；没有书/章信息（如导出内部调用）则跳过。 */
  private async registerKnownDownload(args: Args, sourceUrl: string, chapterUrl: string, bytes: number): Promise<void> {
    const bookId = typeof args?.bookId === 'string' ? args.bookId : ''
    const chapterIndex = Number(args?.chapterIndex)
    if (!bookId || !Number.isInteger(chapterIndex) || chapterIndex < 0) return
    try {
      await this.putDownloadEntry({
        bookId,
        chapterIndex,
        chapterTitle: typeof args?.chapterTitle === 'string' ? args.chapterTitle : '',
        chapterUrl,
        sourceUrl,
        bytes,
      })
    } catch {
      // 补登只是统计，失败不打断阅读。
    }
  }

  private retryBase(): number {
    const value = Number(this.downloadRetryBaseMs)
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETRY_BASE_MS
  }

  private requireDb(): any {
    if (!this.db) throw new Error('存储尚未就绪')
    return this.db
  }

  /** 保存与导入共用的排序值：沿用导入值 > 已有值 > 追加到末尾。 */
  private resolveDictOrder(incoming: Record<string, unknown>, existing: DictRule | undefined): number {
    const requested = incoming.customOrder
    if (typeof requested === 'number' && Number.isFinite(requested)) return requested
    if (existing && typeof existing.customOrder === 'number') return existing.customOrder
    return this.nextDictOrder()
  }

  private nextDictOrder(): number {
    let max = 0
    for (const [, value] of this.requireDb().dictRules.entries()) {
      const order = typeof (value as any).customOrder === 'number' ? (value as any).customOrder : 0
      if (order > max) max = order
    }
    return max + 1
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

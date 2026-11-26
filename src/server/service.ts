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
import { fetchText } from '../core/net/http.js'
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
import { buildEpub } from './epub-export.js'
import { listCustomFonts, readCustomFont, removeCustomFont, saveCustomFont } from './fonts.js'
import { isKnownTheme, normalizeCustomThemes } from '../core/reader/theme.js'
import { parseShelfImport, shelfDedupKeys } from '../core/reader/shelf-transfer.js'
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

/** pageHint 只是服务端按约 800 字/页给出的粗估，真实定位由阅读器 findPageFor 完成。 */
const SEARCH_PAGE_HINT_CHARS = 800
/** 结果片段在首个命中前后各保留的字数。 */
const SEARCH_SNIPPET_CONTEXT = 30

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
    const ctx = this.ctx as any
    ctx.effect(
      () => async () => {
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
    if (kind === 'audio' || kind === 'video') {
      const mediaRule = source.ruleContent?.content ?? ''
      if (!mediaRule) {
        return { kind, content: '', images: [], mediaUrl: chapterUrl, url: chapterUrl }
      }
      const raw = await this.fetch({ url: chapterUrl, method: 'GET', headers: {} }, source)
      const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
      return { ...parsed, content: '', url: raw.url }
    }
    const raw = await this.fetch({ url: chapterUrl, method: 'GET', headers: {} }, source)
    const parsed = analyzeChapterContent(raw.text, source, raw.url, raw.url)
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

  async pauseJob(args: Args) {
    return this.downloadManager().pause(stringArg(args, 'id'))
  }

  async resumeJob(args: Args) {
    return this.downloadManager().resume(stringArg(args, 'id'))
  }

  async cancelJob(args: Args) {
    return this.downloadManager().cancel(stringArg(args, 'id'))
  }

  async retryDownload(args: Args) {
    return this.downloadManager().retry(stringArg(args, 'id'))
  }

  async getJob(args: Args) {
    return this.downloadManager().get(stringArg(args, 'id'))
  }

  async listJobs(args: Args) {
    return {
      jobs: this.downloadManager().list({
        bookId: typeof args?.bookId === 'string' ? args.bookId : undefined,
        kind: typeof args?.kind === 'string' ? args.kind : undefined,
        status: typeof args?.status === 'string' ? args.status : undefined,
      }),
    }
  }

  /** 测试/关停用：等待所有下载协程收尾。 */
  async waitForDownloads() {
    await this.downloadManager().waitIdle()
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

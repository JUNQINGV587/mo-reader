import * as cheerio from 'cheerio'
import { SUBSCRIPTION_PAYLOAD_VERSION, normalizeBookContentType } from './content-types.js'
import { ReaderError } from './errors.js'
import { cleanHeaders, fetchRemote } from './http.js'
import { absoluteUrl, extractOneAsync, isJsRule, mapListAsync, nextPageRule, requestConfig, responseDocument, ruleField, selectAll } from './rules.js'
import { chapterId, htmlToText, pageNumber, requiredString } from './utils.js'
import { htmlToBlocks, plainTextToBlocks } from './content-blocks.js'
import { MEDIA_PROBE_TIMEOUT_MS, MAX_MEDIA_CANDIDATES, extractMediaCandidates, firstPlayableMediaInfo, probeMediaInfo } from './media-probe.js'
import { mediaUrlKind } from './media-kind.js'
import { fetchFeed } from './rss-feed.js'


function resolveDetailUrl(template, bookUrl) {
  if (!template) return bookUrl
  const text = String(template)
  const mark = text.indexOf('##')
  if (mark < 0) return text.trim() || bookUrl
  const rest = text.slice(mark + 2)
  const split = rest.indexOf('###')
  if (split < 0) return bookUrl
  const pattern = rest.slice(0, split)
  const replacement = rest.slice(split + 3)
  try {
    return bookUrl.replace(new RegExp(pattern), replacement.replace(/\$(\d)/g, '$$$1')) || bookUrl
  } catch {
    return bookUrl
  }
}

const UNSUPPORTED_NAMES = { cookie: 'Cookie', login: '登录', captcha: '验证码', payment: '付费', webview: '网页视图', 'inject-js': '注入脚本' }
function unsupportedHint(source) {
  const names = (source?.unsupported ?? []).map(item => UNSUPPORTED_NAMES[item] || item).filter(Boolean)
  return names.length ? `该订阅源声明了${names.join('、')}能力，墨读不会使用这些能力。` : ''
}
function assertSupported(source) {
  if (source?.contentType === 'website') throw new ReaderError('reader/unsupported-source', '网站源只是站点入口，不支持搜索或抓取作品。')
  // 订阅源在导入时把 Cookie/登录/注入脚本列为「已知不可用」，这些能力不会参与抓取；
  // 真正需要它们的站点会在请求层自然失败，不需要在每次抓取前统一拦截。
  if (source?.kind === 'rss') return
  if (!source?.unsupported?.length) return
  const names = source.unsupported.map(item => UNSUPPORTED_NAMES[item] || item).join('、')
  throw new ReaderError('reader/unsupported-source', `该书源需要${names}能力，暂不支持。`)
}

function sourceVariables(source, variables) {
  return { sourceUrl: source.bookSourceUrl, ...variables }
}

function listRule(rule) {
  return ruleField(rule, 'bookList', 'chapterList', 'list', 'items', 'books')
}

function comparePublishedEntries(a, b) {
  const left = Date.parse(a.publishedAt)
  const right = Date.parse(b.publishedAt)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
  return right - left
}

function normalizeBook(item, baseUrl, contentType) {
  const bookUrl = item.bookUrl ?? item.url
  if (!item.name || !bookUrl) throw new ReaderError('reader/parse-error', '搜索结果缺少 name/bookUrl；请检查书源规则。')
  return {
    ...item,
    name: String(item.name).trim(),
    author: item.author ? String(item.author).trim() : '',
    bookUrl: absoluteUrl(bookUrl, baseUrl),
    coverUrl: absoluteUrl(item.coverUrl ?? item.cover, baseUrl) ?? '',
    intro: item.intro ? String(item.intro).trim() : '',
    contentType: normalizeBookContentType(contentType),
  }
}

function cleanContentHtml(html) {
  const $ = cheerio.load(html ?? '')
  $('script,style,iframe,object,embed,form,noscript').remove()
  return $('body').html() ?? $.root().html() ?? ''
}

function looksLikeHtml(value) {
  return typeof value === 'string' && /<(?:p|div|section|article|br|span|td|th|tr|table|h[1-6]|ul|ol|li|blockquote|pre|code|figure|figcaption|img|dl|dt|dd|hr)\b/i.test(value)
}

const DRM_PATTERN = /SAMPLE-AES|com\.apple\.streamingkeydelivery|widevine|fairplay/i

function chapterDetails(chapter, contentType) {
  return {
    contentType,
    chapter: { id: chapter?.id, title: chapter?.title, url: chapter?.url },
  }
}

function attachChapter(error, chapter, contentType) {
  const details = chapterDetails(chapter, contentType)
  if (error instanceof ReaderError) {
    error.details = { ...(error.details ?? {}), ...details }
    return error
  }
  return new ReaderError('reader/parse-error', error instanceof Error ? error.message : String(error), details, { cause: error })
}

function resolveContentType(source, book) {
  const contentType = normalizeBookContentType(source.contentType)
  if (book?.contentType !== undefined && normalizeBookContentType(book.contentType) !== contentType) {
    throw new ReaderError('reader/type-mismatch', `书源类型 ${contentType} 与作品类型 ${normalizeBookContentType(book.contentType)} 不一致。`, chapterDetails(undefined, contentType))
  }
  return contentType
}

async function ruleHeaders(source, rule, variables, fallbackUrl, fetch) {
  return (await requestConfig(rule, sourceVariables(source, variables), fallbackUrl, { source, fetch, baseUrl: fallbackUrl })).headers ?? {}
}

function uniqueHttpUrls(values, baseUrl) {
  const urls = []
  const seen = new Set()
  for (const value of values.flat(Infinity)) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed) continue
    let resolved
    try {
      resolved = absoluteUrl(trimmed, baseUrl)
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(resolved) || seen.has(resolved)) continue
    seen.add(resolved)
    urls.push(resolved)
  }
  return urls
}

function imageValuesFromHtml(html, baseUrl) {
  if (typeof html !== 'string' || !/<img\b/i.test(html)) return []
  const $ = cheerio.load(html)
  const values = []
  $('img').each((_index, node) => {
    const image = $(node)
    values.push(image.attr('data-src'), image.attr('data-original'), image.attr('src'))
  })
  return uniqueHttpUrls(values, baseUrl)
}

function splitUrlAction(selector) {
  const normalized = selector.replace(/^@css\s*:/i, '').trim()
  const match = /^(.*?)@(data-[\w-]+|src|href|attr\([^)]+\))$/i.exec(normalized)
  if (!match) return { selector: normalized, action: undefined, attribute: undefined }
  const action = match[2]
  return {
    selector: match[1],
    action,
    attribute: action.startsWith('attr(') ? action.slice(5, -1) : action,
  }
}

function comicValues(document, selector, value, baseUrl) {
  if (document.kind === 'html' && !isJsRule(selector)) {
    const { selector: core, action, attribute } = splitUrlAction(selector)
    const nodes = selectAll(document, core)
    const values = []
    for (const node of nodes) {
      const element = document.$(node)
      if (action) {
        values.push(element.attr(attribute))
        continue
      }
      if (element.is('img')) values.push(element.attr('data-src'), element.attr('data-original'), element.attr('src'))
      element.find('img').each((_index, image) => {
        const item = document.$(image)
        values.push(item.attr('data-src'), item.attr('data-original'), item.attr('src'))
      })
      values.push(...imageValuesFromHtml(element.html() ?? '', baseUrl))
    }
    return uniqueHttpUrls(values, baseUrl)
  }
  if (Array.isArray(value)) return uniqueHttpUrls(value, baseUrl)
  const images = imageValuesFromHtml(value, baseUrl)
  return images.length ? images : uniqueHttpUrls([value], baseUrl)
}

function mediaTagUrlsFromHtml(html, baseUrl) {
  if (typeof html !== 'string' || !/<(?:video|audio|source)\b/i.test(html)) return []
  const $ = cheerio.load(html)
  const values = []
  $('video,audio,source').each((_index, node) => values.push($(node).attr('src')))
  return uniqueHttpUrls(values, baseUrl)
}

function mediaCandidatesFromPages(pages, baseUrl) {
  const values = []
  const seen = new Set()
  for (const page of pages) {
    // 原始页面里有 <video>/<source>，规则结果里可能有播放器脚本生成的地址；
    // 两者按页面顺序拼起来，再按 URL 去重，首个可用地址就是最靠近页面顶部的那条线路。
    for (const html of [page.raw, page.ruleHtml]) {
      for (const url of extractMediaCandidates(html ?? '', page.baseUrl || baseUrl)) {
        if (seen.has(url)) continue
        seen.add(url)
        values.push(url)
        if (values.length >= MAX_MEDIA_CANDIDATES) return values
      }
    }
  }
  return values
}

function mediaUrlValue(document, selector, value, baseUrl) {
  if (Array.isArray(value)) return uniqueHttpUrls(value, baseUrl)[0]
  if (typeof value === 'string' && looksLikeHtml(value)) {
    const fromMedia = mediaTagUrlsFromHtml(value, baseUrl)
    if (fromMedia.length) return fromMedia[0]
  }
  if (typeof value === 'string' && !looksLikeHtml(value)) {
    const trimmed = value.trim()
    if (/^(?:https?:\/\/|\/)[^\s"'<>]+$/i.test(trimmed)) return uniqueHttpUrls([trimmed], baseUrl)[0]
  }
  if (document.kind === 'html' && !isJsRule(selector)) {
    const { selector: core, action, attribute } = splitUrlAction(selector)
    if (action === 'text') return undefined
    const nodes = selectAll(document, core)
    const values = []
    for (const node of nodes) {
      const element = document.$(node)
      if (action) {
        values.push(element.attr(attribute))
        continue
      }
      if (element.is('video,audio,source')) values.push(element.attr('src'))
      element.find('video,audio,source').each((_index, media) => values.push(document.$(media).attr('src')))
      values.push(...mediaTagUrlsFromHtml(element.html() ?? '', baseUrl))
    }
    return uniqueHttpUrls(values, baseUrl)[0]
  }
  return undefined
}

export class SourceEngine {
  constructor({ fetch = fetchRemote, maxTocPages = 50, maxContentPages = 20 } = {}) {
    this.fetch = fetch
    this.maxTocPages = maxTocPages
    this.maxContentPages = maxContentPages
  }

  async document(source, rule, variables = {}, fallbackUrl, overrideUrl) {
    assertSupported(source)
    const config = await requestConfig(rule, sourceVariables(source, variables), fallbackUrl, { source, fetch: this.fetch, baseUrl: fallbackUrl })
    const requestUrl = overrideUrl ?? config.url
    // 订阅源的静态请求头只用于抓列表/正文/探测媒体；规则头优先，源头兜底。
    const headers = { ...(source.headers ?? {}), ...(config.headers ?? {}) }
    const response = await this.fetch(requestUrl, { ...config, headers, allowHttp: source.allowHttp })
    return { document: responseDocument(response.text, response.headers['content-type']), response, requestUrl }
  }

  async search(source, { query, page = 1 }) {
    assertSupported(source)
    const rule = source.rules.search
    if (!rule?.url || !listRule(rule)) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 search/bookList 规则。')
    const { document, response } = await this.document(source, rule, { key: requiredString(query, 'query', 500), page: pageNumber(page) })
    const items = (await mapListAsync(document, listRule(rule), {
      name: ruleField(rule, 'name', 'bookName'),
      author: ruleField(rule, 'author'),
      bookUrl: ruleField(rule, 'bookUrl', 'url'),
      coverUrl: ruleField(rule, 'coverUrl', 'cover'),
      intro: ruleField(rule, 'intro', 'description'),
      latestChapter: ruleField(rule, 'latestChapter', 'lastChapter'),
    }, { key: requiredString(query, 'query', 500), page: pageNumber(page) }, { source, fetch: this.fetch, baseUrl: response.url })).map(item => normalizeBook(item, response.url, source.contentType))
    return { items, page: pageNumber(page), hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  // 订阅源搜索不是另找书源：searchUrl 只替换列表地址，条目仍用同一套 toc 规则解析。
  async subscriptionSearch(source, book, { query, page = 1 } = {}) {
    assertSupported(source)
    if (!source.searchUrl) throw new ReaderError('reader/unsupported-source', '这个订阅源没有提供搜索。')
    const configured = source.rules?.toc
    const list = listRule(configured)
    if (!list) throw new ReaderError('reader/unsupported-source', '该订阅源没有可用的文章列表规则。')
    const variables = { bookUrl: book.bookUrl, bookName: book.name, key: requiredString(query, 'query', 500), page: pageNumber(page) }
    const rule = { ...configured, url: source.searchUrl }
    const { document, response } = await this.document(source, rule, variables, book.bookUrl)
    const mapped = await mapListAsync(document, list, {
      title: ruleField(rule, 'chapterName', 'name', 'title'),
      url: ruleField(rule, 'chapterUrl', 'url'),
      coverUrl: ruleField(rule, 'chapterCover', 'coverUrl', 'cover'),
      publishedAt: ruleField(rule, 'chapterDate', 'publishedAt', 'pubDate'),
      description: ruleField(rule, 'chapterDescription', 'description'),
    }, variables, { source, fetch: this.fetch, baseUrl: response.url })
    const items = []
    const seen = new Set()
    for (const item of mapped) {
      if (!item.title || !item.url) continue
      const url = absoluteUrl(item.url, response.url)
      if (!url || seen.has(url)) continue
      seen.add(url)
      const entry = { title: String(item.title).trim(), url }
      if (item.coverUrl) entry.coverUrl = absoluteUrl(item.coverUrl, response.url)
      if (item.publishedAt) entry.publishedAt = String(item.publishedAt).trim()
      if (item.description) entry.description = String(item.description)
      items.push(entry)
    }
    return { items, page: pageNumber(page), hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  async discover(source, { exploreIndex = 0, page = 1 }) {
    assertSupported(source)
    const configured = source.rules.explore
    const rules = Array.isArray(configured) ? configured : configured?.url ? [configured] : []
    const index = Number.isInteger(exploreIndex) && exploreIndex >= 0 ? exploreIndex : 0
    const rule = rules[index]
    if (!rule) return { items: [], page: pageNumber(page), exploreIndex: index, hasMore: false }
    if (!listRule(rule)) throw new ReaderError('reader/unsupported-source', '探索规则缺少 bookList/list。')
    const { document, response } = await this.document(source, rule, { page: pageNumber(page) })
    const items = (await mapListAsync(document, listRule(rule), {
      name: ruleField(rule, 'name', 'bookName'),
      author: ruleField(rule, 'author'),
      bookUrl: ruleField(rule, 'bookUrl', 'url'),
      coverUrl: ruleField(rule, 'coverUrl', 'cover'),
      intro: ruleField(rule, 'intro', 'description'),
      latestChapter: ruleField(rule, 'latestChapter', 'lastChapter'),
    }, { page: pageNumber(page) }, { source, fetch: this.fetch, baseUrl: response.url })).map(item => normalizeBook(item, response.url, source.contentType))
    return { items, page: pageNumber(page), exploreIndex: index, hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  async bookInfo(source, bookUrl) {
    assertSupported(source)
    const rule = source.rules.bookInfo
    if (!rule || Object.keys(rule).length === 0) return { bookUrl }
    const detailUrl = resolveDetailUrl(rule.detailUrl, bookUrl)
    const { document, response } = await this.document(source, rule, { bookUrl: detailUrl }, detailUrl)
    const script = { source, fetch: this.fetch, baseUrl: response.url, variables: { bookUrl: detailUrl } }
    const item = {
      name: await extractOneAsync(document, ruleField(rule, 'name', 'bookName'), script),
      author: await extractOneAsync(document, ruleField(rule, 'author'), script),
      bookUrl,
      coverUrl: await extractOneAsync(document, ruleField(rule, 'coverUrl', 'cover'), { ...script, isUrl: true }),
      intro: await extractOneAsync(document, ruleField(rule, 'intro', 'description'), script),
      latestChapter: await extractOneAsync(document, ruleField(rule, 'latestChapter', 'lastChapter'), script),
      contentType: normalizeBookContentType(source.contentType),
    }
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key]
    if (item.coverUrl) item.coverUrl = absoluteUrl(item.coverUrl, response.url)
    return item
  }

  async toc(source, book) {
    assertSupported(source)
    const rule = source.rules.toc
    if (!rule || !listRule(rule)) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 toc/chapterList 规则。')
    const chapters = []
    const seenPages = new Set()
    const seenChapters = new Set()
    let page = 1
    let overrideUrl
    while (page <= this.maxTocPages) {
      const tocVariables = { bookUrl: book.bookUrl, bookName: book.name, page }
      const { document, response, requestUrl } = await this.document(source, rule, tocVariables, book.bookUrl, overrideUrl)
      const pageUrl = requestUrl
      if (pageUrl && seenPages.has(pageUrl)) throw new ReaderError('reader/pagination-loop', `目录分页出现循环：${pageUrl}`)
      if (pageUrl) seenPages.add(pageUrl)
      const mapped = await mapListAsync(document, listRule(rule), {
        title: ruleField(rule, 'chapterName', 'name', 'title'),
        url: ruleField(rule, 'chapterUrl', 'url'),
      }, tocVariables, { source, fetch: this.fetch, baseUrl: response.url })
      if (mapped.length === 0) break
      let added = 0
      for (const chapter of mapped) {
        if (!chapter.title || !chapter.url) throw new ReaderError('reader/parse-error', '目录条目缺少 chapterName/chapterUrl。')
        const url = absoluteUrl(chapter.url, response.url)
        if (seenChapters.has(url)) continue
        seenChapters.add(url)
        added += 1
        chapters.push({
          id: chapterId(book.id, url),
          bookId: book.id,
          index: chapters.length,
          title: String(chapter.title).trim(),
          url,
        })
      }
      if (page > 1 && added === 0) throw new ReaderError('reader/pagination-loop', `目录分页没有新增章节：${pageUrl}`)
      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = (await requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, page: page + 1 }), undefined, { source, fetch: this.fetch, baseUrl: response.url })).url
      else {
        const value = await extractOneAsync(document, next, { source, fetch: this.fetch, baseUrl: response.url, variables: tocVariables, isUrl: true })
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
      if (overrideUrl === pageUrl) throw new ReaderError('reader/pagination-loop', `目录分页指向同一地址：${pageUrl}`)
      page += 1
    }
    if (chapters.length === 0) throw new ReaderError('reader/parse-error', '目录规则没有解析到章节。')
    if (page > this.maxTocPages) throw new ReaderError('reader/too-large', `目录分页超过 ${this.maxTocPages} 页。`)
    return chapters
  }

  // 订阅源不是书源：列表来自分类页（sortUrl），翻页哨兵是 ruleNextPage=page，
  // 条目正文来自条目详情页。这里单独走一条链路，避免把「只增不删」的订阅语义
  // 混进书源的目录同步。
  async subscriptionToc(source, book) {
    assertSupported(source)
    if (source.feed === true) {
      // 标准 RSS 2.0 没有列表规则：feed 本身就是目录，条目正文就是 description/content:encoded。
      const categoryUrl = book.subscription?.sortUrl || book.bookUrl
      if (!categoryUrl) throw new ReaderError('reader/invalid-source', '订阅源缺少分类地址。')
      const feed = await fetchFeed(source, categoryUrl, this.fetch)
      const entries = []
      const seenUrls = new Set()
      for (const item of feed.entries) {
        const url = String(item.url || '').trim()
        if (!url || seenUrls.has(url)) continue
        seenUrls.add(url)
        const chapter = {
          id: chapterId(book.id, url),
          bookId: book.id,
          index: entries.length,
          title: String(item.title || '未命名条目').trim(),
          url,
        }
        if (item.coverUrl) chapter.coverUrl = item.coverUrl
        if (item.publishedAt) chapter.publishedAt = String(item.publishedAt).trim()
        if (item.description) chapter.description = String(item.description)
        entries.push(chapter)
      }
      entries.sort(comparePublishedEntries)
      if (entries.length === 0) throw new ReaderError('reader/parse-error', '这个 RSS feed 没有可阅读的条目。')
      entries.forEach((entry, index) => { entry.index = index })
      return entries
    }
    const configured = source.rules?.toc
    const list = listRule(configured)
    if (!list) throw new ReaderError('reader/unsupported-source', '该订阅源没有可用的文章列表规则。')
    const categoryUrl = book.subscription?.sortUrl || book.bookUrl
    if (!categoryUrl) throw new ReaderError('reader/invalid-source', '订阅源缺少分类地址。')
    const entries = []
    const seenPages = new Set()
    const seenUrls = new Set()
    let page = 1
    let overrideUrl

    while (page <= this.maxTocPages) {
      const variables = { bookUrl: book.bookUrl, bookName: book.name, page }
      const rule = { ...configured, url: categoryUrl }
      const { document, response, requestUrl } = await this.document(source, rule, variables, book.bookUrl, overrideUrl)
      if (seenPages.has(requestUrl)) throw new ReaderError('reader/pagination-loop', `订阅分页出现循环：${requestUrl}`)
      seenPages.add(requestUrl)
      const mapped = await mapListAsync(document, list, {
        title: ruleField(rule, 'chapterName', 'name', 'title'),
        url: ruleField(rule, 'chapterUrl', 'url'),
        coverUrl: ruleField(rule, 'chapterCover', 'coverUrl', 'cover'),
        publishedAt: ruleField(rule, 'chapterDate', 'publishedAt', 'pubDate'),
        description: ruleField(rule, 'chapterDescription', 'description'),
      }, variables, { source, fetch: this.fetch, baseUrl: response.url })

      let added = 0
      for (const item of mapped) {
        if (!item.title || !item.url) continue
        const url = absoluteUrl(item.url, response.url)
        if (seenUrls.has(url)) continue
        seenUrls.add(url)
        added += 1
        const chapter = {
          id: chapterId(book.id, url),
          bookId: book.id,
          index: entries.length,
          title: String(item.title).trim(),
          url,
        }
        if (item.coverUrl) chapter.coverUrl = absoluteUrl(item.coverUrl, response.url)
        if (item.publishedAt) chapter.publishedAt = String(item.publishedAt).trim()
        if (item.description) chapter.description = String(item.description)
        entries.push(chapter)
      }

      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && next.trim().toLowerCase() === 'page') {
        // Legado 的「page」哨兵：把页码加一，再请求同一个分类地址模板。
        if (!/\{\{\s*page\s*\}\}/i.test(categoryUrl)) break
        if (added === 0 && page > 1) break
        page += 1
        continue
      }
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) {
        overrideUrl = (await requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, bookName: book.name, page: page + 1 }), undefined, { source, fetch: this.fetch, baseUrl: response.url })).url
      } else {
        const value = await extractOneAsync(document, next, { source, fetch: this.fetch, baseUrl: response.url, variables, isUrl: true })
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
      if (overrideUrl === requestUrl) throw new ReaderError('reader/pagination-loop', `订阅分页指向同一地址：${requestUrl}`)
      if (added === 0 && page > 1) break
      page += 1
    }

    // 列表页通常已经新→旧，但源不保证；有可解析发布时间时按时间倒序，缺时间保持原序。
    entries.sort(comparePublishedEntries)
    if (entries.length === 0) throw new ReaderError('reader/parse-error', `订阅源没有解析到条目。${unsupportedHint(source)}`)
    return entries
  }

  async subscriptionContent(source, book, chapter) {
    assertSupported(source)
    try {
      const rule = source.rules?.content
      let html = ''
      let text = ''
      let pages = []
      if (rule && Object.keys(rule).length) {
        try {
          const result = await this.novelContent(source, book, chapter)
          html = result.html
          text = result.text
          pages = Array.isArray(result.pages) ? result.pages : []
        } catch (error) {
          // 有摘要时，正文规则失败不应让整条不可读；没有摘要才把原始错误抛给用户。
          if (!chapter.description) throw error
        }
      }
      const allowHttp = source.allowHttp === true
      // 分页正文的每一页可能来自不同的最终地址，相对图片要按各自页面解析。
      const pageParts = pages.length
        ? pages
        : (html ? [{ html, baseUrl: chapter.url, raw: html, ruleHtml: html }] : [])
      let blocks = pageParts.flatMap(part => part.html
        ? htmlToBlocks(part.html, { baseUrl: part.baseUrl || chapter.url, allowHttp })
        : []).slice(0, 2000)
      // 有播放器或视频标签时优先当视频条目；只有页面里出现零散 m3u8/mp4 字面量、
      // 又没有多少正文时也当视频。长文里的广告地址不能把整篇文章静默变成视频。
      const candidates = mediaCandidatesFromPages(pageParts, chapter.url)
      if (candidates.length) {
        const hasMediaElement = pageParts.some(part => /<(?:video|source)\b/i.test(String(part.raw ?? part.ruleHtml ?? '')))
        if (hasMediaElement || text.trim().length < 200) {
          const variables = { bookUrl: book.bookUrl, bookName: book.name, chapterUrl: chapter.url, chapterTitle: chapter.title, page: 1 }
          const declaredHeaders = { ...(source.headers ?? {}), ...(await ruleHeaders(source, rule, variables, chapter.url, this.fetch)) }
          const declaredNames = new Set(Object.keys(declaredHeaders).map(name => name.toLowerCase()))
          // cleanHeaders 会补默认 UA/Accept；落库的只保留源真正声明的头，避免把 text/html 带给 CDN。
          const headers = Object.fromEntries(Object.entries(cleanHeaders(declaredHeaders, { dropForbidden: true }))
            .filter(([name]) => declaredNames.has(name)))
          try {
            const info = await firstPlayableMediaInfo(candidates, {
              fetch: this.fetch,
              headers,
              timeoutMs: MEDIA_PROBE_TIMEOUT_MS,
              allowHttp: source.allowHttp === true,
            })
            return {
              contentType: 'subscription',
              mediaUrl: info.url,
              mediaHls: info.kind === 'hls',
              headers,
              payloadVersion: SUBSCRIPTION_PAYLOAD_VERSION,
            }
          } catch (error) {
            // 线路全挂时，已经抓到的正文/摘要仍应能读；只有确实没有正文才报媒体失效。
            if (!text.trim() && blocks.length === 0) throw error
          }
        }
      }
      if (!text.trim() && blocks.length === 0 && chapter.description) {
        const description = String(chapter.description)
        if (looksLikeHtml(description)) {
          const sanitized = cleanContentHtml(description)
          text = htmlToText(sanitized)
          blocks = htmlToBlocks(sanitized, { baseUrl: chapter.url, allowHttp })
        } else {
          text = htmlToText(description)
          blocks = plainTextToBlocks(text)
        }
      }
      if (!text.trim() && blocks.length === 0) throw new ReaderError('reader/parse-error', `这条订阅没有正文内容。${unsupportedHint(source)}`)
      if (!text.trim() && blocks.length) {
        text = blocks.map(block => {
          if (block.type === 'list') return (block.items ?? []).join('\n')
          if (block.type === 'image') return String(block.alt ?? '')
          return block.text ?? ''
        }).filter(Boolean).join('\n\n')
      }
      return {
        contentType: 'subscription',
        text: text.trim(),
        payloadVersion: SUBSCRIPTION_PAYLOAD_VERSION,
        ...(blocks.length ? { blocks } : {}),
      }
    } catch (error) {
      throw attachChapter(error, chapter, 'subscription')
    }
  }

  async content(source, book, chapter) {
    assertSupported(source)
    const contentType = resolveContentType(source, book)
    try {
      if (contentType === 'novel') return await this.novelContent(source, book, chapter)
      if (contentType === 'comic') return await this.comicContent(source, book, chapter)
      return await this.mediaContent(source, book, chapter, contentType)
    } catch (error) {
      throw attachChapter(error, chapter, contentType)
    }
  }

  async comicContent(source, book, chapter) {
    const rule = source.rules.content
    const selector = ruleField(rule, 'content', 'text', 'chapterContent', 'images')
    if (!rule || !selector) throw new ReaderError('reader/unsupported-source', '该书源没有可用的漫画图片规则。')
    const variables = { bookUrl: book.bookUrl, bookName: book.name, chapterUrl: chapter.url, chapterTitle: chapter.title, page: 1 }
    const { document, response } = await this.document(source, rule, variables, chapter.url)
    const value = await extractOneAsync(document, selector, { source, fetch: this.fetch, baseUrl: response.url, variables })
    const images = comicValues(document, selector, value, response.url)
    if (images.length === 0) throw new ReaderError('reader/parse-error', '漫画章节没有解析到图片。')
    return { contentType: 'comic', images }
  }

  async mediaContent(source, book, chapter, contentType) {
    const rule = source.rules.content
    const selector = ruleField(rule, 'content', 'text', 'chapterContent', 'url')
    if (!rule || !selector) throw new ReaderError('reader/unsupported-source', '该书源没有可用的媒体播放地址规则。')
    const variables = { bookUrl: book.bookUrl, bookName: book.name, chapterUrl: chapter.url, chapterTitle: chapter.title, page: 1 }
    const { document, response } = await this.document(source, rule, variables, chapter.url)
    const value = await extractOneAsync(document, selector, { source, fetch: this.fetch, baseUrl: response.url, variables })
    const responseText = typeof response.text === 'string' ? response.text.trimStart() : ''
    const drmEvidence = [typeof value === 'string' ? value : JSON.stringify(value ?? '')]
    if (responseText && !responseText.startsWith('<')) drmEvidence.push(responseText)
    if (DRM_PATTERN.test(drmEvidence.join('\n'))) {
      throw new ReaderError('reader/unsupported-media', '该媒体使用 SAMPLE-AES 或 DRM 加密，暂不支持。')
    }
    const mediaUrl = mediaUrlValue(document, selector, value, response.url)
    if (!mediaUrl) throw new ReaderError('reader/parse-error', '媒体章节没有解析到播放地址。')
    const headers = await ruleHeaders(source, rule, variables, chapter.url, this.fetch)
    const declaredHeaders = { ...(source.headers ?? {}), ...headers }
    const declaredNames = new Set(Object.keys(declaredHeaders).map(name => name.toLowerCase()))
    // 探测不能带 Cookie/Authorization；返回给章节的仍是源声明的原始请求头。
    const probeHeaders = Object.fromEntries(Object.entries(cleanHeaders(declaredHeaders, { dropForbidden: true }))
      .filter(([name]) => declaredNames.has(name)))
    // 无后缀地址（常见于 /play/123）只能靠响应类型区分 HLS 与直链；探一次后随章节落库。
    let mediaHls
    const knownKind = mediaUrlKind(mediaUrl)
    if (knownKind === 'hls') mediaHls = true
    else if (knownKind === 'direct') mediaHls = false
    // 抽址阶段已经判定过就复用，普通音视频再次打开章节时不再探测同一地址。
    else if (typeof chapter.mediaHls === 'boolean') mediaHls = chapter.mediaHls
    else {
      const info = await probeMediaInfo(mediaUrl, {
        fetch: this.fetch,
        headers: probeHeaders,
        timeoutMs: MEDIA_PROBE_TIMEOUT_MS,
        allowHttp: source.allowHttp === true,
      })
      if (!info) throw new ReaderError('reader/media-unavailable', '媒体地址失效：无法确认播放地址类型，请稍后重试。')
      if (info.kind === 'hls') mediaHls = true
      else if (info.kind === 'direct') mediaHls = false
      else throw new ReaderError('reader/unsupported-media', '远端地址不是可播放的音频或视频。')
    }
    return { contentType, mediaUrl, mediaHls, headers }
  }

  async novelContent(source, book, chapter) {
    assertSupported(source)
    const rule = source.rules.content
    const selector = ruleField(rule, 'content', 'text', 'chapterContent')
    if (!rule || !selector) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 content 规则。')
    let page = 1
    let overrideUrl
    const htmlParts = []
    const textParts = []
    const pageParts = []
    const seenPages = new Set()
    const seenPageTexts = new Set()
    while (page <= this.maxContentPages) {
      const contentVariables = { bookUrl: book.bookUrl, bookName: book.name, chapterUrl: chapter.url, chapterTitle: chapter.title, page }
      const { document, response, requestUrl } = await this.document(source, rule, contentVariables, chapter.url, overrideUrl)
      const pageUrl = requestUrl
      if (pageUrl && seenPages.has(pageUrl)) throw new ReaderError('reader/pagination-loop', `正文分页出现循环：${pageUrl}`)
      if (pageUrl) seenPages.add(pageUrl)
      let value
      if (isJsRule(selector)) value = await extractOneAsync(document, selector, { source, fetch: this.fetch, baseUrl: response.url, variables: contentVariables })
      else if (document.kind === 'html') {
        if (/@(?:html|text|outerHtml)$/i.test(selector)) value = await extractOneAsync(document, selector, { source, fetch: this.fetch, baseUrl: response.url, variables: contentVariables })
        else {
          // A content selector usually matches every paragraph; keep them all,
          // otherwise only the first paragraph survives.
          const nodes = selectAll(document, selector)
          value = nodes.map(node => document.$(node).html() ?? '').join('\n')
        }
      } else value = await extractOneAsync(document, selector, { source, fetch: this.fetch, baseUrl: response.url, variables: contentVariables })
      if (value === undefined) throw new ReaderError('reader/parse-error', `正文规则没有匹配章节 ${chapter.title}。`)
      const innerSelector = ruleField(rule, 'contentSelector')
      if (innerSelector && document.kind === 'json' && looksLikeHtml(value)) {
        const $ = cheerio.load(value)
        value = $(innerSelector).toArray().map(node => $.html(node)).join('\n')
      }
      const isHtml = document.kind === 'html' || looksLikeHtml(value)
      const html = isHtml ? cleanContentHtml(value) : ''
      const text = isHtml ? htmlToText(html) : String(value).trim()
      const fingerprint = text.replace(/\s+/g, ' ').trim()
      if (fingerprint && seenPageTexts.has(fingerprint)) throw new ReaderError('reader/pagination-loop', `正文分页重复相同内容：${pageUrl}`)
      if (fingerprint) seenPageTexts.add(fingerprint)
      htmlParts.push(html)
      textParts.push(text)
      pageParts.push({
        html,
        baseUrl: response.url || pageUrl || chapter.url,
        // 抽媒体地址需要未清洗的页面（script 里的 m3u8 字面量），
        // 但正文块仍只用清洗后的 html。
        raw: typeof response.text === 'string' ? response.text : '',
        ruleHtml: isHtml ? String(value) : '',
      })
      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = (await requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, chapterUrl: chapter.url, page: page + 1 }), undefined, { source, fetch: this.fetch, baseUrl: response.url })).url
      else {
        const value = await extractOneAsync(document, next, { source, fetch: this.fetch, baseUrl: response.url, variables: contentVariables, isUrl: true })
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
      if (overrideUrl === pageUrl) throw new ReaderError('reader/pagination-loop', `正文分页指向同一地址：${pageUrl}`)
      page += 1
    }
    if (page > this.maxContentPages) throw new ReaderError('reader/too-large', `正文分页超过 ${this.maxContentPages} 页。`)
    return { contentType: 'novel', html: htmlParts.join('\n'), text: textParts.join('\n\n').trim(), pages: pageParts }
  }
}

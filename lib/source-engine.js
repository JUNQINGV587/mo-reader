import * as cheerio from 'cheerio'
import { normalizeBookContentType } from './content-types.js'
import { ReaderError } from './errors.js'
import { fetchRemote } from './http.js'
import { absoluteUrl, extractOneAsync, isJsRule, mapListAsync, nextPageRule, requestConfig, responseDocument, ruleField, selectAll } from './rules.js'
import { chapterId, htmlToText, pageNumber, requiredString } from './utils.js'


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

const UNSUPPORTED_NAMES = { login: '登录', captcha: '验证码', payment: '付费', webview: '网页视图' }
function assertSupported(source) {
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
  return typeof value === 'string' && /<(?:p|div|section|br|span|td|h[1-6])\b/i.test(value)
}

export class SourceEngine {
  constructor({ fetch = fetchRemote, maxTocPages = 50, maxContentPages = 20 } = {}) {
    this.fetch = fetch
    this.maxTocPages = maxTocPages
    this.maxContentPages = maxContentPages
  }

  async document(source, rule, variables = {}, fallbackUrl, overrideUrl) {
    assertSupported(source)
    const config = requestConfig(rule, sourceVariables(source, variables), fallbackUrl)
    const requestUrl = overrideUrl ?? config.url
    const response = await this.fetch(requestUrl, { ...config, allowHttp: source.allowHttp })
    return { document: responseDocument(response.text, response.headers['content-type']), response, requestUrl }
  }

  async search(source, { query, page = 1 }) {
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
    }, { key: requiredString(query, 'query', 500), page: pageNumber(page) }, { source, fetch: this.fetch })).map(item => normalizeBook(item, response.url, source.contentType))
    return { items, page: pageNumber(page), hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  async discover(source, { exploreIndex = 0, page = 1 }) {
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
    }, { page: pageNumber(page) }, { source, fetch: this.fetch })).map(item => normalizeBook(item, response.url, source.contentType))
    return { items, page: pageNumber(page), exploreIndex: index, hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  async bookInfo(source, bookUrl) {
    const rule = source.rules.bookInfo
    if (!rule || Object.keys(rule).length === 0) return { bookUrl }
    const detailUrl = resolveDetailUrl(rule.detailUrl, bookUrl)
    const { document, response } = await this.document(source, rule, { bookUrl: detailUrl }, detailUrl)
    const script = { source, fetch: this.fetch }
    const item = {
      name: await extractOneAsync(document, ruleField(rule, 'name', 'bookName'), script),
      author: await extractOneAsync(document, ruleField(rule, 'author'), script),
      bookUrl,
      coverUrl: await extractOneAsync(document, ruleField(rule, 'coverUrl', 'cover'), script),
      intro: await extractOneAsync(document, ruleField(rule, 'intro', 'description'), script),
      latestChapter: await extractOneAsync(document, ruleField(rule, 'latestChapter', 'lastChapter'), script),
      contentType: normalizeBookContentType(source.contentType),
    }
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key]
    if (item.coverUrl) item.coverUrl = absoluteUrl(item.coverUrl, response.url)
    return item
  }

  async toc(source, book) {
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
      }, tocVariables, { source, fetch: this.fetch })
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
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, page: page + 1 })).url
      else {
        const value = await extractOneAsync(document, next, { source, fetch: this.fetch })
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

  async content(source, book, chapter) {
    const rule = source.rules.content
    const selector = ruleField(rule, 'content', 'text', 'chapterContent')
    if (!rule || !selector) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 content 规则。')
    let page = 1
    let overrideUrl
    const htmlParts = []
    const textParts = []
    const seenPages = new Set()
    const seenPageTexts = new Set()
    while (page <= this.maxContentPages) {
      const contentVariables = { bookUrl: book.bookUrl, bookName: book.name, chapterUrl: chapter.url, chapterTitle: chapter.title, page }
      const { document, response, requestUrl } = await this.document(source, rule, contentVariables, chapter.url, overrideUrl)
      const pageUrl = requestUrl
      if (pageUrl && seenPages.has(pageUrl)) throw new ReaderError('reader/pagination-loop', `正文分页出现循环：${pageUrl}`)
      if (pageUrl) seenPages.add(pageUrl)
      let value
      if (isJsRule(selector)) value = await extractOneAsync(document, selector, { source, fetch: this.fetch })
      else if (document.kind === 'html') {
        if (/@(?:html|text|outerHtml)$/i.test(selector)) value = await extractOneAsync(document, selector, { source, fetch: this.fetch })
        else {
          // A content selector usually matches every paragraph; keep them all,
          // otherwise only the first paragraph survives.
          const nodes = selectAll(document, selector)
          value = nodes.map(node => document.$(node).html() ?? '').join('\n')
        }
      } else value = await extractOneAsync(document, selector, { source, fetch: this.fetch })
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
      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, chapterUrl: chapter.url, page: page + 1 })).url
      else {
        const value = await extractOneAsync(document, next, { source, fetch: this.fetch })
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
      if (overrideUrl === pageUrl) throw new ReaderError('reader/pagination-loop', `正文分页指向同一地址：${pageUrl}`)
      page += 1
    }
    if (page > this.maxContentPages) throw new ReaderError('reader/too-large', `正文分页超过 ${this.maxContentPages} 页。`)
    return { html: htmlParts.join('\n'), text: textParts.join('\n\n').trim() }
  }
}

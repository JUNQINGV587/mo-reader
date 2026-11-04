import * as cheerio from 'cheerio'
import { ReaderError } from './errors.js'
import { fetchRemote } from './http.js'
import { absoluteUrl, extractOne, mapList, nextPageRule, requestConfig, responseDocument, ruleField } from './rules.js'
import { chapterId, htmlToText, pageNumber, requiredString } from './utils.js'

function sourceVariables(source, variables) {
  return { sourceUrl: source.bookSourceUrl, ...variables }
}

function listRule(rule) {
  return ruleField(rule, 'bookList', 'chapterList', 'list', 'items', 'books')
}

function normalizeBook(item, baseUrl) {
  const bookUrl = item.bookUrl ?? item.url
  if (!item.name || !bookUrl) throw new ReaderError('reader/parse-error', '搜索结果缺少 name/bookUrl；请检查书源规则。')
  return {
    ...item,
    name: String(item.name).trim(),
    author: item.author ? String(item.author).trim() : '',
    bookUrl: absoluteUrl(bookUrl, baseUrl),
    coverUrl: absoluteUrl(item.coverUrl ?? item.cover, baseUrl) ?? '',
    intro: item.intro ? String(item.intro).trim() : '',
  }
}

function cleanContentHtml(html) {
  const $ = cheerio.load(html ?? '')
  $('script,style,iframe,object,embed,form,noscript').remove()
  return $('body').html() ?? $.root().html() ?? ''
}

export class SourceEngine {
  constructor({ fetch = fetchRemote, maxTocPages = 50, maxContentPages = 20 } = {}) {
    this.fetch = fetch
    this.maxTocPages = maxTocPages
    this.maxContentPages = maxContentPages
  }

  async document(source, rule, variables = {}, fallbackUrl, overrideUrl) {
    const config = requestConfig(rule, sourceVariables(source, variables), fallbackUrl)
    const response = await this.fetch(overrideUrl ?? config.url, { ...config, allowHttp: source.allowHttp })
    return { document: responseDocument(response.text, response.headers['content-type']), response }
  }

  async search(source, { query, page = 1 }) {
    const rule = source.rules.search
    if (!rule?.url || !listRule(rule)) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 search/bookList 规则。')
    const { document, response } = await this.document(source, rule, { key: requiredString(query, 'query', 500), page: pageNumber(page) })
    const items = mapList(document, listRule(rule), {
      name: ruleField(rule, 'name', 'bookName'),
      author: ruleField(rule, 'author'),
      bookUrl: ruleField(rule, 'bookUrl', 'url'),
      coverUrl: ruleField(rule, 'coverUrl', 'cover'),
      intro: ruleField(rule, 'intro', 'description'),
      latestChapter: ruleField(rule, 'latestChapter', 'lastChapter'),
    }).map(item => normalizeBook(item, response.url))
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
    const items = mapList(document, listRule(rule), {
      name: ruleField(rule, 'name', 'bookName'),
      author: ruleField(rule, 'author'),
      bookUrl: ruleField(rule, 'bookUrl', 'url'),
      coverUrl: ruleField(rule, 'coverUrl', 'cover'),
      intro: ruleField(rule, 'intro', 'description'),
      latestChapter: ruleField(rule, 'latestChapter', 'lastChapter'),
    }).map(item => normalizeBook(item, response.url))
    return { items, page: pageNumber(page), exploreIndex: index, hasMore: Boolean(nextPageRule(rule) && items.length) }
  }

  async bookInfo(source, bookUrl) {
    const rule = source.rules.bookInfo
    if (!rule || Object.keys(rule).length === 0) return { bookUrl }
    const { document, response } = await this.document(source, rule, { bookUrl }, bookUrl)
    const item = {
      name: extractOne(document, ruleField(rule, 'name', 'bookName')),
      author: extractOne(document, ruleField(rule, 'author')),
      bookUrl,
      coverUrl: extractOne(document, ruleField(rule, 'coverUrl', 'cover')),
      intro: extractOne(document, ruleField(rule, 'intro', 'description')),
      latestChapter: extractOne(document, ruleField(rule, 'latestChapter', 'lastChapter')),
    }
    for (const key of Object.keys(item)) if (item[key] === undefined) delete item[key]
    if (item.coverUrl) item.coverUrl = absoluteUrl(item.coverUrl, response.url)
    return item
  }

  async toc(source, book) {
    const rule = source.rules.toc
    if (!rule || !listRule(rule)) throw new ReaderError('reader/unsupported-source', '该书源没有可用的 toc/chapterList 规则。')
    const chapters = []
    let page = 1
    let overrideUrl
    while (page <= this.maxTocPages) {
      const { document, response } = await this.document(source, rule, { bookUrl: book.bookUrl, page }, book.bookUrl, overrideUrl)
      const mapped = mapList(document, listRule(rule), {
        title: ruleField(rule, 'chapterName', 'name', 'title'),
        url: ruleField(rule, 'chapterUrl', 'url'),
      })
      if (mapped.length === 0) break
      for (const chapter of mapped) {
        if (!chapter.title || !chapter.url) throw new ReaderError('reader/parse-error', '目录条目缺少 chapterName/chapterUrl。')
        chapters.push({
          id: chapterId(book.id, chapter.url),
          bookId: book.id,
          index: chapters.length,
          title: String(chapter.title).trim(),
          url: absoluteUrl(chapter.url, response.url),
        })
      }
      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, page: page + 1 })).url
      else {
        const value = extractOne(document, next)
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
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
    while (page <= this.maxContentPages) {
      const { document, response } = await this.document(source, rule, { bookUrl: book.bookUrl, chapterUrl: chapter.url, page }, chapter.url, overrideUrl)
      let contentRule = selector
      if (document.kind === 'html' && !/@(?:html|text|outerHtml)$/i.test(selector)) contentRule = `${selector}@html`
      const value = extractOne(document, contentRule)
      if (value === undefined) throw new ReaderError('reader/parse-error', `正文规则没有匹配章节 ${chapter.title}。`)
      const html = document.kind === 'html' ? cleanContentHtml(value) : ''
      const text = document.kind === 'html' ? htmlToText(html) : String(value).trim()
      htmlParts.push(html)
      textParts.push(text)
      const next = nextPageRule(rule)
      if (!next) break
      if (typeof next === 'string' && /(?:https?:\/)|\{\{\s*page\s*\}\}/i.test(next)) overrideUrl = requestConfig({ url: next }, sourceVariables(source, { bookUrl: book.bookUrl, chapterUrl: chapter.url, page: page + 1 })).url
      else {
        const value = extractOne(document, next)
        if (!value) break
        overrideUrl = absoluteUrl(value, response.url)
      }
      page += 1
    }
    if (page > this.maxContentPages) throw new ReaderError('reader/too-large', `正文分页超过 ${this.maxContentPages} 页。`)
    return { html: htmlParts.join('\n'), text: textParts.join('\n\n').trim() }
  }
}

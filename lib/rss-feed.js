import * as cheerio from 'cheerio'
import { ReaderError } from './errors.js'
import { parseRemoteUrl } from './http.js'
import { requiredString, stableId } from './utils.js'

const MAX_FEED_ITEMS = 2000
export const MAX_FEED_BYTES = 2 * 1024 * 1024
const MAX_FEED_CATEGORIES = 500

export const ATOM_UNSUPPORTED_MESSAGE = '这是 Atom feed，墨读暂不支持 Atom；请改用 RSS 2.0。'

function localName(name) {
  const value = String(name).toLowerCase()
  const colon = value.indexOf(':')
  return colon < 0 ? value : value.slice(colon + 1)
}

// 返回 DOCTYPE 结束的 > 下标，跳过内部子集与引号里的 >。
function doctypeEnd(value) {
  let quote = ''
  let depth = 0
  for (let index = '<!DOCTYPE'.length; index < value.length; index += 1) {
    const char = value[index]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') {
      depth += 1
      continue
    }
    if (char === ']') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (char === '>' && depth === 0) return index
  }
  return -1
}

function rootElement(text) {
  let value = String(text ?? '').replace(/^\uFEFF/, '').trimStart()
  // 根元素前可能有 XML 声明、xml-stylesheet、注释或 DOCTYPE；全部跳过再判断。
  for (;;) {
    if (value.startsWith('<?')) {
      const end = value.indexOf('?>')
      if (end < 0) return ''
      value = value.slice(end + 2).trimStart()
      continue
    }
    if (value.startsWith('<!--')) {
      const end = value.indexOf('-->')
      if (end < 0) return ''
      value = value.slice(end + 3).trimStart()
      continue
    }
    if (/^<!DOCTYPE\b/i.test(value)) {
      const end = doctypeEnd(value)
      if (end < 0) return ''
      value = value.slice(end + 1).trimStart()
      continue
    }
    break
  }
  const match = /^<([A-Za-z_][\w:.-]*)\b/.exec(value)
  return match ? match[1].toLowerCase() : ''
}

// 与书源 JSON 共用一个导入框：只有根元素明确的 RSS 2.0 / Atom 才走 feed 分支，
// 普通 HTML 页面留给 importSource 报「无法识别」，避免把网页误当 feed 保存。
export function feedKind(text) {
  if (typeof text !== 'string' || !text.replace(/^\uFEFF/, '').trimStart().startsWith('<')) return null
  const root = localName(rootElement(text))
  if (root === 'rss') return 'rss'
  if (root === 'feed') return 'atom'
  return null
}

function childrenNamed(node, name) {
  const wanted = String(name).toLowerCase()
  return node.children().filter((_, element) => String(element.name || '').toLowerCase() === wanted)
}

function childText(node, name) {
  const child = childrenNamed(node, name).first()
  return child.length ? child.text().trim() : ''
}

function childAttr(node, name, attribute) {
  const child = childrenNamed(node, name).first()
  return child.length ? String(child.attr(attribute) || '').trim() : ''
}

function absoluteHttp(value, baseUrl, allowHttp = false) {
  if (!value) return ''
  try {
    const url = new URL(String(value).trim(), baseUrl)
    // 条目链接与封面会落库展示，不能把 URL 里的凭据一起存进去。
    if (url.username || url.password) return ''
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    parseRemoteUrl(url.href, { allowHttp })
    return url.href
  } catch {
    return ''
  }
}

function firstImage(html, baseUrl, allowHttp = false) {
  if (!html || typeof html !== 'string' || !/<img\b/i.test(html)) return ''
  try {
    const $ = cheerio.load(html)
    return absoluteHttp($('img').first().attr('src'), baseUrl, allowHttp)
  } catch {
    return ''
  }
}

function entryCover(item, html, baseUrl, allowHttp = false) {
  const thumbnail = childAttr(item, 'media:thumbnail', 'url')
  if (thumbnail) {
    const value = absoluteHttp(thumbnail, baseUrl, allowHttp)
    if (value) return value
  }
  const media = childrenNamed(item, 'media:content').first()
  if (media.length && (/^image\//i.test(String(media.attr('type') || '')) || media.attr('medium') === 'image')) {
    const value = absoluteHttp(media.attr('url'), baseUrl, allowHttp)
    if (value) return value
  }
  const enclosure = childrenNamed(item, 'enclosure').first()
  if (enclosure.length) {
    const type = String(enclosure.attr('type') || '')
    const url = String(enclosure.attr('url') || '')
    if (/^image\//i.test(type) || /\.(?:avif|gif|jpe?g|png|webp)(?:\?|#|$)/i.test(url)) {
      const value = absoluteHttp(url, baseUrl, allowHttp)
      if (value) return value
    }
  }
  return firstImage(html, baseUrl, allowHttp)
}

// guid 不是 URL 时，用它的稳定哈希生成站内锚点，不能用条目在 feed 里的位置。
function guidIdentity(baseUrl, guid, allowHttp = false) {
  const value = String(guid).trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value) || value.startsWith('//')) {
    const direct = absoluteHttp(value, baseUrl, allowHttp)
    if (direct) return direct
  }
  try {
    const url = new URL(baseUrl)
    url.hash = 'guid-' + stableId('feed-guid', value)
    return url.href
  } catch {
    return ''
  }
}

export function parseRssFeed(text, { feedUrl, allowHttp = false } = {}) {
  const body = String(text ?? '')
  if (Buffer.byteLength(body) > MAX_FEED_BYTES) {
    throw new ReaderError('reader/too-large', 'RSS feed 超过 2 MiB，无法导入。')
  }
  const kind = feedKind(body)
  if (kind === 'atom') {
    throw new ReaderError('reader/unsupported-source', ATOM_UNSUPPORTED_MESSAGE)
  }
  if (kind !== 'rss') {
    throw new ReaderError('reader/invalid-source', '这个地址不是 RSS/Atom feed，也不是书源 JSON。')
  }
  const baseUrl = requiredString(feedUrl, 'feedUrl', 4096)
  parseRemoteUrl(baseUrl, { allowHttp })
  const $ = cheerio.load(String(text), { xmlMode: true })
  const channel = $('channel').first()
  if (!channel.length) throw new ReaderError('reader/invalid-source', '这不是有效的 RSS 2.0 feed。')
  const title = childText(channel, 'title') || new URL(baseUrl).hostname
  const entries = []
  const seen = new Set()
  childrenNamed(channel, 'item').each((index, element) => {
    const item = $(element)
    const description = childText(item, 'description')
    const encoded = childText(item, 'content:encoded')
    const html = encoded || description
    // 没有摘要/正文的条目在墨读里没有可读内容；跳过，避免生成打不开的死章节。
    if (!html.trim()) return
    const link = childText(item, 'link')
    const guid = childText(item, 'guid')
    let url = absoluteHttp(link, baseUrl, allowHttp)
    if (!url && guid) url = guidIdentity(baseUrl, guid, allowHttp)
    if (!url) return
    if (seen.has(url)) return
    seen.add(url)
    const entryTitle = childText(item, 'title') || '未命名条目'
    const publishedAt = childText(item, 'pubDate') || childText(item, 'dc:date')
    const coverUrl = entryCover(item, html, baseUrl, allowHttp)
    const entry = { title: entryTitle, url, description: html }
    if (coverUrl) entry.coverUrl = coverUrl
    if (publishedAt) entry.publishedAt = publishedAt
    entries.push(entry)
    if (entries.length >= MAX_FEED_ITEMS) return false
  })
  return { title: title.trim().slice(0, 200), entries }
}

export function normalizeFeedSource(feed, { feedUrl, allowHttp = false, categories } = {}) {
  const url = parseRemoteUrl(requiredString(feedUrl, 'feedUrl', 4096), { allowHttp })
  const name = String(feed?.title || url.hostname).trim().slice(0, 200) || url.hostname
  const list = Array.isArray(categories) && categories.length
    ? categories.map(category => ({ name: String(category.name || name).trim().slice(0, 200), url: String(category.url) }))
    : [{ name, url: url.href }]
  return {
    // feed 与 Legado 订阅源分开命名空间，同一个地址不会被两种格式互相覆盖。
    id: stableId('rss-source', 'feed', url.href),
    name,
    bookSourceUrl: url.href,
    kind: 'rss',
    contentType: 'subscription',
    allowHttp,
    enabled: true,
    unsupported: [],
    categories: list,
    headers: {},
    rules: {},
    feed: true,
  }
}

// 备份恢复不重新抓 feed；分类与名称已经存在备份里，只做格式与安全校验。
export function restoreFeedSource(raw) {
  const feedUrl = requiredString(raw?.bookSourceUrl, 'feed url', 4096)
  const allowHttp = raw.allowHttp === true
  const url = parseRemoteUrl(feedUrl, { allowHttp })
  const sourceName = String(raw.name || url.hostname).trim().slice(0, 200) || url.hostname
  const saved = Array.isArray(raw.categories) ? raw.categories : []
  if (saved.length > MAX_FEED_CATEGORIES) {
    throw new ReaderError('reader/invalid-source', '订阅源分类数量超出上限。')
  }
  const categories = []
  const seen = new Set()
  for (const category of saved) {
    if (!category || typeof category.url !== 'string' || (category.name !== undefined && typeof category.name !== 'string')) {
      throw new ReaderError('reader/invalid-source', '订阅源分类记录无效。')
    }
    const value = requiredString(category.url, 'feed category url', 4096)
    let href
    try { href = new URL(value, url.href).href } catch {
      throw new ReaderError('reader/invalid-source', `订阅源分类地址无效：${value.slice(0, 60)}`)
    }
    parseRemoteUrl(href, { allowHttp })
    if (seen.has(href)) continue
    seen.add(href)
    categories.push({ name: String(category.name || sourceName).trim().slice(0, 200), url: href })
  }
  const restored = normalizeFeedSource(
    { title: sourceName },
    { feedUrl: url.href, allowHttp, categories: categories.length ? categories : [{ name: sourceName, url: url.href }] },
  )
  restored.enabled = raw.enabled !== false
  return restored
}

export async function fetchFeed(source, url, fetch) {
  const response = await fetch(url, {
    headers: {
      ...(source?.headers ?? {}),
      accept: 'application/rss+xml, application/atom+xml;q=0.9, application/xml;q=0.8, text/xml;q=0.8, */*;q=0.1',
    },
    allowHttp: source?.allowHttp === true,
    maxBytes: MAX_FEED_BYTES,
  })
  const feedUrl = response?.url || url
  return parseRssFeed(response?.text ?? '', { feedUrl, allowHttp: source?.allowHttp === true })
}

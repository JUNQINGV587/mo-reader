import { load } from 'cheerio'
import { htmlToText, trimText } from '../source/analyze.js'

export interface FeedArticle {
  title: string
  link: string
  date: string
  summary: string
  author: string
  image: string
}

export interface ParsedFeed {
  title: string
  link: string
  description: string
  articles: FeedArticle[]
}

function absolute(url: string, base: string): string {
  if (!url) return ''
  try {
    return new URL(url, base).toString()
  } catch {
    return url
  }
}

function firstText($: any, node: any, selectors: string[]): string {
  for (const selector of selectors) {
    const found = $(node).find(selector).first()
    if (found.length) {
      const text = trimText(found.text())
      if (text) return text
    }
  }
  return ''
}

/** 解析 RSS 2.0 / Atom；返回按发布时间原序的条目。 */
export function parseFeed(xml: string, baseUrl: string): ParsedFeed {
  const $ = load(xml, { xmlMode: true })
  const isAtom = $('feed').length > 0

  const feedTitle = trimText(
    isAtom ? $('feed > title').first().text() : $('channel > title').first().text(),
  )
  const rawLink = isAtom
    ? ($('feed > link[rel="alternate"]').first().attr('href') ??
      $('feed > link').first().attr('href') ??
      '')
    : $('channel > link').first().text()
  const feedLink = absolute(trimText(rawLink), baseUrl)
  const feedDescription = htmlToText(
    (isAtom ? $('feed > subtitle').first().text() : $('channel > description').first().text()) ?? '',
  )

  const nodes = isAtom ? $('entry').toArray() : $('item').toArray()
  const articles: FeedArticle[] = []
  for (const node of nodes) {
    const item = $(node)
    const title = trimText(item.find('title').first().text())
    let link = ''
    if (isAtom) {
      const alternate = item.find('link[rel="alternate"]').first()
      link = alternate.attr('href') ?? item.find('link').first().attr('href') ?? ''
    } else {
      link = trimText(item.find('link').first().text()) || (item.find('link').first().attr('href') ?? '')
    }
    const summaryRaw =
      firstText($, node, ['description', 'summary', 'content']) || ''
    const date = firstText($, node, ['pubDate', 'published', 'updated', 'dc\\:date'])
    const author = isAtom
      ? firstText($, node, ['author > name', 'author'])
      : firstText($, node, ['author', 'dc\\:creator'])
    const image =
      item.find('enclosure').first().attr('url') ??
      item.find('media\\:content').first().attr('url') ??
      item.find('media\\:thumbnail').first().attr('url') ??
      ''
    articles.push({
      title,
      link: absolute(link, baseUrl),
      date,
      summary: htmlToText(summaryRaw),
      author,
      image: absolute(image, baseUrl),
    })
  }

  return { title: feedTitle, link: feedLink, description: feedDescription, articles }
}

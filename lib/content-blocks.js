import * as cheerio from 'cheerio'
import { parseRemoteUrl } from './http.js'

const MAX_BLOCKS = 2000
const MAX_BLOCK_TEXT = 20000
const MAX_IMAGE_URL = 4096
const REMOVED = 'script,style,iframe,object,embed,form,noscript,template,svg,canvas,video,audio,source,link,meta,title'
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'figure', 'figcaption', 'center', 'address', 'details', 'summary'])
const HEADING = /^h([1-6])$/

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function cleanCode(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').slice(0, MAX_BLOCK_TEXT)
}

function imageSource($, node) {
  for (const name of ['data-src', 'data-original', 'data-lazy-src', 'src']) {
    const value = $(node).attr(name)
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  for (const name of ['data-srcset', 'srcset']) {
    const set = $(node).attr(name)
    const first = typeof set === 'string' ? set.split(',')[0]?.trim().split(/\s+/)[0] : ''
    if (first) return first
  }
  return ''
}

function absoluteImage(value, baseUrl, allowHttp) {
  if (!value || /^data:/i.test(value)) return null
  try {
    const absolute = new URL(value, baseUrl || undefined).href
    if (absolute.length > MAX_IMAGE_URL) return null
    return parseRemoteUrl(absolute, { allowHttp }).href
  } catch {
    return null
  }
}

export function htmlToBlocks(html, { baseUrl = '', allowHttp = false } = {}) {
  const $ = cheerio.load(String(html ?? ''))
  $(REMOVED).remove()
  const blocks = []
  let inline = []

  const push = (block) => {
    if (!block || blocks.length >= MAX_BLOCKS) return
    if (typeof block.text === 'string') block.text = block.text.slice(0, MAX_BLOCK_TEXT)
    if (Array.isArray(block.items)) block.items = block.items.slice(0, 200).map(item => String(item).slice(0, MAX_BLOCK_TEXT))
    blocks.push(block)
  }

  const pushParagraph = (value) => {
    const text = cleanText(value)
    if (!text) return
    for (const line of text.split(/\n+/)) {
      const lineText = line.trim()
      if (lineText) push({ type: 'paragraph', text: lineText })
    }
  }

  const flushInline = () => {
    let buffer = ''
    for (const token of inline) {
      if (token.kind === 'text') {
        buffer += token.text
        continue
      }
      pushParagraph(buffer)
      buffer = ''
      push(token.block)
    }
    pushParagraph(buffer)
    inline = []
  }

  const appendText = (value) => {
    if (value) inline.push({ kind: 'text', text: String(value) })
  }

  const imageBlock = (node) => {
    const url = absoluteImage(imageSource($, node), baseUrl, allowHttp)
    if (!url) return null
    const alt = cleanText($(node).attr('alt'))
    return { type: 'image', url, ...(alt ? { alt: alt.slice(0, 300) } : {}) }
  }

  const appendImage = (node) => {
    const block = imageBlock(node)
    if (block) inline.push({ kind: 'image', block })
  }

  const emitHeading = (node, level) => {
    flushInline()
    const text = cleanText($(node).text())
    if (text) push({ type: 'heading', level, text })
    $(node).find('img').each((_, img) => {
      const block = imageBlock(img)
      if (block) push(block)
    })
  }

  const emitCode = (node) => {
    flushInline()
    const text = cleanCode($(node).text())
    if (!text.trim()) return
    const className = $(node).find('code').first().attr('class') ?? $(node).attr('class') ?? ''
    const language = /(?:^|\s)language-([\w-]+)/.exec(className)?.[1]
    push({ type: 'code', text, ...(language ? { lang: language } : {}) })
  }

  const emitTable = (node) => {
    flushInline()
    $(node).find('tr').each((_, row) => {
      const cells = []
      $(row).children('th,td').each((__, cell) => {
        const text = cleanText($(cell).text())
        if (text) cells.push(text)
      })
      if (cells.length) push({ type: 'paragraph', text: cells.join(' | ') })
    })
    flushInline()
  }

  const emitList = (node, ordered) => {
    flushInline()
    let items = []
    const flushList = () => {
      if (items.length) push({ type: 'list', ordered, items })
      items = []
    }
    for (const child of node.children ?? []) {
      if (child.type !== 'tag' || String(child.name ?? '').toLowerCase() !== 'li') continue
      let text = ''
      const flushItem = () => {
        const value = cleanText(text)
        if (value) items.push(value)
        text = ''
      }
      const walkItem = (itemNode) => {
        if (!itemNode) return
        if (itemNode.type === 'text') {
          text += itemNode.data
          return
        }
        if (itemNode.type !== 'tag') {
          for (const nested of itemNode.children ?? []) walkItem(nested)
          return
        }
        const itemTag = String(itemNode.name ?? '').toLowerCase()
        if (itemTag === 'img') {
          // 列表块本身不承载图片；在图前收束列表，把图片留在原顺序位置。
          flushItem()
          flushList()
          const block = imageBlock(itemNode)
          if (block) push(block)
          return
        }
        if (itemTag === 'br') {
          text += '\n'
          return
        }
        if (itemTag === 'ul' || itemTag === 'ol') {
          text += ' ' + $(itemNode).text() + ' '
          return
        }
        if (itemTag === 'p' || CONTAINERS.has(itemTag)) {
          text += ' '
          for (const nested of itemNode.children ?? []) walkItem(nested)
          text += ' '
          return
        }
        for (const nested of itemNode.children ?? []) walkItem(nested)
      }
      walkItem(child)
      flushItem()
    }
    flushList()
  }

  const emitQuote = (node) => {
    flushInline()
    let buffer = ''
    const flushQuote = () => {
      const text = cleanText(buffer)
      if (text) push({ type: 'quote', text })
      buffer = ''
    }
    const walkQuote = (quoteNode) => {
      if (!quoteNode) return
      if (quoteNode.type === 'text') {
        buffer += quoteNode.data
        return
      }
      if (quoteNode.type !== 'tag') {
        for (const nested of quoteNode.children ?? []) walkQuote(nested)
        return
      }
      const quoteTag = String(quoteNode.name ?? '').toLowerCase()
      if (quoteTag === 'img') {
        flushQuote()
        const block = imageBlock(quoteNode)
        if (block) push(block)
        return
      }
      if (quoteTag === 'br') {
        buffer += '\n'
        return
      }
      if (quoteTag === 'blockquote') {
        flushQuote()
        emitQuote(quoteNode)
        return
      }
      if (quoteTag === 'ul' || quoteTag === 'ol') {
        flushQuote()
        emitList(quoteNode, quoteTag === 'ol')
        return
      }
      if (quoteTag === 'pre') {
        flushQuote()
        emitCode(quoteNode)
        return
      }
      const quoteHeading = quoteTag.match(HEADING)
      if (quoteHeading) {
        flushQuote()
        emitHeading(quoteNode, Number(quoteHeading[1]))
        return
      }
      if (quoteTag === 'table') {
        flushQuote()
        emitTable(quoteNode)
        return
      }
      if (quoteTag === 'p' || CONTAINERS.has(quoteTag)) {
        flushQuote()
        for (const nested of quoteNode.children ?? []) walkQuote(nested)
        flushQuote()
        return
      }
      for (const nested of quoteNode.children ?? []) walkQuote(nested)
    }
    for (const child of node.children ?? []) walkQuote(child)
    flushQuote()
  }

  const walk = (node) => {
    if (!node) return
    if (node.type === 'text') {
      appendText(node.data)
      return
    }
    if (node.type !== 'tag') {
      for (const child of node.children ?? []) walk(child)
      return
    }
    const tag = String(node.name ?? '').toLowerCase()
    if (tag === 'img') {
      appendImage(node)
      return
    }
    if (tag === 'br') {
      appendText('\n')
      return
    }
    if (tag === 'hr') {
      flushInline()
      return
    }
    if (tag === 'p') {
      flushInline()
      for (const child of node.children ?? []) walk(child)
      flushInline()
      return
    }
    const heading = tag.match(HEADING)
    if (heading) {
      emitHeading(node, Number(heading[1]))
      return
    }
    if (tag === 'blockquote') {
      emitQuote(node)
      return
    }
    if (tag === 'pre') {
      emitCode(node)
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      emitList(node, tag === 'ol')
      return
    }
    if (tag === 'table') {
      emitTable(node)
      return
    }
    if (CONTAINERS.has(tag)) {
      flushInline()
      for (const child of node.children ?? []) walk(child)
      flushInline()
      return
    }
    for (const child of node.children ?? []) walk(child)
  }

  const root = $('body').length ? $('body') : $.root()
  for (const child of root[0]?.children ?? []) walk(child)
  flushInline()
  return blocks
}

export function plainTextToBlocks(text) {
  const blocks = []
  const value = String(text ?? '').replace(/\r\n?/g, '\n')
  for (const line of value.split(/\n+/)) {
    const cleaned = line.trim()
    if (cleaned) blocks.push({ type: 'paragraph', text: cleaned.slice(0, MAX_BLOCK_TEXT) })
    if (blocks.length >= MAX_BLOCKS) break
  }
  return blocks
}

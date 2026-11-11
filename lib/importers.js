import path from 'node:path'
import JSZip from 'jszip'
import * as cheerio from 'cheerio'
import { ReaderError } from './errors.js'
import { chapterId, htmlToText, id, now, stableId } from './utils.js'

export async function exportEpub(book, chapters) {
  const zip = new JSZip()
  const bookName = String(book.name || '未命名').replace(/[<>:"/\\|?*]/g, '_')
  const author = book.author || '未知作者'
  const uuid = `urn:uuid:${stableId('epub', book.id || bookName)}`

  // mimetype（必须第一个且不压缩）
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })

  // container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)

  // content.opf
  const manifest = chapters.map((ch, i) => `<item id="ch${i}" href="chapter${i}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('\n    ')
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${uuid}</dc:identifier>
    <dc:title>${escapeXml(bookName)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`)

  // nav.xhtml
  const navItems = chapters.map((ch, i) => `<li><a href="chapter${i}.xhtml">${escapeXml(ch.title || `第 ${i + 1} 章`)}</a></li>`).join('\n      ')
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(bookName)}</title></head>
<body><nav epub:type="toc"><ol>
      ${navItems}
</ol></nav></body></html>`)

  // 章节
  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i]
    const paragraphs = String(ch.text || '').split(/\n{2,}/).map(p => `<p>${escapeXml(p.trim())}</p>`).join('\n    ')
    zip.file(`OEBPS/chapter${i}.xhtml`, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeXml(ch.title || '')}</title></head>
<body><h1>${escapeXml(ch.title || '')}</h1>
    ${paragraphs}
</body></html>`)
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const TXT_CHAPTER = /^\s*(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷部篇集回][^\n\r]{0,80}|(?:chapter|chap\.)\s+[\divx-]+[^\n\r]{0,80}|(?:序章|楔子|前言|后记|番外)[^\n\r]{0,50})\s*$/gim

export function splitTxt(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const matches = [...normalized.matchAll(TXT_CHAPTER)]
  if (matches.length === 0) return [{ title: '正文', text: normalized.trim() }]
  const chapters = []
  const preface = normalized.slice(0, matches[0].index).trim()
  if (preface) chapters.push({ title: '卷首', text: preface })
  matches.forEach((match, index) => {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length
    chapters.push({ title: match[0].trim(), text: normalized.slice(start, end).trim() })
  })
  return chapters
}

function localBook(name, format, chapters, seed, metadata = {}) {
  const timestamp = now()
  const bookId = stableId('book', `${name}\0${format}\0${seed}`)
  return {
    book: {
      id: bookId,
      sourceId: 'local',
      bookUrl: `local:${bookId}`,
      name,
      author: metadata.author ?? '',
      coverUrl: metadata.coverUrl ?? '',
      coverLocal: metadata.coverLocal ?? '',
      intro: metadata.intro ?? '',
      format,
      contentType: metadata.contentType ?? 'text', // text | comic | audio | video
      local: true,
      addedAt: timestamp,
      updatedAt: timestamp,
      progress: null,
      download: { status: 'completed', total: chapters.length, done: chapters.length },
    },
    chapters: chapters.map((chapter, index) => ({
      id: chapterId(bookId, `${index}\0${chapter.title}`),
      bookId,
      index,
      title: chapter.title,
      url: `local:${bookId}/${index}`,
      text: chapter.text,
      downloadedAt: timestamp,
    })),
  }
}

export function importTxt(name, text) {
  const chapters = splitTxt(text)
  if (chapters.every(chapter => !chapter.text)) throw new ReaderError('reader/empty-import', 'TXT 文件没有可导入的正文。')
  return localBook(name, 'txt', chapters, text)
}

const COVER_MAX_BYTES = 2 * 1024 * 1024

async function epubCover(zip, opf$, manifest) {
  try {
    let entry = null
    opf$('manifest item').each((_index, element) => {
      const item = opf$(element)
      if (item.attr('properties')?.includes('cover-image')) entry = item.attr('href') ? manifest.get(item.attr('id')) : entry
    })
    if (!entry) {
      const meta = opf$('metadata meta').filter((_i, el) => opf$(el).attr('name') === 'cover').first()
      const id = meta.attr('content')
      if (id) entry = manifest.get(id)
    }
    if (!entry) return ''
    const file = zip.file(entry)
    if (!file) return ''
    const size = file._data?.uncompressedSize
    if (Number.isFinite(size) && size > COVER_MAX_BYTES) return ''
    const buffer = await file.async('nodebuffer')
    if (buffer.length > COVER_MAX_BYTES) return ''
    const ext = String(entry).toLowerCase().split('.').pop()
    const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    return `data:${type};base64,${buffer.toString('base64')}`
  } catch {
    return ''
  }
}

async function zipText(zip, entry) {
  const file = zip.file(entry)
  if (!file) throw new ReaderError('reader/invalid-epub', `EPUB 缺少文件 ${entry}。`)
  const uncompressedSize = file._data?.uncompressedSize
  if (Number.isFinite(uncompressedSize) && uncompressedSize > 16 * 1024 * 1024) {
    throw new ReaderError('reader/too-large', `EPUB 条目 ${entry} 解压后超过 16 MiB。`)
  }
  return file.async('string')
}

function opfText($, name) {
  let result = ''
  $('metadata').find('*').each((_index, element) => {
    if (element.tagName?.toLowerCase().endsWith(`:${name}`) || element.tagName?.toLowerCase() === name) result ||= $(element).text().trim()
  })
  return result
}

export async function importEpub(name, buffer) {
  let zip
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true })
  } catch (error) {
    throw new ReaderError('reader/invalid-epub', '无法读取 EPUB ZIP 包。', undefined, { cause: error })
  }
  const entries = Object.keys(zip.files).filter(entry => !zip.files[entry].dir)
  if (entries.length > 2048) throw new ReaderError('reader/too-large', 'EPUB 文件条目过多。')
  const container = await zipText(zip, 'META-INF/container.xml')
  const container$ = cheerio.load(container, { xmlMode: true })
  const opfPath = container$('rootfile').attr('full-path')
  if (!opfPath) throw new ReaderError('reader/invalid-epub', 'EPUB container.xml 没有 OPF rootfile。')
  const opf = await zipText(zip, opfPath)
  const opf$ = cheerio.load(opf, { xmlMode: true })
  const base = path.posix.dirname(opfPath)
  const manifest = new Map()
  opf$('manifest item').each((_index, element) => {
    const item = opf$(element)
    const id = item.attr('id')
    const href = item.attr('href')
    if (id && href) manifest.set(id, path.posix.normalize(path.posix.join(base, href)))
  })
  const spine = []
  opf$('spine itemref').each((_index, element) => {
    const entry = manifest.get(opf$(element).attr('idref'))
    if (entry) spine.push(entry)
  })
  if (spine.length === 0) throw new ReaderError('reader/invalid-epub', 'EPUB spine 没有可阅读的章节。')
  const chapters = []
  let total = 0
  for (let index = 0; index < spine.length; index += 1) {
    const entry = spine[index]
    const markup = await zipText(zip, entry)
    const $ = cheerio.load(markup)
    $('script,style,nav,noscript').remove()
    const title = $('h1,h2,h3').first().text().trim() || $('title').first().text().trim() || `第 ${index + 1} 节`
    const text = htmlToText($('body').html() ?? $.root().html() ?? '')
    total += Buffer.byteLength(text)
    if (total > 16 * 1024 * 1024) throw new ReaderError('reader/too-large', 'EPUB 解压正文超过 16 MiB。')
    chapters.push({ title, text })
  }
  const title = opfText(opf$, 'title') || name
  const coverLocal = await epubCover(zip, opf$, manifest)
  return localBook(title, 'epub', chapters, buffer.toString('base64'), { author: opfText(opf$, 'creator'), intro: opfText(opf$, 'description'), coverLocal })
}

export function importedSource() {
  return { id: 'local', name: '本地导入', bookSourceUrl: 'local:', allowHttp: false, rules: {} }
}

export function newImportedName(name) {
  return name.trim() || `未命名-${id('book')}`
}

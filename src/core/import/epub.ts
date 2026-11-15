import { load } from 'cheerio'
import JSZip from 'jszip'
import { posix } from 'node:path'
import { htmlToText } from '../source/analyze.js'
import type { ImportedBook, ImportedChapter } from './txt.js'

function dcText(xml: string, tag: string): string {
  const match = new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'i').exec(xml)
  return match ? match[1].replace(/<[^>]+>/g, '').trim() : ''
}

function normalizePath(value: string): string {
  let path = value.trim()
  try {
    path = decodeURIComponent(path)
  } catch {
    // 保持原样
  }
  const hash = path.indexOf('#')
  if (hash >= 0) path = path.slice(0, hash)
  const query = path.indexOf('?')
  if (query >= 0) path = path.slice(0, query)
  return posix.normalize(path.replace(/^\/+/, '').replace(/^\.\//, ''))
}

function resolvePath(baseDir: string, href: string): string {
  if (!href) return ''
  if (href.startsWith('/')) return normalizePath(href)
  return normalizePath(posix.join(baseDir || '.', href))
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path) ?? zip.file(path.replace(/^\.\//, ''))
  return file ? file.async('string') : ''
}

/** 解析 EPUB（epub2 的 toc.ncx 与 epub3 的 nav.xhtml 都支持）。 */
export async function parseEpub(buffer: Uint8Array, fileName: string): Promise<ImportedBook> {
  const zip = await JSZip.loadAsync(buffer)
  const container = await readZipText(zip, 'META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml')

  const $container = load(container, { xmlMode: true })
  const opfPath = normalizePath($container('rootfile').first().attr('full-path') ?? '')
  if (!opfPath) throw new Error('不是有效的 EPUB：缺少 package 文档')

  const opfText = await readZipText(zip, opfPath)
  const $opf = load(opfText, { xmlMode: true })
  const opfDir = posix.dirname(opfPath) === '.' ? '' : posix.dirname(opfPath)

  const baseName = fileName.replace(/\.[^.]+$/, '').trim() || '未命名'
  const name = dcText(opfText, 'title') || baseName
  const author = dcText(opfText, 'creator')
  const intro = dcText(opfText, 'description')

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>()
  $opf('manifest item').each((_, element) => {
    const $item = $opf(element)
    const id = $item.attr('id') ?? ''
    if (!id) return
    manifest.set(id, {
      href: $item.attr('href') ?? '',
      mediaType: $item.attr('media-type') ?? '',
      properties: $item.attr('properties') ?? '',
    })
  })

  const titles = new Map<string, string>()

  // epub3：manifest 里 properties="nav" 的导航文档
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes('nav'))
  if (navItem?.href) {
    const navPath = resolvePath(opfDir, navItem.href)
    const navText = await readZipText(zip, navPath)
    if (navText) {
      const $nav = load(navText)
      const navDir = posix.dirname(navPath) === '.' ? '' : posix.dirname(navPath)
      $nav('nav a[href]').each((_, element) => {
        const $a = $nav(element)
        const title = $a.text().replace(/\s+/g, ' ').trim()
        const target = resolvePath(navDir, $a.attr('href') ?? '')
        if (title && target && !titles.has(target)) titles.set(target, title)
      })
    }
  }

  // epub2：toc.ncx
  if (titles.size === 0) {
    const ncxItem = [...manifest.values()].find(
      (item) => item.mediaType === 'application/x-dtbncx+xml' || /\.ncx$/i.test(item.href),
    )
    if (ncxItem?.href) {
      const ncxPath = resolvePath(opfDir, ncxItem.href)
      const ncxText = await readZipText(zip, ncxPath)
      if (ncxText) {
        const $ncx = load(ncxText, { xmlMode: true })
        const ncxDir = posix.dirname(ncxPath) === '.' ? '' : posix.dirname(ncxPath)
        $ncx('navPoint').each((_, element) => {
          const $point = $ncx(element)
          const title = $point.find('navLabel text').first().text().trim()
          const target = resolvePath(ncxDir, $point.find('content').first().attr('src') ?? '')
          if (title && target && !titles.has(target)) titles.set(target, title)
        })
      }
    }
  }

  const spineHrefs: string[] = []
  $opf('spine itemref').each((_, element) => {
    const idref = $opf(element).attr('idref') ?? ''
    const item = manifest.get(idref)
    if (!item?.href) return
    if (item.mediaType && !/xhtml|html|xml/i.test(item.mediaType)) return
    const path = resolvePath(opfDir, item.href)
    if (path && !spineHrefs.includes(path)) spineHrefs.push(path)
  })

  // 没有 spine 时退化为按 manifest 顺序读 html
  if (spineHrefs.length === 0) {
    for (const item of manifest.values()) {
      if (/\.(x?html?)$/i.test(item.href)) {
        const path = resolvePath(opfDir, item.href)
        if (path && !spineHrefs.includes(path)) spineHrefs.push(path)
      }
    }
  }
  if (spineHrefs.length === 0) throw new Error('EPUB 没有可读取的正文')

  const chapters: ImportedChapter[] = []
  for (const path of spineHrefs) {
    const raw = await readZipText(zip, path)
    if (!raw) continue
    const content = htmlToText(raw)
    if (!content) continue
    let title = titles.get(path) ?? ''
    if (!title) {
      const $doc = load(raw)
      title = ($doc('h1, h2, h3, title').first().text() || '').replace(/\s+/g, ' ').trim()
    }
    chapters.push({ title: title || `第${chapters.length + 1}节`, content })
  }
  if (chapters.length === 0) throw new Error('EPUB 没有可读取的章节')

  return { name, author, intro, chapters }
}

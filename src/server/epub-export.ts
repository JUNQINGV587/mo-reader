import JSZip from 'jszip'

export interface EpubChapter {
  title: string
  text: string
}

export interface EpubOptions {
  title: string
  author: string
  chapters: EpubChapter[]
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function paragraphHtml(text: string): string {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeXml(line)}</p>`)
    .join('\n')
}

function chapterXhtml(title: string, text: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${escapeXml(title)}</title><meta charset="utf-8"/></head>
<body><h1>${escapeXml(title)}</h1>
${paragraphHtml(text)}
</body></html>`
}

export async function buildEpub(options: EpubOptions): Promise<Buffer> {
  const chapters = options.chapters.length ? options.chapters : [{ title: '正文', text: '（无内容）' }]
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  )

  const manifest: string[] = []
  const spine: string[] = []
  const navItems: string[] = []
  chapters.forEach((chapter, index) => {
    const id = `chapter${index + 1}`
    const href = `${id}.xhtml`
    zip.file(`OEBPS/${href}`, chapterXhtml(chapter.title, chapter.text))
    manifest.push(`<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="${id}"/>`)
    navItems.push(`<li><a href="${href}">${escapeXml(chapter.title)}</a></li>`)
  })

  const bookTitle = options.title || '未命名'
  const author = options.author || '未知作者'
  zip.file(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:mo-reader-${Date.now()}</dc:identifier>
    <dc:title>${escapeXml(bookTitle)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>`,
  )

  zip.file(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="mo-reader"/></head>
  <docTitle><text>${escapeXml(bookTitle)}</text></docTitle>
  <navMap>
    ${chapters
      .map(
        (chapter, index) =>
          `<navPoint id="nav${index + 1}" playOrder="${index + 1}"><navLabel><text>${escapeXml(chapter.title)}</text></navLabel><content src="chapter${index + 1}.xhtml"/></navPoint>`,
      )
      .join('\n    ')}
  </navMap>
</ncx>`,
  )

  zip.file(
    'OEBPS/nav.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${escapeXml(bookTitle)}</title><meta charset="utf-8"/></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>${navItems.join('')}</ol></nav></body>
</html>`,
  )

  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' })
}

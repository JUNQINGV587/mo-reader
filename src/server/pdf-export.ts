import PDFDocument from 'pdfkit'

/** A5 版心：四边留白，底部给页码留出空间。 */
export const PDF_PAGE_SIZE = 'A5'
export const PDF_MARGIN = { top: 50, bottom: 58, left: 48, right: 48 }
/** 页码基线距页面底边的距离，落在下边距内，不压正文。 */
const PDF_FOOTER_OFFSET = 32
const PDF_TITLE_SIZE = 15
const PDF_BODY_SIZE = 11
const PDF_FOOTER_SIZE = 9
const PDF_FONT_NAME = 'mo-reader-cjk'

export interface PdfChapter {
  title: string
  text: string
}

/** 与 EPUB 封面同源；PDFKit 只认 JPEG / PNG，webp 由调用方跳过。 */
export interface PdfCover {
  data: Buffer
  extension: 'jpg' | 'png' | 'webp'
}

export interface PdfOptions {
  title: string
  author?: string
  chapters: PdfChapter[]
  /** 用户已上传的中文字体字节；PDFKit 会按用到的字形子集嵌入。 */
  font: Buffer
  cover?: PdfCover | null
}

/**
 * 验证字体能否被 PDFKit 直接嵌入（TTF / CFF OTF 可以，woff/woff2 不行）。
 * 只做解析探测，不产出文件；失败由调用方转成「请先上传中文字体」。
 */
export function assertEmbeddableFont(data: Buffer): void {
  const doc = new PDFDocument({ autoFirstPage: false })
  try {
    doc.registerFont(PDF_FONT_NAME, data)
    // PDFKit 在 font() 时才真正解析字体，坏文件会在这里抛错。
    doc.font(PDF_FONT_NAME)
  } catch (error) {
    try {
      doc.end()
    } catch {
      // 探测文档本来就没有页面，end 失败不影响原始错误。
    }
    throw error
  }
  doc.end()
}

/** 正文按纯文本分段：连续换行只当段落分隔，空行忽略，图片一律不处理。 */
function paragraphsOf(text: string): string[] {
  return String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function renderCover(doc: PDFKit.PDFDocument, cover: PdfCover): void {
  doc.addPage()
  const width = doc.page.width
  const height = doc.page.height
  // fit 保持封面原始比例，放不满的地方留白，绝不拉伸变形。
  doc.image(cover.data, 0, 0, { fit: [width, height], align: 'center', valign: 'center' })
}

function renderChapter(doc: PDFKit.PDFDocument, chapter: PdfChapter): void {
  doc.addPage()
  doc.font(PDF_FONT_NAME).fontSize(PDF_TITLE_SIZE).text(chapter.title)
  doc.moveDown(0.7)
  doc.fontSize(PDF_BODY_SIZE)
  for (const paragraph of paragraphsOf(chapter.text)) {
    doc.text(paragraph, { lineGap: 3 })
    doc.moveDown(0.35)
  }
}

/** 每页底部居中写「第 N 页」；封面页不编号，正文页码从 1 开始。 */
function renderFooters(doc: PDFKit.PDFDocument, coverPages: number): void {
  const range = doc.bufferedPageRange()
  for (let index = range.start + coverPages; index < range.start + range.count; index += 1) {
    doc.switchToPage(index)
    const pageNumber = index - range.start - coverPages + 1
    const page = doc.page
    // 页码画在下边距里；临时取消下边距，避免 PDFKit 把页脚当成溢出内容另起一页。
    const bottom = page.margins.bottom
    page.margins.bottom = 0
    doc
      .font(PDF_FONT_NAME)
      .fontSize(PDF_FOOTER_SIZE)
      .text(`第 ${pageNumber} 页`, 0, page.height - PDF_FOOTER_OFFSET, {
        width: page.width,
        align: 'center',
        lineBreak: false,
      })
    page.margins.bottom = bottom
  }
}

/** 生成 A5 全本 PDF：可选封面、章节标题与正文、页码，字体子集内嵌。 */
export async function buildPdf(options: PdfOptions): Promise<Buffer> {
  const chapters = options.chapters.length ? options.chapters : [{ title: '正文', text: '（无内容）' }]
  const useCover = Boolean(options.cover && (options.cover.extension === 'jpg' || options.cover.extension === 'png'))
  const doc = new PDFDocument({
    size: PDF_PAGE_SIZE,
    margins: PDF_MARGIN,
    autoFirstPage: false,
    bufferPages: true,
    info: {
      Title: options.title || '未命名',
      Author: options.author?.trim() || '',
      Creator: '墨读',
      Producer: '墨读',
    },
  })
  doc.registerFont(PDF_FONT_NAME, options.font)
  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const finished = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve())
    doc.on('error', (error: Error) => reject(error))
  })

  if (useCover) renderCover(doc, options.cover as PdfCover)
  for (const chapter of chapters) renderChapter(doc, chapter)
  renderFooters(doc, useCover ? 1 : 0)
  doc.end()
  await finished
  return Buffer.concat(chunks)
}

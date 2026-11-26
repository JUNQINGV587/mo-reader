import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { ImportedBook, ImportedChapter } from './txt.js'

interface PdfInfo {
  Title?: unknown
  Author?: unknown
  Subject?: unknown
}

interface PdfTextItem {
  str: string
  hasEOL?: boolean
  transform?: number[]
}

function metadataText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizePageText(items: PdfTextItem[]): string {
  let text = ''
  let previousY: number | null = null
  for (const item of items) {
    if (item.str) {
      const y = item.transform?.[5]
      if (
        text &&
        !text.endsWith('\n') &&
        previousY !== null &&
        typeof y === 'number' &&
        Math.abs(y - previousY) > 2
      ) {
        text += '\n'
      }
      text += item.str
      if (typeof y === 'number') previousY = y
    }
    if (item.hasEOL) text += '\n'
  }
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function packageDirectory(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

/**
 * 两条约束：pdfjs 在 Node 下用 `fs.readFile` 读取这些资源，所以只能给文件系统路径（file:// 读不到，
 * CMap 缺失时字体文本项为空）；`getFactoryUrlProp` 又要求字符串以 `/` 结尾，否则抛 Invalid factory url。
 * 浏览器侧（原版阅读）走的是 /reader/pdfjs/ HTTP 路由，见 core/pdfjs-assets.ts。
 */
function assetDirectory(root: string, name: string): string {
  return join(root, name) + '/'
}

/** 将 PDF 按原页序提取为可检索的本地文本章节。 */
export async function parsePdf(buffer: Uint8Array, fileName: string): Promise<ImportedBook> {
  if (Buffer.from(buffer.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new Error('不是有效的 PDF 文件')
  }

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const root = packageDirectory()
  // PDF.js 会接管传入的 TypedArray；复制一份，避免原 Buffer 被 detach。
  const data = new Uint8Array(buffer.byteLength)
  data.set(buffer)
  const loadingTask = getDocument({
    data,
    cMapUrl: assetDirectory(root, 'cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDirectory(root, 'standard_fonts'),
    wasmUrl: assetDirectory(root, 'wasm'),
    disableAutoFetch: true,
    disableStream: true,
    useSystemFonts: true,
  })

  try {
    const pdf = await loadingTask.promise
    const { info } = await pdf.getMetadata()
    const metadata = info as PdfInfo
    const chapters: ImportedChapter[] = []

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      try {
        const textContent = await page.getTextContent()
        const content = normalizePageText(
          textContent.items.filter((item) => 'str' in item),
        )
        if (content) chapters.push({ title: `第 ${pageNumber} 页`, content })
      } finally {
        page.cleanup()
      }
    }

    if (chapters.length === 0) {
      throw new Error('PDF 中没有可提取的文字，暂不支持纯扫描件')
    }
    return {
      name: metadataText(metadata.Title) || fileName.replace(/\.[^.]+$/, '').trim() || '未命名',
      author: metadataText(metadata.Author),
      intro: metadataText(metadata.Subject),
      chapters,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('PDF 中')) throw error
    throw new Error(`PDF 解析失败：${message}`)
  } finally {
    await loadingTask.destroy()
  }
}

/**
 * 正文分页：按测量宽度折行、按行高切页。纯函数，测量函数由调用方注入
 * （浏览器用 canvas.measureText，测试用固定字宽）。
 */
export interface PaginateOptions {
  width: number
  height: number
  fontSize: number
  lineHeight: number
  padding?: number
  headerHeight?: number
  footerHeight?: number
  measure: (text: string) => number
}

export interface PaginateResult {
  pages: string[][]
  lines: string[]
  linesPerPage: number
}

export function paginate(text: string, options: PaginateOptions): PaginateResult {
  const padding = options.padding ?? 24
  const headerHeight = options.headerHeight ?? 36
  const footerHeight = options.footerHeight ?? 28
  const maxWidth = Math.max(40, options.width - padding * 2)
  const maxHeight = Math.max(options.lineHeight, options.height - headerHeight - footerHeight)
  const linesPerPage = Math.max(1, Math.floor(maxHeight / options.lineHeight))
  const indent = options.fontSize * 2

  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n')
  const lines: string[] = []

  for (const paragraph of paragraphs) {
    const content = paragraph.trim()
    if (!content) {
      lines.push('')
      continue
    }
    let current = ''
    for (const char of content) {
      const candidate = current + char
      const extra = current === '' ? indent : 0
      if (current !== '' && options.measure(candidate) + extra > maxWidth) {
        lines.push(current)
        current = char
      } else {
        current = candidate
      }
    }
    if (current) lines.push(current)
  }

  const pages: string[][] = []
  for (let index = 0; index < lines.length; index += linesPerPage) {
    pages.push(lines.slice(index, index + linesPerPage))
  }
  if (pages.length === 0) pages.push([''])
  return { pages, lines, linesPerPage }
}

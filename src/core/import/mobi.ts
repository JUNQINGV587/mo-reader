import type { Book, BookMetadata, Contributor, LanguageMap, TOCItem } from 'rebook'
import type { ImportedBook, ImportedChapter } from './txt.js'

interface MobiTextSegment {
  text: string
}

interface MobiTextBlock {
  type: string
  segments: readonly MobiTextSegment[]
  table?: {
    rows: ReadonlyArray<{ cells: ReadonlyArray<{ text: string }> }>
  }
}

function languageText(value: LanguageMap | undefined): string {
  if (!value) return ''
  if (typeof value === 'string') return value.trim()
  const preferred = [value['zh-CN'], value.zh, value['zh-Hans'], value.en]
  for (const item of preferred) {
    if (typeof item === 'string' && item.trim()) return item.trim()
  }
  return Object.values(value as Record<string, string>).find((item) => item.trim())?.trim() ?? ''
}

function contributorName(value: Contributor | Contributor[] | undefined): string {
  if (!value) return ''
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((item) => (typeof item === 'string' ? item : languageText(item.name)))
    .map((item) => item.trim())
    .filter(Boolean)
    .join('、')
}

function normalizeText(value: string): string {
  return value
    .replace(/\u00ad/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blockText(block: MobiTextBlock): string {
  if (block.type === 'image') return ''
  if (block.type === 'table' && block.table) {
    return block.table.rows
      .map((row) => row.cells.map((cell) => cell.text.trim()).filter(Boolean).join(' | '))
      .filter(Boolean)
      .join('\n')
  }
  const text = block.segments.map((segment) => segment.text).join('')
  if (block.type === 'listItem') return text ? `• ${text}` : ''
  if (block.type === 'blockquote') return text ? `> ${text}` : ''
  return text
}

function sectionTitle(blocks: MobiTextBlock[]): string {
  for (const block of blocks) {
    if (block.type !== 'chapter' && block.type !== 'heading') continue
    const text = normalizeText(block.segments.map((segment) => segment.text).join(''))
    if (text) return text
  }
  for (const block of blocks) {
    const text = normalizeText(blockText(block))
    if (text) return text.split('\n')[0].slice(0, 60)
  }
  return ''
}

function tocTitles(book: Book): Map<number, string> {
  const titles = new Map<number, string>()
  const visit = (items: readonly TOCItem[]) => {
    for (const item of items) {
      const target = book.resolveHref?.(item.href)
      const label = item.label.trim()
      if (target && label && !titles.has(target.index)) titles.set(target.index, label)
      if (item.subitems?.length) visit(item.subitems)
    }
  }
  if (book.toc?.length) visit(book.toc)
  return titles
}

function metadataText(metadata: BookMetadata | undefined): { name: string; author: string; intro: string } {
  const name = languageText(metadata?.title)
  let intro = typeof metadata?.description === 'string' ? metadata.description.trim() : ''
  if (!intro) {
    const subject = metadata?.subject
    intro = Array.isArray(subject) ? subject.join('；') : typeof subject === 'string' ? subject : ''
  }
  return {
    name,
    author: contributorName(metadata?.author),
    intro,
  }
}

function isMobi(buffer: Uint8Array): boolean {
  return Buffer.from(buffer.subarray(60, 68)).toString('ascii') === 'BOOKMOBI'
}

/** 将 MOBI6 / KF8（AZW3）按章节提取为可检索的本地文本。 */
export async function parseMobi(buffer: Uint8Array, fileName: string): Promise<ImportedBook> {
  if (!isMobi(buffer)) throw new Error('不是有效的 MOBI 文件')

  const { MOBIParser } = await import('rebook/parsers/mobi')
  const { NodeDOMAdapter, NodeURLFactory } = await import('rebook/adapters/node')
  let book: Book | undefined
  try {
    // 传入副本，避免解析器接管原 Buffer；Buffer 可能只是内存池上的视图。
    const data = new Uint8Array(buffer.byteLength)
    data.set(buffer)
    book = await new MOBIParser().parse(data.buffer, {
      domAdapter: new NodeDOMAdapter(),
      urlFactory: new NodeURLFactory(),
    })
    const titles = tocTitles(book)
    const chapters: ImportedChapter[] = []

    for (let index = 0; index < book.sections.length; index += 1) {
      const section = book.sections[index]
      if (!section) continue
      const blocks = ((await section.getBlocks?.()) ?? []) as unknown as MobiTextBlock[]
      const content = normalizeText(
        blocks
          .map((block) => (block.type === 'break' ? '' : blockText(block)))
          .filter(Boolean)
          .join('\n\n'),
      )
      if (!content) continue
      const title = titles.get(index) || sectionTitle(blocks) || `第${chapters.length + 1}节`
      chapters.push({ title: title.slice(0, 120), content })
    }

    if (chapters.length === 0) throw new Error('MOBI 中没有可读取的正文')
    const { name, author, intro } = metadataText(book.metadata)
    return {
      name: name || fileName.replace(/\.[^.]+$/, '').trim() || '未命名',
      author,
      intro,
      chapters,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('MOBI 中')) throw error
    throw new Error(`MOBI 解析失败：${message}`)
  } finally {
    book?.destroy?.()
  }
}

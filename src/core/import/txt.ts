import iconv from 'iconv-lite'

export interface ImportedChapter {
  title: string
  content: string
  isVolume?: boolean
}

export interface ImportedBook {
  name: string
  author: string
  intro: string
  chapters: ImportedChapter[]
}

/**
 * 本地 TXT 编码探测：BOM → UTF-8 严格解码 → GB18030 回退。
 * 阅读的 TextFile 也是这套顺序，只是编码表更全。
 */
export function decodeText(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer)
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3))
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return iconv.decode(bytes, 'gb18030')
  }
}

const CHAPTER_RE =
  /^(?:第[0-9零一二三四五六七八九十百千万两]+[章回节集部篇][^\n]{0,40}|序章[^\n]{0,40}|楔子[^\n]{0,40}|引子[^\n]{0,40}|前言[^\n]{0,40}|后记[^\n]{0,40}|尾声[^\n]{0,40}|番外[^\n]{0,40})$/

const VOLUME_RE = /^第[0-9零一二三四五六七八九十百千万两]+[卷部篇]/

/** 无章节标题时的兜底切分：按空行/长度切，避免一整本 2MB 塞进一个章节。 */
function chunkText(text: string, size = 2500): ImportedChapter[] {
  const paragraphs = text.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean)
  if (paragraphs.length === 0) return [{ title: '正文', content: text.trim() }]
  const chapters: ImportedChapter[] = []
  let buffer = ''
  const flush = () => {
    const content = buffer.trim()
    if (!content) return
    chapters.push({ title: `第${chapters.length + 1}节`, content })
    buffer = ''
  }
  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length + 2 > size) flush()
    buffer += (buffer ? '\n\n' : '') + paragraph
  }
  flush()
  return chapters.length > 0 ? chapters : [{ title: '正文', content: text.trim() }]
}

/** 按「第X章 / 序章 / 番外」切分 TXT 正文，返回章节列表。 */
export function splitTxt(text: string): ImportedChapter[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const chapters: ImportedChapter[] = []
  let current: ImportedChapter | null = null
  let buffer: string[] = []
  let preamble = ''

  const flush = () => {
    if (!current) return
    const content = buffer.join('\n').trim()
    if (current.isVolume) {
      chapters.push({ ...current, content: '' })
    } else if (content) {
      chapters.push({ ...current, content })
    }
    buffer = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length > 0 && trimmed.length <= 48 && CHAPTER_RE.test(trimmed)) {
      if (current) {
        flush()
      } else {
        // 第一个标题之前的版权/简介，留作「开始」
        preamble = buffer.join('\n').trim()
      }
      buffer = []
      current = {
        title: trimmed,
        content: '',
        isVolume: VOLUME_RE.test(trimmed),
      }
      continue
    }
    buffer.push(line)
  }
  flush()

  // 没有任何章节标记：按段落兜底切分
  if (chapters.length === 0) {
    const content = normalized.trim()
    if (!content) return []
    return chunkText(content)
  }

  if (preamble) chapters.unshift({ title: '开始', content: preamble })
  return chapters
}

export function parseTxt(buffer: Uint8Array, fileName: string): ImportedBook {
  const text = decodeText(buffer)
  const baseName = fileName.replace(/\.[^.]+$/, '').trim() || '未命名'
  return {
    name: baseName,
    author: '',
    intro: '',
    chapters: splitTxt(text),
  }
}

export type Book = {
  title: string
  subtitle: string
  art?: boolean
  latin?: boolean
  seal?: string
  hue?: number
  spineWidth?: string
  spineHeight?: string
}

export const books: Book[] = [
  { title: '我可是正道大师兄', subtitle: '本地 TXT', seal: '我', hue: 130 },
  { title: 'mr-two-chapters', subtitle: '本地 TXT', seal: '两', latin: true, hue: 88, spineWidth: '40px' },
  { title: 'curl-test', subtitle: '本地 TXT', seal: '卷', latin: true, hue: 285, spineWidth: '46px' },
  { title: '月亮与六便士', subtitle: '毛姆 · EPUB', art: true, hue: 210 },
  { title: '人类简史', subtitle: '尤瓦尔·赫拉利 · EPUB', art: true, hue: 28 },
  { title: '百年孤独', subtitle: '加西亚·马尔克斯 · EPUB', seal: '孤', hue: 10 },
  { title: '局外人', subtitle: '加缪 · 本地 TXT', seal: '局', hue: 200 },
  { title: 'The Little Prince', subtitle: 'Saint-Exupéry · EPUB', art: true, hue: 45, spineWidth: '42px' },
]

export const readingBook = books[0]
export const readingMeta = { chapter: '第 12 / 28 章', percent: 42 }

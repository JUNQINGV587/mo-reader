/**
 * PDF 书的两套视图共用一份页码对应关系。
 *
 * 旧版 PDF 导入逐页抽文本，章节标题固定是「第 N 页」（数字与「页」之间有空格），
 * 空文字页会被跳过，所以章节下标不等于页码、只能靠标题里的页码换算。
 * 详情目录的章节入口、原版与文本的来回切换都走这里，避免两处各写一套正则。
 */

const PDF_PAGE_TITLE_PATTERN = /^第 (\d+) 页$/

/** 从 PDF 页章节标题取回原页（1 起）；不是「第 N 页」时返回 null。 */
export function pdfPageOfChapterTitle(title: unknown): number | null {
  if (typeof title !== 'string') return null
  const matched = PDF_PAGE_TITLE_PATTERN.exec(title.trim())
  if (!matched) return null
  const page = Number(matched[1])
  return Number.isSafeInteger(page) && page > 0 ? page : null
}

/** 章节标题是否全是「第 N 页」：旧版 PDF 导入留下的特征，也用来识别 PDF 书。 */
export function isPdfPageChapters(
  chapters: ReadonlyArray<{ title: string; isVolume?: boolean }>,
): boolean {
  if (chapters.length === 0) return false
  return chapters.every(
    (chapter) => !chapter.isVolume && pdfPageOfChapterTitle(chapter.title) !== null,
  )
}

/**
 * 取原版某一页对应的文本章节：先找不晚于它的最近一章（空文字页就落回上一页），
 * 当前页之前没有任何文字页时取最近的一章，这样切回文本不会卡在空页前。
 */
export function chapterForPdfPage<T extends { title: string }>(
  chapters: ReadonlyArray<T>,
  page: number,
): T | null {
  if (!Number.isSafeInteger(page) || page <= 0) return null
  let before: T | null = null
  let beforePage = 0
  let after: T | null = null
  let afterPage = Number.POSITIVE_INFINITY
  for (const chapter of chapters) {
    const chapterPage = pdfPageOfChapterTitle(chapter.title)
    if (chapterPage === null) continue
    if (chapterPage <= page && chapterPage > beforePage) {
      before = chapter
      beforePage = chapterPage
    }
    if (chapterPage > page && chapterPage < afterPage) {
      after = chapter
      afterPage = chapterPage
    }
  }
  return before ?? after
}

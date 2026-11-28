/** 目录分页：200 章一页，跳到指定章节只需算页码，不逐页加载。 */
export const TOC_PAGE_SIZE = 200

/** 0 起章节下标所在页码（1 起）。非法下标回落到第 1 页。 */
export function tocPageForIndex(index: number, pageSize = TOC_PAGE_SIZE): number {
  if (!Number.isFinite(index) || index < 0) return 1
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : TOC_PAGE_SIZE
  return Math.floor(Math.floor(index) / size) + 1
}

export type ChapterJumpResult =
  | { ok: true; index: number; page: number }
  | { ok: false; message: string }

/** 校验用户输入的章节号；index 为 0 起下标，page 为 1 起页码。 */
export function parseChapterJump(raw: unknown, total: number, pageSize = TOC_PAGE_SIZE): ChapterJumpResult {
  const count = Number.isFinite(total) ? Math.floor(total) : 0
  if (count <= 0) return { ok: false, message: '目录还没有加载完成' }
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, message: '请输入章节号' }
  if (!/^\d+$/.test(text)) return { ok: false, message: '请输入整数章节号' }
  const number = Number(text)
  if (!Number.isSafeInteger(number) || number < 1 || number > count) {
    return { ok: false, message: `章节号需在 1–${count} 之间` }
  }
  const index = number - 1
  return { ok: true, index, page: tocPageForIndex(index, pageSize) }
}

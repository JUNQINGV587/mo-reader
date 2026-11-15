import { z } from 'zod'

/** 「阅读」BookSourceType：0 文本 / 1 音频 / 2 图片 / 3 文件 / 4 视频 */
export const BookType = z.number().int().min(0).max(4)

/** 书籍字段对齐「阅读」Book（M0 先落核心字段，M1 补全）。 */
export const BookSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    author: z.string().default(''),
    bookUrl: z.string().default(''),
    origin: z.string().default(''),
    originName: z.string().default(''),
    type: BookType.default(0),
    group: z.string().default(''),
    coverUrl: z.string().default(''),
    intro: z.string().default(''),
    totalChapterNum: z.number().int().min(0).default(0),
    wordCount: z.string().default(''),
    rating: z.string().default(''),
    pinned: z.boolean().default(false),
    latestChapterTitle: z.string().default(''),
    lastReadAt: z.number().int().min(0).default(0),
    createdAt: z.number().int().min(0).default(0),
    updatedAt: z.number().int().min(0).default(0),
  })
  .passthrough()

export type Book = z.infer<typeof BookSchema>

/** 章节字段对齐「阅读」BookChapter（M0 先落核心字段，M1 补全）。 */
export const ChapterSchema = z
  .object({
    id: z.string().min(1),
    bookId: z.string().min(1),
    index: z.number().int().min(0),
    title: z.string().default(''),
    url: z.string().default(''),
    isVolume: z.boolean().default(false),
    isRead: z.boolean().default(false),
    updatedAt: z.number().int().min(0).default(0),
  })
  .passthrough()

export type Chapter = z.infer<typeof ChapterSchema>

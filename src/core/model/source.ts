/**
 * 阅读（Legado）BookSource / Book / BookChapter 的字段模型（M1 子集）。
 * 字段名与阅读的 Kotlin bean 保持一致，方便直接导入 bookSource.json 与备份。
 */
import { z } from 'zod';

export const BOOK_SOURCE_TYPE = {
  text: 0,
  audio: 1,
  image: 2,
  file: 3,
  video: 4,
} as const;

const RuleSearchSchema = z
  .object({
    bookList: z.string().optional(),
    name: z.string().optional(),
    author: z.string().optional(),
    kind: z.string().optional(),
    wordCount: z.string().optional(),
    rating: z.string().optional(),
    lastChapter: z.string().optional(),
    intro: z.string().optional(),
    coverUrl: z.string().optional(),
    bookUrl: z.string().optional(),
    checkKeyWord: z.string().optional(),
  })
  .passthrough();

const RuleBookInfoSchema = z
  .object({
    init: z.string().optional(),
    name: z.string().optional(),
    author: z.string().optional(),
    kind: z.string().optional(),
    lastChapter: z.string().optional(),
    intro: z.string().optional(),
    coverUrl: z.string().optional(),
    tocUrl: z.string().optional(),
    wordCount: z.string().optional(),
    rating: z.string().optional(),
    canReName: z.string().optional(),
  })
  .passthrough();

const RuleTocSchema = z
  .object({
    chapterList: z.string().optional(),
    chapterName: z.string().optional(),
    chapterUrl: z.string().optional(),
    formatJs: z.string().optional(),
    isVolume: z.string().optional(),
    nextTocUrl: z.string().optional(),
  })
  .passthrough();

const RuleContentSchema = z
  .object({
    content: z.string().optional(),
    nextContentUrl: z.string().optional(),
    webJs: z.string().optional(),
    sourceRegex: z.string().optional(),
    replaceRegex: z.string().optional(),
    imageStyle: z.string().optional(),
  })
  .passthrough();

const RuleReviewSchema = z
  .object({
    enabled: z.boolean().optional(),
    reviewUrl: z.string().optional(),
    reviewSummaryUrl: z.string().optional(),
    summaryListRule: z.string().optional(),
    summaryParagraphIndexRule: z.string().optional(),
    summaryParagraphDataRule: z.string().optional(),
    summaryCountRule: z.string().optional(),
    reviewQuoteUrl: z.string().optional(),
    reviewDetailUrl: z.string().optional(),
    detailListRule: z.string().optional(),
    contentRule: z.string().optional(),
    postTimeRule: z.string().optional(),
    avatarRule: z.string().optional(),
  })
  .passthrough();

const RuleExploreSchema = z
  .object({
    bookList: z.string().optional(),
    name: z.string().optional(),
    author: z.string().optional(),
    kind: z.string().optional(),
    intro: z.string().optional(),
    coverUrl: z.string().optional(),
    bookUrl: z.string().optional(),
  })
  .passthrough();

export const BookSourceSchema = z
  .object({
    bookSourceUrl: z.string().min(1),
    bookSourceName: z.string().min(1),
    bookSourceGroup: z.string().optional(),
    bookSourceType: z.number().int().optional(),
    bookSourceComment: z.string().optional(),
    enabled: z.boolean().optional(),
    enabledExplore: z.boolean().optional(),
    enabledCookieJar: z.boolean().optional(),
    customOrder: z.number().int().optional(),
    lastUpdateTime: z.number().optional(),
    respondTime: z.number().int().optional(),
    weight: z.number().int().optional(),
    exploreUrl: z.string().optional(),
    searchUrl: z.string().optional(),
    header: z.string().optional(),
    loginUrl: z.string().optional(),
    loginUi: z.string().optional(),
    loginCheckJs: z.string().optional(),
    jsLib: z.string().optional(),
    mainJs: z.string().optional(),
    concurrentRate: z.string().optional(),
    variableComment: z.string().optional(),
    ruleExplore: RuleExploreSchema.optional(),
    ruleSearch: RuleSearchSchema.optional(),
    ruleBookInfo: RuleBookInfoSchema.optional(),
    ruleToc: RuleTocSchema.optional(),
    ruleContent: RuleContentSchema.optional(),
    ruleReview: RuleReviewSchema.optional(),
  })
  .passthrough();

export type BookSource = z.infer<typeof BookSourceSchema>;
export type RuleSearch = z.infer<typeof RuleSearchSchema>;
export type RuleBookInfo = z.infer<typeof RuleBookInfoSchema>;
export type RuleToc = z.infer<typeof RuleTocSchema>;
export type RuleContent = z.infer<typeof RuleContentSchema>;
export type RuleReview = z.infer<typeof RuleReviewSchema>;

export const BookSchema = z
  .object({
    bookUrl: z.string().min(1),
    name: z.string().default(''),
    author: z.string().default(''),
    kind: z.string().optional(),
    origin: z.string().default(''),
    originName: z.string().default(''),
    type: z.number().int().default(0),
    group: z.number().int().optional(),
    coverUrl: z.string().optional(),
    intro: z.string().optional(),
    tocUrl: z.string().optional(),
    totalChapterNum: z.number().int().optional(),
    latestChapterTitle: z.string().optional(),
    lastReadAt: z.number().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

export type Book = z.infer<typeof BookSchema>;

export const ChapterSchema = z
  .object({
    bookUrl: z.string().min(1),
    index: z.number().int(),
    title: z.string().default(''),
    url: z.string().default(''),
    isVolume: z.boolean().optional(),
    isRead: z.boolean().optional(),
    updatedAt: z.number().optional(),
  })
  .passthrough();

export type Chapter = z.infer<typeof ChapterSchema>;

export function parseSource(raw: unknown): BookSource {
  return BookSourceSchema.parse(raw);
}

export function parseSources(raw: unknown): BookSource[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((item) => parseSource(item));
}

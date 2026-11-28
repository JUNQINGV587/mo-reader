/**
 * 搜索结果合并（#145）：同一本书会被多个书源各自命中，
 * 按「书名 + 作者」归一化后只留一条主记录，并保留全部来源信息。
 * 纯函数，服务端合并与前端兜底共用。
 */
import type { SearchBook } from './analyze.js';

/** 同一本书在某个书源里的落点；合并后保留用于展示与换源。 */
export interface SearchBookSourceRef {
  origin: string;
  originName: string;
  bookUrl: string;
}

/** 去重后的搜索结果：主记录沿用首个命中的字段，额外带全部来源。 */
export interface MergedSearchBook extends SearchBook {
  /** 命中的全部来源（按首次出现顺序；同源同书只记一次）。 */
  sources: SearchBookSourceRef[];
  /** 合并来源数，等价于 sources.length；界面直接展示。 */
  sourceCount: number;
}

/** 允许再次合并已经带 sources 的记录，保证函数幂等。 */
export type SearchBookLike = SearchBook & { sources?: SearchBookSourceRef[] };

/** 首个来源缺失的字段用后续来源补上，避免合并后反而丢信息。 */
const FILLABLE_FIELDS = ['author', 'kind', 'wordCount', 'lastChapter', 'intro', 'coverUrl'] as const;

function normalizePart(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * 去重键：书名 + 作者。空作者只用书名成键，
 * 避免「未知作者」把同一本书的不同作者版本错误合并。
 */
export function searchBookKey(name: string, author: string): string {
  const normalizedName = normalizePart(name);
  const normalizedAuthor = normalizePart(author);
  return normalizedAuthor ? `${normalizedName}\u0000${normalizedAuthor}` : `${normalizedName}\u0000`;
}

function sourceRefOf(book: SearchBookLike): SearchBookSourceRef {
  return {
    origin: typeof book.origin === 'string' ? book.origin : '',
    originName: typeof book.originName === 'string' ? book.originName : '',
    bookUrl: typeof book.bookUrl === 'string' ? book.bookUrl : '',
  };
}

function sourceKeyOf(source: SearchBookSourceRef): string {
  return `${source.origin}\u0000${source.bookUrl}`;
}

/** 已合并记录携带多个来源；普通记录只有自己的那一个来源。 */
function collectSources(book: SearchBookLike): SearchBookSourceRef[] {
  const own = sourceRefOf(book);
  if (!Array.isArray(book.sources) || book.sources.length === 0) return [own];
  return book.sources.map((source) => ({
    origin: typeof source?.origin === 'string' && source.origin ? source.origin : own.origin,
    originName: typeof source?.originName === 'string' && source.originName ? source.originName : own.originName,
    bookUrl: typeof source?.bookUrl === 'string' && source.bookUrl ? source.bookUrl : own.bookUrl,
  }));
}

function mergeSources(target: MergedSearchBook, incoming: SearchBookSourceRef[]): void {
  const seen = new Set(target.sources.map(sourceKeyOf));
  for (const source of incoming) {
    const key = sourceKeyOf(source);
    if (seen.has(key)) continue;
    seen.add(key);
    target.sources.push(source);
  }
  target.sourceCount = target.sources.length;
}

/**
 * 合并搜索结果：首个命中做主记录（书名、作者、bookUrl、来源名等都以它为准），
 * 后续同书记录只并入 sources，并补上主记录缺失的字段。
 */
export function dedupeSearchResults(books: readonly SearchBookLike[]): MergedSearchBook[] {
  const merged = new Map<string, MergedSearchBook>();
  for (const book of books) {
    if (!book || typeof book.name !== 'string') continue;
    const name = book.name.trim();
    if (!name) continue;
    const author = typeof book.author === 'string' ? book.author.trim() : '';
    const key = searchBookKey(name, author);
    const sources = collectSources(book);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...book,
        name,
        author,
        sources,
        sourceCount: sources.length,
      });
      continue;
    }
    const target = existing as unknown as Record<string, unknown>;
    for (const field of FILLABLE_FIELDS) {
      if (!target[field] && book[field]) target[field] = book[field];
    }
    mergeSources(existing, sources);
  }
  return [...merged.values()];
}

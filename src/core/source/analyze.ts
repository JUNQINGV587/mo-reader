/**
 * 书源解析：把抓到的 HTML/JSON 按 BookSource 的 ruleSearch / ruleBookInfo /
 * ruleToc / ruleContent 变成结构化结果。纯函数，便于用本地 fixture 测试。
 */
import { AnalyzeRule } from '../rules/analyze-rule.js';
import type { BookSource } from '../model/source.js';

export interface SearchBook {
  name: string;
  author: string;
  kind: string;
  wordCount: string;
  lastChapter: string;
  intro: string;
  coverUrl: string;
  bookUrl: string;
  origin: string;
  originName: string;
  type: number;
}

export interface BookInfo {
  name: string;
  author: string;
  kind: string;
  lastChapter: string;
  intro: string;
  coverUrl: string;
  tocUrl: string;
  wordCount: string;
}

export interface TocChapter {
  title: string;
  url: string;
  isVolume: boolean;
}

export function analyzeSearch(
  content: unknown,
  source: BookSource,
  baseUrl = source.bookSourceUrl,
): SearchBook[] {
  const rule = source.ruleSearch ?? {};
  const bookList = rule.bookList ?? '';
  if (!bookList) return [];

  const listRule = new AnalyzeRule(content, { baseUrl, source });
  const elements = listRule.getElements(bookList);
  const results: SearchBook[] = [];

  for (const element of elements) {
    const item = new AnalyzeRule(element, { baseUrl, source });
    const name = clean(item.getString(rule.name ?? ''));
    const bookUrl = toAbsolute(item.getString(rule.bookUrl ?? ''), baseUrl);
    if (!name || !bookUrl) continue;

    results.push({
      name,
      author: clean(item.getString(rule.author ?? '')),
      kind: clean(item.getString(rule.kind ?? '')),
      wordCount: clean(item.getString(rule.wordCount ?? '')),
      lastChapter: clean(item.getString(rule.lastChapter ?? '')),
      intro: htmlToText(item.getString(rule.intro ?? '')),
      coverUrl: toAbsolute(item.getString(rule.coverUrl ?? ''), baseUrl),
      bookUrl,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName,
      type: source.bookSourceType ?? 0,
    });
  }
  return results;
}

export function analyzeBookInfo(
  content: unknown,
  source: BookSource,
  baseUrl = source.bookSourceUrl,
  fallbackTocUrl = '',
): BookInfo {
  const rule = source.ruleBookInfo ?? {};
  let processed = content;

  const init = rule.init ?? '';
  if (init) {
    const initValue = new AnalyzeRule(content, { baseUrl, source }).getString(init);
    if (initValue) processed = initValue;
  }

  const analyzer = new AnalyzeRule(processed, { baseUrl, source });
  return {
    name: clean(analyzer.getString(rule.name ?? '')),
    author: clean(analyzer.getString(rule.author ?? '')),
    kind: clean(analyzer.getString(rule.kind ?? '')),
    lastChapter: clean(analyzer.getString(rule.lastChapter ?? '')),
    intro: htmlToText(analyzer.getString(rule.intro ?? '')),
    coverUrl: toAbsolute(analyzer.getString(rule.coverUrl ?? ''), baseUrl),
    tocUrl: toAbsolute(analyzer.getString(rule.tocUrl ?? ''), baseUrl) || fallbackTocUrl,
    wordCount: clean(analyzer.getString(rule.wordCount ?? '')),
  };
}

export function analyzeToc(
  content: unknown,
  source: BookSource,
  baseUrl = source.bookSourceUrl,
): TocChapter[] {
  const rule = source.ruleToc ?? {};
  const chapterList = rule.chapterList ?? '';
  if (!chapterList) return [];

  const listRule = new AnalyzeRule(content, { baseUrl, source });
  const elements = listRule.getElements(chapterList);
  const chapters: TocChapter[] = [];

  for (const element of elements) {
    const item = new AnalyzeRule(element, { baseUrl, source });
    const title = clean(item.getString(rule.chapterName ?? ''));
    const url = toAbsolute(item.getString(rule.chapterUrl ?? ''), baseUrl);
    if (!title) continue;

    const volumeRule = rule.isVolume ?? '';
    const volumeRaw = volumeRule ? clean(item.getString(volumeRule)) : '';
    const isVolume = volumeRaw ? !/^false$/i.test(volumeRaw) : url === '';
    chapters.push({ title, url, isVolume });
  }
  return chapters;
}

export function analyzeContent(
  content: unknown,
  source: BookSource,
  baseUrl = source.bookSourceUrl,
): string {
  const rule = source.ruleContent ?? {};
  const contentRule = rule.content ?? '';
  if (!contentRule) return '';
  return htmlToText(new AnalyzeRule(content, { baseUrl, source }).getString(contentRule));
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lrm: '',
  rlm: '',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * 把书源规则返回的 HTML 片段转成纯文本：`<br>` 换行、`</p>` 分段，
 * 其余标签剥掉，并解码常见实体（`&nbsp;`/`&lrm;` 等）。
 */
function htmlToText(value: string): string {
  const text = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.test(value)
    ? value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, '')
    : value;
  return trimText(decodeEntities(text).replace(/[ \t]+\n/g, '\n'));
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function toAbsolute(value: string, baseUrl: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, baseUrl || undefined).toString();
  } catch {
    return trimmed;
  }
}

function trimText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

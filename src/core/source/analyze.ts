/**
 * 书源解析：把抓到的 HTML/JSON 按 BookSource 的 ruleSearch / ruleBookInfo /
 * ruleToc / ruleContent 变成结构化结果。纯函数，便于用本地 fixture 测试。
 */
import { load } from 'cheerio';
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
  rating: string;
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
    rating: clean(analyzer.getString(rule.rating ?? '')),
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
    const urlRule = rule.chapterUrl ?? '';
    const rawUrl = urlRule === 'href' || urlRule === 'src' ? elementAttr((element as any).outerHtml ?? String(element), urlRule) : item.getString(urlRule);
    const url = toAbsolute(rawUrl, baseUrl);
    if (!title) continue;

    const volumeRule = rule.isVolume ?? '';
    const volumeRaw = volumeRule ? clean(item.getString(volumeRule)) : '';
    const isVolume = volumeRaw ? !/^false$/i.test(volumeRaw) : url === '';
    chapters.push({ title, url, isVolume });
  }
  return chapters;
}

export type ContentKind = 'text' | 'images' | 'audio' | 'video'

export interface ChapterContent {
  kind: ContentKind
  text: string
  images: string[]
  mediaUrl: string
}

/** 阅读 BookSourceType：0 文本、1 音频、2 图片、3 文件、4 视频。 */
export function contentKindOfType(type: number): ContentKind {
  if (type === 1) return 'audio'
  if (type === 2) return 'images'
  if (type === 4) return 'video'
  return 'text'
}

export function contentKindOf(source: BookSource): ContentKind {
  return contentKindOfType(Number((source as any).bookSourceType ?? 0))
}

/**
 * 按书源类型解析一章：文本返回纯文本；图片源从 ruleContent 里取出图片 URL 列表；
 * 音频/视频源的章节 URL 本身就是媒体地址（阅读同样直接用 chapter.url 播放）。
 */
export function analyzeChapterContent(
  content: unknown,
  source: BookSource,
  baseUrl: string,
  chapterUrl = '',
): ChapterContent {
  const kind = contentKindOf(source)
  if (kind === 'audio' || kind === 'video') {
    let mediaUrl = chapterUrl || baseUrl
    const rule = source.ruleContent?.content ?? ''
    if (rule && typeof content === 'string' && content) {
      try {
        const raw = new AnalyzeRule(content, { baseUrl, source }).getString(rule)
        const candidate = toAbsolute(decodeUrlEntities(String(raw ?? '').trim()), baseUrl)
        if (candidate) mediaUrl = candidate
      } catch {
        // 规则失败时退回章节地址
      }
    }
    return { kind, text: '', images: [], mediaUrl }
  }
  if (kind === 'images') {
    return { kind, text: '', images: extractImages(content, source, baseUrl), mediaUrl: '' }
  }
  return { kind: 'text', text: analyzeContent(content, source, baseUrl), images: [], mediaUrl: '' }
}


function decodeUrlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
}

function extractImages(content: unknown, source: BookSource, baseUrl: string): string[] {
  const rule = source.ruleContent?.content ?? ''
  const images: string[] = []
  const push = (raw: string) => {
    const value = raw.trim()
    if (!value) return
    const candidates: string[] = []
    if (/<img\b/i.test(value)) {
      const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi
      let match: RegExpExecArray | null
      while ((match = re.exec(value))) candidates.push(match[1] ?? '')
    } else {
      for (const line of value.split('\n')) candidates.push(line)
    }
    for (const item of candidates) {
      const url = toAbsolute(decodeUrlEntities(item.trim()), baseUrl)
      if (!url || /^(data:|blob:)/i.test(url) || images.includes(url)) continue
      images.push(url)
    }
  }
  if (rule) {
    try {
      const values = new AnalyzeRule(content, { baseUrl, source }).getStringList(rule) ?? []
      for (const value of values) push(typeof value === 'string' ? value : String(value))
    } catch {
      // 规则失败时退回整页图片兜底
    }
  }
  if (!images.length && typeof content === 'string') push(content)
  return images
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

/** 阅读里 chapterUrl 常写成裸 `href`/`src`，表示取当前元素的属性。 */
function elementAttr(html: string, name: string): string {
  try {
    return load(html, null, false)('*').first().attr(name) ?? '';
  } catch {
    return '';
  }
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
export function htmlToText(value: string): string {
  let source = value;
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(source);
  if (body) source = body[1];
  else source = source.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '');
  if (!/<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.test(source)) return trimText(decodeEntities(source));
  const text = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|blockquote|dd|dt)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
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

export function trimText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

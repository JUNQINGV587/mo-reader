/**
 * 书源 URL 规则（阅读 AnalyzeUrl 的 M1 子集）：
 * - `{{key}}` / `{{page}}` / `{{baseUrl}}` 占位符
 * - `@js:` / `<js>` 形式的 URL 脚本
 * - `,{"method":"POST","body":"...","headers":{...}}` 选项后缀
 * - 相对 URL 按书源地址补全
 */
import { evalJs } from '../rules/js.js';
import type { BookSource } from '../model/source.js';

export interface UrlContext {
  key?: string;
  page?: number;
  baseUrl?: string;
  book?: unknown;
  chapter?: unknown;
  source?: BookSource;
  variables?: Record<string, string>;
}

export interface RequestSpec {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers: Record<string, string>;
}

/** 解析书源 header 字段（JSON 对象），非法时返回空。 */
export function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' || typeof value === 'number') {
        headers[key] = String(value);
      }
    }
    return headers;
  } catch {
    return {};
  }
}

/** 把一条 URL 规则变成请求描述；空规则返回 null。 */
export function buildRequest(ruleStr: string | undefined, ctx: UrlContext): RequestSpec | null {
  const raw = (ruleStr ?? '').trim();
  if (!raw) return null;

  const fromJs = evaluateUrlScript(raw, ctx);
  const value = interpolate(fromJs ?? raw, ctx);
  const { base, options } = splitOptions(value);

  const url = resolveUrl(base, ctx.baseUrl ?? ctx.source?.bookSourceUrl ?? '');
  return {
    url,
    method: options.method ?? 'GET',
    body: options.body,
    headers: options.headers ?? {},
  };
}

export function buildSearchRequest(
  source: BookSource,
  key: string,
  page = 1,
): RequestSpec | null {
  return buildRequest(source.searchUrl, {
    key,
    page,
    baseUrl: source.bookSourceUrl,
    source,
  });
}

export function buildExploreRequest(
  source: BookSource,
  url: string,
  page = 1,
): RequestSpec | null {
  return buildRequest(url, {
    page,
    baseUrl: source.bookSourceUrl,
    source,
  });
}

function evaluateUrlScript(raw: string, ctx: UrlContext): string | null {
  let script: string | null = null;
  if (/^@js:/i.test(raw)) {
    script = raw.slice(4);
  } else {
    const match = /^<js>([\w\W]*?)<\/js>/i.exec(raw);
    if (match) script = match[1] ?? null;
  }
  if (script == null) return null;

  const result = evalJs(script, {
    result: ctx.baseUrl,
    baseUrl: ctx.baseUrl,
    key: ctx.key,
    page: ctx.page,
    book: ctx.book,
    chapter: ctx.chapter,
    source: ctx.source,
    variables: ctx.variables,
  });
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const object = result as { url?: unknown };
    if (typeof object.url === 'string') return object.url;
  }
  return String(result ?? '');
}

function interpolate(raw: string, ctx: UrlContext): string {
  return raw.replace(/\{\{\s*(key|page|baseUrl)\s*\}\}/gi, (_match, name: string) => {
    const key = name.toLowerCase();
    if (key === 'key') return encodeURIComponent(ctx.key ?? '');
    if (key === 'page') return String(ctx.page ?? 1);
    return ctx.baseUrl ?? '';
  });
}

function splitOptions(value: string): {
  base: string;
  options: { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> };
} {
  const marker = value.lastIndexOf(',{');
  if (marker < 0) return { base: value, options: {} };

  const tail = value.slice(marker + 1);
  const parsed = parseOptionsJson(tail);
  if (parsed) {
    const method = String(parsed.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    return {
      base: value.slice(0, marker),
      options: {
        method,
        body: typeof parsed.body === 'string' ? parsed.body : undefined,
        headers: isStringRecord(parsed.headers) ? parsed.headers : undefined,
      },
    };
  }
  return { base: value, options: {} };
}

/** 书源选项后缀有时是单引号 JS 字面量（{'method':'POST'}），按宽松 JSON 解析。 */
function parseOptionsJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 继续用宽松解析
  }
  const normalized = text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner: string) =>
    JSON.stringify(inner.replace(/\\'/g, "'")),
  );
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (item) => typeof item === 'string' || typeof item === 'number',
  );
}

function resolveUrl(url: string, baseUrl: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed, baseUrl || undefined).toString();
  } catch {
    return trimmed;
  }
}

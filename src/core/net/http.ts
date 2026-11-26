/**
 * 书源抓取（服务端代理）：`fetch` + SSRF 守卫 + 重定向逐跳复检 + 编码识别。
 * 登录 / Cookie 自动回写在 M1 不做；书源 header 里显式 Cookie 仍原样透传。
 */
import iconv from 'iconv-lite';
import { assertPublicHttpUrl } from '../net/guard.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const MAX_REDIRECTS = 5;

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResult {
  url: string;
  status: number;
  text: string;
  contentType: string;
}

export interface FetchBinaryOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 响应体字节上限；超过立即中止读取，避免大文件占内存。 */
  maxBytes?: number;
}

export interface FetchBinaryResult {
  url: string;
  status: number;
  contentType: string;
  data: Buffer;
}

/** 二进制抓取的默认上限：封面等小图片够用，也拦住误抓的大文件。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;


export async function fetchText(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  let url = await assertPublicHttpUrl(normalizeDuplicateSlashes(rawUrl));
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    ...options.headers,
  };

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return finish(response, url);
      url = await assertPublicHttpUrl(normalizeDuplicateSlashes(new URL(location, url).toString()));
      continue;
    }
    return finish(response, url);
  }
  throw new Error('重定向次数过多');
}

async function finish(response: Response, url: URL): Promise<FetchResult> {
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  const text = iconv.decode(buffer, detectCharset(buffer, contentType));
  return { url: url.toString(), status: response.status, text, contentType };
}

/**
 * 二进制抓取：与 fetchText 同一套 SSRF 守卫与逐跳重定向复检，
 * 额外限制响应体大小；内容类型由调用方判断（封面只接受 image/*）。
 */
export async function fetchBinary(
  rawUrl: string,
  options: FetchBinaryOptions = {},
): Promise<FetchBinaryResult> {
  let url = await assertPublicHttpUrl(normalizeDuplicateSlashes(rawUrl));
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: 'image/*,*/*;q=0.5',
    ...options.headers,
  };

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return finishBinary(response, url, maxBytes);
      url = await assertPublicHttpUrl(normalizeDuplicateSlashes(new URL(location, url).toString()));
      continue;
    }
    return finishBinary(response, url, maxBytes);
  }
  throw new Error('重定向次数过多');
}

async function finishBinary(response: Response, url: URL, maxBytes: number): Promise<FetchBinaryResult> {
  const contentType = response.headers.get('content-type') ?? '';
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('响应体过大');
  const data = await readBodyWithLimit(response, maxBytes);
  return { url: url.toString(), status: response.status, contentType, data };
}

/** 边读边计数：没有 Content-Length 的响应也不会读到超限还不够。 */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('响应体过大');
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('响应体过大');
      chunks.push(Buffer.from(value));
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 已经读完或已出错：取消失败无需处理。
    }
  }
  return Buffer.concat(chunks);
}

export function detectCharset(buffer: Buffer, contentType: string): string {
  const headerCharset = /charset\s*=\s*([\w-]+)/i.exec(contentType)?.[1];
  if (headerCharset) return normalizeCharset(headerCharset);

  const head = buffer.subarray(0, 4096).toString('latin1');
  const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  if (metaCharset) return normalizeCharset(metaCharset);
  return 'utf-8';
}

function normalizeCharset(name: string): string {
  const value = name.toLowerCase();
  if (value === 'gb2312' || value === 'gbk' || value === 'gb18030') return 'gb18030';
  if (value === 'utf8') return 'utf-8';
  return iconv.encodingExists(value) ? value : 'utf-8';
}

/** 部分站点（如起点）对路径里的 `//` 会 404；只规整 pathname，保留 scheme 与 query。 */
export function normalizeDuplicateSlashes(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/{2,}/g, '/');
    if (path !== url.pathname) url.pathname = path;
    return url.toString();
  } catch {
    return raw;
  }
}

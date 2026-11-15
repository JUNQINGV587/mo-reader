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

export async function fetchText(rawUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  let url = await assertPublicHttpUrl(rawUrl);
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
      url = await assertPublicHttpUrl(new URL(location, url).toString());
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

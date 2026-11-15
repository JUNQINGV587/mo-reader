/**
 * 书源 `@js` 的执行环境（Node vm）+ 阅读 JsExtensions 的常用 API。
 *
 * 与阅读的差异：Rhino 里能直接 new Java 对象，这里只垫了最常用的
 * URLEncoder / Base64 / UUID / System.currentTimeMillis；其余 Java 类
 * 会抛错，由书源调试器展示给用户。
 */
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import vm from 'node:vm';
import { isPrivateAddress, parseHttpUrl, UnsafeUrlError } from '../net/guard.js';

export interface JsEnv {
  result?: unknown;
  baseUrl?: string;
  key?: string;
  page?: number;
  book?: unknown;
  chapter?: unknown;
  source?: unknown;
  variables?: Record<string, string>;
}

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile';

/** 同步执行书源 JS；返回脚本最后一个表达式的值。 */
export function evalJs(script: string, env: JsEnv): unknown {
  const sandbox = createSandbox(env);
  const context = vm.createContext(sandbox);
  try {
    // 书源 JS 有两种写法：表达式（result.replace(...)）和带 return 的语句块。
    // 先按表达式执行；语法错误时按函数体再执行一次。
    try {
      return vm.runInContext(`(${script}\n)`, context, {
        timeout: 2000,
        filename: 'mo-reader-source.js',
      });
    } catch (error) {
      // vm 里抛出的 SyntaxError 来自另一个 realm，不能用 instanceof 判断。
      if ((error as { name?: string } | null)?.name !== 'SyntaxError') throw error;
      return vm.runInContext(`(function(){\n${script}\n})()`, context, {
        timeout: 2000,
        filename: 'mo-reader-source.js',
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`书源 JS 执行失败：${message}`);
  }
}

function createSandbox(env: JsEnv): Record<string, unknown> {
  const book = env.book as { name?: string; bookUrl?: string } | undefined;
  const source = env.source as { bookSourceUrl?: string } | undefined;
  const variables = env.variables ?? {};

  return {
    result: env.result,
    baseUrl: env.baseUrl ?? '',
    key: env.key ?? '',
    page: env.page ?? 1,
    book,
    chapter: env.chapter,
    source,
    cookie: '',
    title: book?.name ?? '',
    src: source?.bookSourceUrl ?? '',
    nextChapterUrl: '',
    variables,

    ajax: (url: string, options?: RequestOptions) => request(url, options),
    connect: (url: string, options?: RequestOptions) => request(url, options),
    get: (url: string, options?: RequestOptions) =>
      request(url, { ...options, method: 'GET' }),
    post: (url: string, body?: string) =>
      request(url, { method: 'POST', body: body ?? '' }),
    head: (url: string, options?: RequestOptions) =>
      request(url, { ...options, method: 'HEAD' }),
    webView: () => {
      throw new Error('WebView 在 Web 版不可用');
    },

    base64Encode: (value: string) => Buffer.from(String(value), 'utf8').toString('base64'),
    base64Decode: (value: string) => Buffer.from(String(value), 'base64').toString('utf8'),
    md5Encode: (value: string) => hash('md5', value),
    md5Encode16: (value: string) => hash('md5', value).slice(8, 24),
    sha1Encode: (value: string) => hash('sha1', value),
    sha256Encode: (value: string) => hash('sha256', value),
    hexEncode: (value: string) => Buffer.from(String(value), 'utf8').toString('hex'),
    hexDecode: (value: string) => Buffer.from(String(value), 'hex').toString('utf8'),
    urlEncode: (value: string) => encodeURIComponent(String(value)),
    urlDecode: (value: string) => decodeURIComponent(String(value)),
    getCookie: () => '',
    log: (value: unknown) => console.log('[mo-reader/source]', value),

    java: {
      // 阅读的 JsExtensions 把常用函数也挂在 java 上（书源里常见 java.md5Encode / java.ajax）。
      ajax: (url: string, options?: RequestOptions) => request(url, options),
      connect: (url: string, options?: RequestOptions) => request(url, options),
      get: (url: string, options?: RequestOptions) => request(url, { ...options, method: 'GET' }),
      post: (url: string, body?: string) => request(url, { method: 'POST', body: body ?? '' }),
      head: (url: string, options?: RequestOptions) => request(url, { ...options, method: 'HEAD' }),
      put: (key: string, value: unknown) => {
        variables[String(key)] = String(value)
      },
      getVariable: (key: string) => variables[String(key)],
      longToast: () => {},
      toast: () => {},
      log: (value: unknown) => console.log('[mo-reader/source]', value),
      webView: () => {
        throw new Error('WebView 在 Web 版不可用')
      },
      md5Encode: (value: string) => hash('md5', value),
      md5Encode16: (value: string) => hash('md5', value).slice(8, 24),
      sha1Encode: (value: string) => hash('sha1', value),
      sha256Encode: (value: string) => hash('sha256', value),
      base64Encode: (value: string) => Buffer.from(String(value), 'utf8').toString('base64'),
      base64Decode: (value: string) => Buffer.from(String(value), 'base64').toString('utf8'),
      hexEncode: (value: string) => Buffer.from(String(value), 'utf8').toString('hex'),
      hexDecode: (value: string) => Buffer.from(String(value), 'hex').toString('utf8'),
      urlEncode: (value: string) => encodeURIComponent(String(value)),
      urlDecode: (value: string) => decodeURIComponent(String(value)),
      getCookie: () => '',
      lang: {
        System: {
          currentTimeMillis: () => Date.now(),
          out: { println: (value: unknown) => console.log(value) },
        },
        String,
      },
      util: {
        Base64: {
          getEncoder: () => ({
            encodeToString: (value: string) =>
              Buffer.from(String(value), 'utf8').toString('base64'),
          }),
          getDecoder: () => ({
            decode: (value: string) => Buffer.from(String(value), 'base64').toString('utf8'),
          }),
        },
        UUID: { randomUUID: () => randomUUID() },
      },
      net: {
        URLEncoder: { encode: (value: string) => encodeURIComponent(String(value)) },
        URLDecoder: { decode: (value: string) => decodeURIComponent(String(value)) },
      },
    },
  };
}

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function request(rawUrl: string, options: RequestOptions = {}): string {
  const url = assertPublicSync(rawUrl);
  const args = [
    '-sS',
    '-L',
    '--max-redirs',
    '5',
    '--proto',
    '=http,https',
    '--proto-redir',
    '=http,https',
    '--max-time',
    '20',
    '--compressed',
    '-A',
    USER_AGENT,
  ];
  const method = (options.method ?? 'GET').toUpperCase();
  if (method !== 'GET') args.push('-X', method);
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    args.push('-H', `${key}: ${value}`);
  }
  if (options.body != null && method !== 'HEAD') {
    args.push('--data-binary', options.body);
  }
  args.push(url.toString());

  const result = spawnSync('curl', args, {
    encoding: 'utf8',
    timeout: 25_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`书源请求失败：${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`书源请求失败：curl 退出码 ${result.status ?? 'unknown'}`);
  }
  return result.stdout ?? '';
}

/**
 * JS 沙箱里的同步预检：字面量 + getent 解析结果。
 * 注意：curl 会重新解析 DNS，理论上仍有重绑定窗口；异步抓取链路用
 * assertPublicHttpUrl + 建连复检（M1 书源引擎）。
 */
function assertPublicSync(raw: string): URL {
  const url = parseHttpUrl(raw);
  const host = url.hostname;
  if (isIP(host)) return url;

  const result = spawnSync('getent', ['ahosts', host], { encoding: 'utf8', timeout: 5000 });
  const addresses = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((value) => isIP(value) !== 0);

  if (addresses.length === 0) {
    throw new UnsafeUrlError(`DNS 解析失败：${host}`);
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new UnsafeUrlError(`域名解析到内网地址：${host} → ${address}`);
    }
  }
  return url;
}

function hash(algorithm: string, value: string): string {
  return createHash(algorithm).update(String(value), 'utf8').digest('hex');
}

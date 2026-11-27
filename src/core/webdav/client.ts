/**
 * WebDAV 请求层（#131）：服务端发出、Basic 认证、PROPFIND depth 0，目录 404 时逐级 MKCOL。
 * 上传/下载（#133）直接复用 WebdavClient.send()，这里只负责连通与建目录。
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPrivateAddress } from '../net/guard.js'
import {
  parseWebdavAddress,
  redactWebdavPassword,
  webdavDirectoryHref,
  isPrivateWebdavHost,
  type WebdavConfig,
} from './config.js'

export type WebdavFetch = (url: string, init: RequestInit) => Promise<Response>

export type WebdavTestCode =
  | 'ok'
  | 'not-configured'
  | 'invalid-url'
  | 'private-blocked'
  | 'unauthorized'
  | 'forbidden'
  | 'server-error'
  | 'http'
  | 'certificate'
  | 'timeout'
  | 'network'

export interface WebdavTestResult {
  ok: boolean
  code: WebdavTestCode
  /** HTTP 状态码；没发请求或网络层失败时为 null。 */
  status: number | null
  elapsedMs: number
  message: string
  /** 404 后自动创建的目录数。 */
  createdDirs: number
}

export class WebdavRequestError extends Error {
  code: Exclude<WebdavTestCode, 'ok'>
  status: number | null

  constructor(code: Exclude<WebdavTestCode, 'ok'>, message: string, status: number | null = null) {
    super(message)
    this.name = 'WebdavRequestError'
    this.code = code
    this.status = status
  }
}

export const WEBDAV_DEFAULT_TIMEOUT_MS = 15000

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'

/** 证书类失败的底层错误码。 */
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
])

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function failureFromStatus(status: number, action = '连接'): WebdavRequestError {
  if (status === 401) return new WebdavRequestError('unauthorized', '账号或密码不正确（401）', status)
  if (status === 403) return new WebdavRequestError('forbidden', '账号没有权限（403）', status)
  if (status === 404) return new WebdavRequestError('http', '目录不存在（404）', status)
  if (status >= 500) return new WebdavRequestError('server-error', `服务器出错（${status}）`, status)
  return new WebdavRequestError('http', `${action}失败（HTTP ${status}）`, status)
}

function underlyingCode(error: unknown): string {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null
  const code = value?.cause?.code ?? value?.code
  return typeof code === 'string' ? code : ''
}

/** 网络层失败映射成用户看得懂的文案；凭据永远不进错误信息。 */
function mapFetchError(error: unknown): WebdavRequestError {
  const name = (error as { name?: unknown } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new WebdavRequestError('timeout', '连接超时，网络不通或地址不对')
  }
  const code = underlyingCode(error)
  if (CERTIFICATE_CODES.has(code) || /CERT|SSL|TLS/.test(code)) {
    return new WebdavRequestError('certificate', '证书不受信任，请检查地址或改用 http')
  }
  if (code === 'ENOTFOUND') return new WebdavRequestError('network', '域名解析失败，检查地址是否写对')
  return new WebdavRequestError('network', '网络不通，连不上服务器')
}

/** 私网/环回默认拒绝；显式允许后不再做地址检查。域名也要解析后逐个检查，避免用域名绕过。 */
async function assertTargetAllowed(url: URL, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return
  if (isPrivateWebdavHost(url.hostname)) {
    throw new WebdavRequestError('private-blocked', '这是本机或内网地址，需要先打开「允许私网」')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true, verbatim: true })
  } catch {
    // 解析失败交给 fetch 报错，文案统一走网络映射。
    return
  }
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw new WebdavRequestError(
        'private-blocked',
        `域名解析到内网地址（${url.hostname}），需要先打开「允许私网」`,
      )
    }
  }
}

export interface WebdavClientOptions {
  fetchImpl?: WebdavFetch
  timeoutMs?: number
}

/** 请求体：字符串或上传流；流式 PUT 需要 half duplex，走 options.duplex。 */
export interface WebdavSendOptions {
  headers?: Record<string, string>
  body?: string | Uint8Array | NodeJS.ReadableStream
  /** 调用方自带的取消信号；给了就不再套默认超时（上传/下载用自己的超时计时器）。 */
  signal?: AbortSignal
}

/** 把任意失败收敛成带 code/status 的 WebdavRequestError，避免上传下载各处重复判断。 */
export function toWebdavRequestError(error: unknown): WebdavRequestError {
  return error instanceof WebdavRequestError ? error : mapFetchError(error)
}

export function webdavFailureFromStatus(status: number, action = '连接'): WebdavRequestError {
  return failureFromStatus(status, action)
}

/**
 * 远端备份文件名：只允许单段名字，不能带路径（避免写到目标目录之外），
 * 空名字与超长名字直接给出可读提示。
 */
export function assertWebdavFileName(name: string): string {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) throw new WebdavRequestError('http', '请填写远端备份文件名')
  if (trimmed === '.' || trimmed === '..') throw new WebdavRequestError('http', '远端文件名不能带路径')
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    throw new WebdavRequestError('http', '远端文件名不能带路径')
  }
  if (trimmed.length > 255) throw new WebdavRequestError('http', '远端文件名太长，请控制在 255 个字符内')
  return trimmed
}

export class WebdavClient {
  readonly config: WebdavConfig
  private readonly fetchImpl: WebdavFetch
  private readonly timeoutMs: number

  constructor(config: WebdavConfig, options: WebdavClientOptions = {}) {
    this.config = config
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as WebdavFetch)
    this.timeoutMs = Math.max(1000, Math.min(120000, options.timeoutMs ?? WEBDAV_DEFAULT_TIMEOUT_MS))
  }

  /**
   * 统一出口：Basic 认证头与超时都由这里加；#133 的 PUT/GET 直接调用它。
   * 调用方给了 signal（上传/下载要取消与自定义超时）就用它，否则套默认超时。
   */
  async send(method: string, url: string, options: WebdavSendOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    const { username, password } = this.config
    if (username || password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    }
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
    }
    if (options.body !== undefined) {
      init.body = options.body as RequestInit['body']
      // Node 的 fetch 对流式请求体要求 half duplex，声明后才能发送。
      if (typeof options.body === 'object' && typeof (options.body as { pipe?: unknown }).pipe === 'function') {
        init.duplex = 'half'
      }
    }
    return this.fetchImpl(url, init)
  }

  /**
   * 上传/下载前的目录准备：解析地址、私网策略、PROPFIND depth 0；
   * 目录 404 时与 #131 测试连通一致地逐级 MKCOL。只建目录，不列目录内容。
   */
  async prepareDirectory(): Promise<{ createdDirs: number }> {
    const url = parseWebdavAddress(this.config.url)
    await assertTargetAllowed(url, this.config.allowPrivate)
    const target = webdavDirectoryHref(url)
    const response = await this.propfindDirectory(target)
    if (response.status === 404) {
      const createdDirs = await this.ensureDirectory(target)
      return { createdDirs }
    }
    if (!isSuccess(response.status)) throw failureFromStatus(response.status, '连接目录')
    return { createdDirs: 0 }
  }

  /** 目标文件地址：目录地址补斜杠后拼单段文件名（编码后只写这一个文件）。 */
  fileUrl(fileName: string): string {
    const directory = webdavDirectoryHref(parseWebdavAddress(this.config.url))
    return `${directory}${encodeURIComponent(assertWebdavFileName(fileName))}`
  }

  /** 覆盖前探测远端同名文件；有的服务器不支持 HEAD（405/501），由调用方按「未知」处理。 */
  headFile(url: string): Promise<Response> {
    return this.send('HEAD', url)
  }

  /** 取回远端备份；调用方负责超时与取消信号。 */
  downloadFile(url: string, signal?: AbortSignal): Promise<Response> {
    return this.send('GET', url, { signal })
  }

  async propfindDirectory(url: string): Promise<Response> {
    return this.send('PROPFIND', url, {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
    })
  }

  /** 目录 404 时从根开始逐级 MKCOL；已存在的目录（405）跳过，返回真实新建的数量。 */
  async ensureDirectory(target: string): Promise<number> {
    const url = new URL(target)
    const segments = url.pathname.split('/').filter(Boolean)
    let created = 0
    let base = `${url.origin}/`
    for (const segment of segments) {
      base = `${base}${segment}/`
      const response = await this.send('MKCOL', base)
      if (response.status === 201) {
        created += 1
        continue
      }
      if (response.status === 405) continue
      if (isSuccess(response.status)) continue
      if (response.status === 409) {
        throw new WebdavRequestError('http', '上级目录不存在，自动创建失败（409）', response.status)
      }
      throw failureFromStatus(response.status, '创建目录')
    }
    return created
  }

  async testConnection(): Promise<WebdavTestResult> {
    const started = Date.now()
    const elapsed = () => Date.now() - started
    if (!this.config.url) {
      return {
        ok: false,
        code: 'not-configured',
        status: null,
        elapsedMs: 0,
        message: '还没配置 WebDAV 地址',
        createdDirs: 0,
      }
    }
    let url: URL
    try {
      url = parseWebdavAddress(this.config.url)
    } catch (error) {
      return {
        ok: false,
        code: 'invalid-url',
        status: null,
        elapsedMs: elapsed(),
        message: error instanceof Error ? error.message : 'WebDAV 地址不合法',
        createdDirs: 0,
      }
    }
    try {
      await assertTargetAllowed(url, this.config.allowPrivate)
      const target = webdavDirectoryHref(url)
      let response = await this.propfindDirectory(target)
      let createdDirs = 0
      if (response.status === 404) {
        createdDirs = await this.ensureDirectory(target)
        response = await this.propfindDirectory(target)
      }
      if (!isSuccess(response.status)) throw failureFromStatus(response.status)
      return {
        ok: true,
        code: 'ok',
        status: response.status,
        elapsedMs: elapsed(),
        message: createdDirs > 0 ? `连接成功，已创建 ${createdDirs} 个目录` : '连接成功',
        createdDirs,
      }
    } catch (error) {
      const failure = error instanceof WebdavRequestError ? error : mapFetchError(error)
      return {
        ok: false,
        code: failure.code,
        status: failure.status,
        elapsedMs: elapsed(),
        message: redactWebdavPassword(failure.message, this.config.password),
        createdDirs: 0,
      }
    }
  }
}

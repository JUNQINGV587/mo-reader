/**
 * 媒体代理（#110）：章节解析时把图片 / 音视频地址登记成不可猜测的 token，
 * 阅读器只拿到 `${origin}/reader/media/<token>/<safeName>.<ext>`。
 *
 * token 只存在于内存登记表里，对外不暴露真实地址：路由按 token 换回地址，
 * 带上登记时的书源 header / Referer 抓取，并原样流式回传（支持 Range / HEAD）。
 * HLS playlist 里的分片、子 playlist 与加密 key 也改写成新的代理 token。
 */
import { randomBytes } from 'node:crypto'
import { assertPublicHttpUrl, UnsafeUrlError } from '../core/net/guard.js'
import { readBodyLimited, type MediaStreamResult } from '../core/net/http.js'
import { ARTIFACT_CACHE_CONTROL } from './routes.js'
import type { ArtifactPeer, ArtifactRoute, ArtifactWebServer } from './routes.js'

export const MEDIA_ROUTE_PATH = '/reader/media'
/** token 白名单：base64url，默认 24 字符；上限放宽到 64，方便以后换更长的随机串。 */
export const MEDIA_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/
/** 内存登记表默认保留 1 小时；重新解析章节会换新 token，旧 token 过期即 404。 */
export const MEDIA_TTL_MS = 60 * 60 * 1000
/** 登记表最多 2000 条，超限淘汰最早登记的那条。 */
export const MEDIA_MAX_ENTRIES = 2000
/** playlist 文本上限；超过直接失败，避免把大文件读进内存。 */
export const PLAYLIST_MAX_BYTES = 8 * 1024 * 1024

export type MediaKind = 'image' | 'audio' | 'video' | 'hls' | 'segment' | 'key' | 'other'

export interface MediaEntry {
  /** 真实上游地址；只在服务端内存里，绝不出现在响应里。 */
  url: string
  /** 抓取上游时要带的请求头（书源 header + Referer）。 */
  headers: Record<string, string>
  /** 代理 URL 最后一段的扩展名，VideoReader 靠 .m3u8 判断 HLS。 */
  ext: string
  kind: MediaKind
  createdAt: number
}

export interface MediaRegistryOptions {
  /** 有效期（毫秒）；负数表示永不过期，仅测试用。 */
  ttlMs?: number
  maxEntries?: number
  /** 时钟注入，便于测试过期逻辑。 */
  now?: () => number
}

export interface RegisterMediaOptions {
  headers?: Record<string, string>
  /** 扩展名提示；不传或非法时按 kind 兜底。 */
  ext?: string
  kind?: MediaKind
  /** 传了才按这个键复用已有 token（图片可按「章节 + 地址」去重）。 */
  dedupeKey?: string
}

const DEFAULT_EXT_BY_KIND: Record<MediaKind, string> = {
  image: 'jpg',
  audio: 'mp3',
  video: 'mp4',
  hls: 'm3u8',
  segment: 'ts',
  key: 'key',
  other: 'bin',
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  key: 'application/octet-stream',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  flv: 'video/x-flv',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
}

/** 按媒体类别给兜底扩展名；登记时算代理 URL 的最后一段要用。 */
export function defaultExtForKind(kind: MediaKind): string {
  return DEFAULT_EXT_BY_KIND[kind]
}

/** 按扩展名给兜底 Content-Type；上游给了具体类型时优先用上游的。 */
export function contentTypeForExt(ext: string): string {
  return CONTENT_TYPE_BY_EXT[String(ext).toLowerCase()] ?? 'application/octet-stream'
}

/** 规整扩展名：只允许短字母数字，非法值按 kind 兜底。 */
function normalizeExt(ext: string | undefined, kind: MediaKind = 'other'): string {
  const candidate = String(ext ?? '').trim().toLowerCase().replace(/^\./, '')
  return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : DEFAULT_EXT_BY_KIND[kind]
}

/** 从 URL 路径推断扩展名；查询串与本机不可解析的地址走兜底值。 */
export function extFromUrl(rawUrl: string, fallback = 'bin'): string {
  try {
    const pathname = new URL(rawUrl).pathname
    const match = /\.([A-Za-z0-9]{1,8})$/.exec(pathname)
    if (match) return match[1]!.toLowerCase()
  } catch {
    // 相对地址等无法单独解析的 URL 用兜底扩展名。
  }
  return fallback
}

/** 代理 URL 里的安全文件名：只留 ASCII 字母数字与短横线，中文等退化成 media。 */
export function safeMediaName(rawUrl: string, fallback = 'media'): string {
  let base = ''
  try {
    const pathname = new URL(rawUrl).pathname
    base = pathname.split('/').pop() ?? ''
    base = decodeURIComponent(base)
  } catch {
    base = ''
  }
  base = base.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  base = base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return base || fallback
}

/** 代理路径：token 一段 + 文件名一段，最后一段必须带扩展名。 */
export function mediaPath(token: string, name: string, ext: string): string {
  const fileName = `${name || 'media'}.${normalizeExt(ext)}`
  return `${MEDIA_ROUTE_PATH}/${token}/${fileName}`
}

/** 完整代理地址；宿主还没监听（origin 为空）时退回相对路径。 */
export function mediaUrlOf(origin: string, token: string, name: string, ext: string): string {
  const base = String(origin || '').replace(/\/+$/, '')
  return `${base}${mediaPath(token, name, ext)}`
}

/**
 * 内存登记表：token → 真实地址。不按 URL 去重（除非调用方显式给 dedupeKey），
 * 避免子 playlist 反复改写时复用 token 命中浏览器缓存、拿到旧内容。
 */
export class MediaRegistry {
  ttlMs: number

  maxEntries: number

  private readonly now: () => number

  private readonly entries = new Map<string, MediaEntry>()

  private readonly dedupe = new Map<string, string>()

  constructor(options: MediaRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? MEDIA_TTL_MS
    this.maxEntries = options.maxEntries ?? MEDIA_MAX_ENTRIES
    this.now = options.now ?? Date.now
  }

  /** 登记一条媒体地址，返回新的 24 字符 URL-safe token。 */
  register(url: string, options: RegisterMediaOptions = {}): string {
    const dedupeKey = options.dedupeKey ?? ''
    if (dedupeKey) {
      const existing = this.dedupe.get(dedupeKey)
      if (existing && this.get(existing)) return existing
      this.dedupe.delete(dedupeKey)
    }
    this.dropExpired()
    const token = randomBytes(18).toString('base64url')
    const kind = options.kind ?? 'other'
    this.entries.set(token, {
      url,
      headers: { ...(options.headers ?? {}) },
      ext: normalizeExt(options.ext, kind),
      kind,
      createdAt: this.now(),
    })
    if (dedupeKey) this.dedupe.set(dedupeKey, token)
    // Map 保持插入顺序：超限时删最早的一条。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (!oldest) break
      this.entries.delete(oldest)
    }
    return token
  }

  /** 按 token 取条目；token 形状不对、未知或已过期都返回 null。 */
  get(token: string): MediaEntry | null {
    if (!MEDIA_TOKEN_PATTERN.test(token)) return null
    const entry = this.entries.get(token)
    if (!entry) return null
    if (this.ttlMs >= 0 && this.now() - entry.createdAt >= this.ttlMs) {
      this.entries.delete(token)
      return null
    }
    return entry
  }

  size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.dedupe.clear()
  }

  /** 惰性清理过期条目，避免长期运行后堆积；get 时也会顺手删过期项。 */
  private dropExpired(): void {
    if (this.ttlMs < 0) return
    const now = this.now()
    for (const [token, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) this.entries.delete(token)
    }
  }
}

/** 带 URI 属性的 HLS 标签：key / 初始化段 / 子 playlist / LL-HLS 分片。 */
const PLAYLIST_URI_TAGS: Record<string, { ext: string; kind: MediaKind }> = {
  '#EXT-X-KEY': { ext: 'key', kind: 'key' },
  '#EXT-X-SESSION-KEY': { ext: 'key', kind: 'key' },
  '#EXT-X-MAP': { ext: 'mp4', kind: 'segment' },
  '#EXT-X-MEDIA': { ext: 'm3u8', kind: 'hls' },
  '#EXT-X-I-FRAME-STREAM-INF': { ext: 'm3u8', kind: 'hls' },
  '#EXT-X-RENDITION-REPORT': { ext: 'm3u8', kind: 'hls' },
  '#EXT-X-PART': { ext: 'm4s', kind: 'segment' },
  '#EXT-X-PRELOAD-HINT': { ext: 'm4s', kind: 'segment' },
}

export interface PlaylistRewriteOptions {
  /** playlist 的最终地址（逐跳重定向之后），相对 URI 按它补全。 */
  playlistUrl: string
  /** 把一条绝对 URI 换成代理地址；抛错则整条 playlist 失败。 */
  rewriteUrl(absoluteUrl: string, hint: { ext: string; kind: MediaKind }): Promise<string>
}

/** 把 playlist 里的分片 / 子 playlist / key 逐条改写成代理地址；查询串原样保留。 */
export async function rewritePlaylist(text: string, options: PlaylistRewriteOptions): Promise<string> {
  const body = String(text ?? '').replace(/^\uFEFF/, '')
  const lines = body.split(/\r?\n/)
  const output: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      output.push(line)
      continue
    }
    if (trimmed.startsWith('#')) {
      output.push(await rewriteTagLine(trimmed, options))
      continue
    }
    const absolute = resolvePlaylistUri(trimmed, options.playlistUrl)
    output.push(await options.rewriteUrl(absolute, { ext: extFromUrl(absolute, 'ts'), kind: 'segment' }))
  }
  return output.join('\n')
}

/** 只改带 URI 属性的标签行，其余注释原样保留。 */
async function rewriteTagLine(line: string, options: PlaylistRewriteOptions): Promise<string> {
  const tag = /^(#[A-Za-z0-9-]+)/.exec(line)?.[1]?.toUpperCase() ?? ''
  const hint = PLAYLIST_URI_TAGS[tag]
  if (!hint) return line
  // HLS 规范里 URI 是带引号的字符串；裸写也兼容，输出统一带引号。
  const pattern = /URI=("([^"]*)"|[^,\s]+)/g
  const matches = [...line.matchAll(pattern)]
  if (!matches.length) return line
  let result = ''
  let cursor = 0
  for (const match of matches) {
    const index = match.index ?? 0
    const rawUri = match[2] !== undefined ? match[2] : match[1]
    const absolute = resolvePlaylistUri(rawUri ?? '', options.playlistUrl)
    const proxy = await options.rewriteUrl(absolute, { ext: extFromUrl(absolute, hint.ext), kind: hint.kind })
    result += line.slice(cursor, index) + `URI="${proxy}"`
    cursor = index + match[0].length
  }
  return result + line.slice(cursor)
}

function resolvePlaylistUri(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString()
  } catch {
    throw new Error(`播放列表里的地址无法解析：${raw}`)
  }
}

export interface MediaRouteOptions {
  path?: string
  auth?: 'required' | 'anonymous' | 'deny'
  registry(): MediaRegistry
  /** 宿主对外地址（含协议与端口），用于拼子资源的代理地址。 */
  origin(): string
  /** 抓取上游；service 里包一层便于测试替换成不联网的假实现。 */
  openStream(entry: MediaEntry, options: { method: 'GET' | 'HEAD'; range?: string }): Promise<MediaStreamResult>
  allow?(peer: ArtifactPeer | undefined): boolean
  requirePeer?: boolean
}

/** 注册媒体代理路由并返回释放函数；与导出 / PDF 路由同一套注册语义。 */
export function registerMediaRoute(webServer: ArtifactWebServer, options: MediaRouteOptions): () => void {
  const dispose = webServer.register(createMediaRoute(options))
  return typeof dispose === 'function' ? (dispose as () => void) : () => {}
}

export function createMediaRoute(options: MediaRouteOptions): ArtifactRoute {
  const routePath = options.path ?? MEDIA_ROUTE_PATH
  const requirePeer = options.requirePeer !== false
  const allow = options.allow ?? ((peer: ArtifactPeer | undefined) => peer?.principal?.kind === 'owner')
  return {
    kind: 'prefix',
    path: routePath,
    auth: options.auth ?? 'required',
    async resource(request: Request, peer?: ArtifactPeer): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return fail(405, { Allow: 'GET, HEAD' })
      }
      if (requirePeer && !peer) return fail(401)
      if (!allow(peer)) return fail(403)

      const token = mediaTokenOf(request, routePath)
      if (!token) return fail(404)
      const registry = options.registry()
      const entry = registry.get(token)
      if (!entry) return fail(404)

      const requestMethod: 'GET' | 'HEAD' = request.method === 'HEAD' ? 'HEAD' : 'GET'
      const range = request.headers.get('range') || undefined
      // 已知是 playlist 时必须 GET：改写要读全文，HEAD 也要报告改写后的长度。
      const method: 'GET' | 'HEAD' = entry.ext === 'm3u8' || entry.kind === 'hls' ? 'GET' : requestMethod
      let opened: MediaStreamResult
      try {
        opened = await options.openStream(entry, { method, range: method === 'GET' ? range : undefined })
      } catch {
        return fail(502, {}, '媒体代理抓取失败')
      }

      const contentType = (opened.response.headers.get('content-type') ?? '').toLowerCase()
      let playlist = isPlaylistResponse(entry, contentType, opened.finalUrl)
      if (playlist && requestMethod === 'HEAD' && method === 'HEAD') {
        // 只有响应头才认出是 playlist：再取一次正文，才能算改写后的长度。
        try {
          opened = await options.openStream(entry, { method: 'GET' })
        } catch {
          return fail(502, {}, '媒体代理抓取失败')
        }
        playlist = true
      }

      const origin = safeOrigin(options.origin())
      if (playlist) return servePlaylist(requestMethod, opened, entry, registry, origin)
      return serveStream(requestMethod, opened, entry)
    },
  }
}

async function servePlaylist(
  requestMethod: 'GET' | 'HEAD',
  opened: MediaStreamResult,
  entry: MediaEntry,
  registry: MediaRegistry,
  origin: string,
): Promise<Response> {
  let text: string
  try {
    const buffer = await readBodyLimited(opened.response, PLAYLIST_MAX_BYTES)
    text = buffer.toString('utf8')
  } catch {
    return fail(502, {}, '播放列表读取失败')
  }
  const baseUrl = opened.finalUrl
  // 子资源沿用书源 header，Referer 换成 playlist 地址（多数 CDN 按它校验）。
  const childHeaders: Record<string, string> = { ...entry.headers, Referer: baseUrl }
  let rewritten: string
  try {
    rewritten = await rewritePlaylist(text, {
      playlistUrl: baseUrl,
      async rewriteUrl(absoluteUrl, hint) {
        await assertPublicHttpUrl(absoluteUrl)
        const childToken = registry.register(absoluteUrl, {
          headers: childHeaders,
          ext: hint.ext,
          kind: hint.kind,
        })
        return mediaUrlOf(origin, childToken, safeMediaName(absoluteUrl), hint.ext)
      },
    })
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      return fail(403, {}, '播放列表包含不允许的地址')
    }
    return fail(502, {}, '播放列表改写失败')
  }
  const bytes = Buffer.byteLength(rewritten, 'utf8')
  const headers: Record<string, string> = {
    'Content-Type': 'application/vnd.apple.mpegurl',
    'Content-Length': String(bytes),
    'Content-Disposition': inlineHeader(safeMediaName(baseUrl), 'm3u8'),
    'Cache-Control': ARTIFACT_CACHE_CONTROL,
  }
  if (requestMethod === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(rewritten, { status: 200, headers })
}

/** 普通媒体流：Range / HEAD 原样透传，不缓冲、不伪造 Content-Range。 */
function serveStream(
  requestMethod: 'GET' | 'HEAD',
  opened: MediaStreamResult,
  entry: MediaEntry,
): Response {
  const status = opened.response.status
  if (status !== 200 && status !== 206 && status !== 416) {
    return fail(502, {}, '媒体代理上游错误')
  }
  const headers: Record<string, string> = {
    'Content-Type': upstreamContentType(opened, entry),
    'Content-Disposition': inlineHeader(safeMediaName(entry.url), entry.ext),
    'Cache-Control': ARTIFACT_CACHE_CONTROL,
  }
  copyHeader(opened.response, headers, 'Content-Length', 'content-length')
  copyHeader(opened.response, headers, 'Content-Range', 'content-range')
  copyHeader(opened.response, headers, 'Accept-Ranges', 'accept-ranges')
  if (requestMethod === 'HEAD' || status === 416) return new Response(null, { status, headers })
  const body = opened.response.body
  if (!body) return new Response(null, { status, headers })
  return new Response(body, { status, headers })
}

/** 上游 Content-Type 为空或过于笼统时按扩展名补一个，保证音视频能被浏览器识别。 */
function upstreamContentType(opened: MediaStreamResult, entry: MediaEntry): string {
  const raw = (opened.response.headers.get('content-type') ?? '').trim()
  if (raw && !/^application\/octet-stream$/i.test(raw)) return raw
  return contentTypeForExt(entry.ext)
}

function copyHeader(
  response: Response,
  headers: Record<string, string>,
  name: string,
  lowerName: string,
): void {
  const value = response.headers.get(lowerName)
  if (value !== null) headers[name] = value
}

/** 浏览器内播放用 inline，不走下载语义。 */
function inlineHeader(name: string, ext: string): string {
  const fileName = `${name || 'media'}.${normalizeExt(ext)}`.replace(/[^A-Za-z0-9._-]/g, '_')
  return `inline; filename="${fileName}"`
}

/** 从 URL 里取第一段 token；文件名段可选，多余路径一律 404。 */
export function mediaTokenOf(request: Request, routePath: string = MEDIA_ROUTE_PATH): string {
  let pathname = ''
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return ''
  }
  if (!pathname.startsWith(`${routePath}/`)) return ''
  const rest = pathname.slice(routePath.length + 1)
  const segments = rest.split('/')
  if (segments.length === 0 || segments.length > 2) return ''
  let token = ''
  try {
    token = decodeURIComponent(segments[0] ?? '')
  } catch {
    return ''
  }
  return MEDIA_TOKEN_PATTERN.test(token) ? token : ''
}

function isPlaylistResponse(entry: MediaEntry, contentType: string, finalUrl: string): boolean {
  if (entry.ext === 'm3u8' || entry.kind === 'hls') return true
  if (contentType.includes('mpegurl')) return true
  try {
    return /\.m3u8$/i.test(new URL(finalUrl).pathname)
  } catch {
    return false
  }
}

function safeOrigin(value: string): string {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : ''
}

function fail(status: number, extra: Record<string, string> = {}, message = ''): Response {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store', ...extra }
  if (message) headers['Content-Type'] = 'text/plain; charset=utf-8'
  return new Response(message || null, { status, headers })
}

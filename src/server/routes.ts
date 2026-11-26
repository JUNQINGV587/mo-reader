import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isArtifactFileName } from './exports.js'

/** 通用受保护产物路由：目前服务导出文件，#109（PDF 原文件）与 #110（媒体代理）可复用同一套校验。 */
export const EXPORT_ROUTE_PATH = '/reader/exports'
/** 导出失败章节完整清单的下载路由：只有失败数超过界面展示上限时才有文件。 */
export const EXPORT_FAILED_ROUTE_PATH = '/reader/exports-failed'
/** 本地 PDF 原文件路由：URL 里是 24 位小写十六进制书 id，路径由服务端自己拼。 */
export const LOCAL_PDF_ROUTE_PATH = '/reader/local-pdf'
/** 本地媒体文件路由（#112）：URL 里是 24 位十六进制文件摘要，路径由索引反查。 */
export const LOCAL_MEDIA_ROUTE_PATH = '/reader/media-local'
/** 导出作业 id 的默认白名单：单段、字母数字开头、允许短横线。 */
const DEFAULT_ARTIFACT_ID_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/
/** 私有产物只让浏览器本地缓存，不进共享缓存。 */
export const ARTIFACT_CACHE_CONTROL = 'private, max-age=0'

export interface ArtifactDescriptor {
  /** 相对产物根目录的文件名，必须是不含路径分隔符的巴斯名。 */
  filePath: string
  /** 浏览器下载时展示的文件名。 */
  fileName: string
  contentType: string
}

/** 只依赖 Peer 的身份字段，避免把宿主插件类型带进本服务。 */
export interface ArtifactPeer {
  principal?: { kind?: string }
}

export interface ArtifactRouteOptions {
  /** 路由前缀，默认 /reader/exports。 */
  path?: string
  /** 宿主鉴权规则；默认 required（匿名请求由宿主返回 401）。 */
  auth?: 'required' | 'anonymous' | 'deny'
  /** 产物根目录；每次取用时求值，便于测试改环境变量。 */
  root(): string
  /** 由作业 id 定位产物；返回 null 表示没有可下载的产物（404）。 */
  locate(jobId: string): Promise<ArtifactDescriptor | null> | ArtifactDescriptor | null
  /** 身份校验，默认只放行 Host 属主；不满足返回 403。 */
  allow?(peer: ArtifactPeer | undefined): boolean
  /** 是否要求已登录；默认 true（未登录 401）。 */
  requirePeer?: boolean
}

export interface ArtifactRoute {
  kind: 'prefix'
  path: string
  auth: 'required' | 'anonymous' | 'deny'
  resource(request: Request, peer?: ArtifactPeer): Promise<Response>
}

/** 宿主 webServer 的最小结构：注册返回释放函数（或 undefined）。 */
export interface ArtifactWebServer {
  register(route: ArtifactRoute): unknown
}

/** 注册路由并返回释放函数；测试可直接用假 webServer 检查声明。 */
export function registerArtifactRoute(webServer: ArtifactWebServer, options: ArtifactRouteOptions): () => void {
  const route = createArtifactRoute(options)
  const dispose = webServer.register(route)
  return typeof dispose === 'function' ? (dispose as () => void) : () => {}
}

export function createArtifactRoute(options: ArtifactRouteOptions): ArtifactRoute {
  return {
    kind: 'prefix',
    path: options.path ?? EXPORT_ROUTE_PATH,
    auth: options.auth ?? 'required',
    resource: createArtifactResource(options),
  }
}

export function createArtifactResource(
  options: ArtifactRouteOptions,
): (request: Request, peer?: ArtifactPeer) => Promise<Response> {
  const routePath = options.path ?? EXPORT_ROUTE_PATH
  const requirePeer = options.requirePeer !== false
  const allow = options.allow ?? ((peer: ArtifactPeer | undefined) => peer?.principal?.kind === 'owner')
  return async function artifactResource(request: Request, peer?: ArtifactPeer): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return refuse(405, { Allow: 'GET, HEAD' })
    }
    if (requirePeer && !peer) return refuse(401)
    if (!allow(peer)) return refuse(403)
    const jobId = artifactIdOf(request, routePath)
    if (!jobId) return refuse(404)
    let descriptor: ArtifactDescriptor | null = null
    try {
      descriptor = await options.locate(jobId)
    } catch {
      return refuse(404)
    }
    if (!descriptor) return refuse(404)
    const absolute = resolveArtifactPath(options.root(), descriptor.filePath)
    if (!absolute) return refuse(404)
    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(absolute)
    } catch {
      return refuse(404)
    }
    if (!info.isFile()) return refuse(404)
    const headers: Record<string, string> = {
      'Content-Type': descriptor.contentType || 'application/octet-stream',
      'Content-Length': String(info.size),
      'Content-Disposition': attachmentHeader(descriptor.fileName),
      'Cache-Control': ARTIFACT_CACHE_CONTROL,
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const stream = createReadStream(absolute)
    // 客户端中途断开时由响应流收尾，避免 Node 流抛未捕获的 error 事件。
    stream.on('error', () => {})
    const body = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
    return new Response(body, { status: 200, headers })
  }
}

/**
 * 从请求路径里取作业 id：只认单段、形如 UUID/短横线标识的 id。
 * 任何编码过的路径分隔符、点段都会在解码后落到白名单之外，直接 404。
 */
export function artifactIdOf(request: Request, routePath: string): string {
  return singleSegmentIdOf(request, routePath, DEFAULT_ARTIFACT_ID_PATTERN)
}

/** 受保护文件路由的请求：id 必填，HLS 分片/playlist 额外带一个文件名。 */
export interface ProtectedFileRequest {
  id: string
  name?: string
}

/** 第二段文件名白名单：只允许单段、非点开头，长度够 HLS 的 index.m3u8 / seg-000.ts。 */
const PROTECTED_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * 从 URL 取 <id> 或 <id>/<name>：两段分别解码并各自过白名单，
 * 多段、'.'/'..'、编码过的路径分隔符都会落到白名单外，直接 404。
 */
export function protectedFileRequestOf(
  request: Request,
  routePath: string,
  pattern: RegExp,
  allowName = false,
): ProtectedFileRequest | null {
  let pathname = ''
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return null
  }
  if (pathname !== routePath && !pathname.startsWith(`${routePath}/`)) return null
  const rest = pathname.slice(routePath.length + 1)
  if (!rest) return null
  const parts = rest.split('/')
  if (!allowName && parts.length > 1) return null
  if (parts.length > 2) return null
  let id = ''
  let name: string | undefined
  try {
    id = decodeURIComponent(parts[0] ?? '')
    if (parts.length === 2) name = decodeURIComponent(parts[1] ?? '')
  } catch {
    return null
  }
  if (!pattern.test(id)) return null
  if (name !== undefined && !PROTECTED_FILE_NAME_PATTERN.test(name)) return null
  return name === undefined ? { id } : { id, name }
}

/** 只从 URL 里取「单段且匹配白名单」的 id：多段、'.'/'..'、编码绕过都会落到白名单外。 */
export function singleSegmentIdOf(request: Request, routePath: string, pattern: RegExp): string {
  let pathname = ''
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return ''
  }
  if (pathname !== routePath && !pathname.startsWith(`${routePath}/`)) return ''
  const rest = pathname.slice(routePath.length + 1)
  if (!rest || rest.includes('/')) return ''
  let id = ''
  try {
    id = decodeURIComponent(rest)
  } catch {
    return ''
  }
  return pattern.test(id) ? id : ''
}

/** 解析产物绝对路径：只接受根目录下的单段文件名，解析后仍在根目录内。 */
export function resolveArtifactPath(root: string, filePath: string): string | null {
  if (!isArtifactFileName(filePath)) return null
  const rootPath = resolve(root)
  const absolute = resolve(rootPath, filePath)
  if (absolute === rootPath) return null
  if (!absolute.startsWith(rootPath + sep)) return null
  return absolute
}

/** RFC 6266 下载头：ASCII 兜底 + UTF-8 扩展文件名，中文书名不丢。 */
export function attachmentHeader(
  fileName: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = String(fileName || 'download')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["\\]/g, '_')
    .trim() || 'download'
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** 受保护文件路由的产物描述：filePath 相对 root，可含子目录，但解析后必须仍在 root 内。 */
export interface FileArtifactDescriptor {
  filePath: string
  fileName: string
  contentType: string
  /** 浏览器展示方式：下载附件（默认）或内联播放/查看（图片、音频、视频）。 */
  disposition?: 'attachment' | 'inline'
}

export interface ProtectedFileRouteOptions {
  /** 路由前缀，默认本地 PDF 原文件路由。 */
  path?: string
  auth?: 'required' | 'anonymous' | 'deny'
  root(): string
  /**
   * 由 URL 里的 id（以及可选的第二段文件名）定位产物；两者都已通过白名单校验。
   * 返回 null 表示 404；name 只用于 HLS 的 <id>/<分片名> 形式。
   */
  locate(id: string, name?: string): Promise<FileArtifactDescriptor | null> | FileArtifactDescriptor | null
  /** 是否允许 <id>/<name> 两段（HLS 的 playlist 与分片）；默认只认单段 id。 */
  allowName?: boolean
  /** id 白名单，默认沿用导出路由的标识规则。 */
  idPattern?: RegExp
  /** 响应缓存策略；默认 private, max-age=0，随版本不变的静态资源可以放宽。 */
  cacheControl?: string
  allow?(peer: ArtifactPeer | undefined): boolean
  requirePeer?: boolean
}

/** 注册受保护文件路由并返回释放函数；与导出路由同一套注册语义。 */
export function registerProtectedFileRoute(
  webServer: ArtifactWebServer,
  options: ProtectedFileRouteOptions,
): () => void {
  const route = createProtectedFileRoute(options)
  const dispose = webServer.register(route)
  return typeof dispose === 'function' ? (dispose as () => void) : () => {}
}

/**
 * 受保护文件路由：#109 的 PDF 原文件走这里，#110 的媒体代理可以复用同一套
 * 鉴权 + Range 逻辑。id 只从 URL 取白名单形状，文件路径永远由 locate 在服务端拼。
 */
export function createProtectedFileRoute(options: ProtectedFileRouteOptions): ArtifactRoute {
  const routePath = options.path ?? LOCAL_PDF_ROUTE_PATH
  const idPattern = options.idPattern ?? DEFAULT_ARTIFACT_ID_PATTERN
  const requirePeer = options.requirePeer !== false
  const allow = options.allow ?? ((peer: ArtifactPeer | undefined) => peer?.principal?.kind === 'owner')
  return {
    kind: 'prefix',
    path: routePath,
    auth: options.auth ?? 'required',
    async resource(request: Request, peer?: ArtifactPeer): Promise<Response> {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return refuse(405, { Allow: 'GET, HEAD' })
      }
      if (requirePeer && !peer) return refuse(401)
      if (!allow(peer)) return refuse(403)
      const target = protectedFileRequestOf(request, routePath, idPattern, options.allowName === true)
      if (!target) return refuse(404)
      let descriptor: FileArtifactDescriptor | null = null
      try {
        descriptor = await options.locate(target.id, target.name)
      } catch {
        return refuse(404)
      }
      if (!descriptor) return refuse(404)
      const absolute = resolveResourcePath(options.root(), descriptor.filePath)
      if (!absolute) return refuse(404)
      return serveFileResponse(request, {
        absolutePath: absolute,
        fileName: descriptor.fileName,
        contentType: descriptor.contentType,
        disposition: descriptor.disposition,
        cacheControl: options.cacheControl,
      })
    },
  }
}

/**
 * 按本地文件与 Request 生成 200 / 206 / 416 / HEAD 响应；#110 媒体代理直接复用。
 * 只支持单段 Range：多段（逗号）与语法错误一律 416，避免返回一份拼不完整的响应。
 */
export async function serveFileResponse(
  request: Request,
  options: {
    absolutePath: string
    fileName: string
    contentType: string
    disposition?: 'attachment' | 'inline'
    /** 响应缓存策略，默认 ARTIFACT_CACHE_CONTROL。 */
    cacheControl?: string
  },
): Promise<Response> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(options.absolutePath)
  } catch {
    return refuse(404)
  }
  if (!info.isFile()) return refuse(404)
  const size = info.size
  const headers: Record<string, string> = {
    'Content-Type': options.contentType || 'application/octet-stream',
    'Content-Length': String(size),
    'Content-Disposition': attachmentHeader(options.fileName, options.disposition),
    'Cache-Control': options.cacheControl ?? ARTIFACT_CACHE_CONTROL,
    'Accept-Ranges': 'bytes',
  }
  // HEAD 不解析 Range，按整文件报告长度，客户端不会误读半份内容。
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const range = parseRangeHeader(request.headers.get('range'), size)
  if (range === 'invalid') {
    return new Response(null, {
      status: 416,
      headers: {
        'Content-Range': `bytes */${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': options.contentType || 'application/octet-stream',
      },
    })
  }
  if (!range) {
    const stream = createReadStream(options.absolutePath)
    stream.on('error', () => {})
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, { status: 200, headers })
  }
  const stream = createReadStream(options.absolutePath, { start: range.start, end: range.end })
  stream.on('error', () => {})
  const partialHeaders = {
    ...headers,
    'Content-Length': String(range.end - range.start + 1),
    'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
  }
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: 206,
    headers: partialHeaders,
  })
}

interface ByteRange {
  start: number
  end: number
}

/** 解析单段 Range；null 表示没有 Range（整文件），'invalid' 表示应按 416 回复。 */
function parseRangeHeader(header: string | null, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const startText = match[1] ?? ''
  const endText = match[2] ?? ''
  if (!startText && !endText) return 'invalid'
  if (size === 0) return 'invalid'
  if (!startText) {
    const suffix = Number(endText)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(size - suffix, 0), end: size - 1 }
  }
  const start = Number(startText)
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid'
  if (!endText) return { start, end: size - 1 }
  const end = Number(endText)
  if (!Number.isSafeInteger(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** 解析受保护路由的绝对路径：允许子目录，但任何越出根目录的写法都返回 null。 */
function resolveResourcePath(root: string, filePath: string): string | null {
  if (!filePath || filePath.includes('\0') || isAbsolute(filePath)) return null
  const rootPath = resolve(root)
  const absolute = resolve(rootPath, filePath)
  if (absolute === rootPath) return null
  if (!absolute.startsWith(rootPath + sep)) return null
  return absolute
}

function refuse(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } })
}

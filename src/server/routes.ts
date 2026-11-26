import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isArtifactFileName } from './exports.js'

/** 通用受保护产物路由：目前服务导出文件，#109（PDF 原文件）与 #110（媒体代理）可复用同一套校验。 */
export const EXPORT_ROUTE_PATH = '/reader/exports'
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
  let pathname = ''
  try {
    pathname = new URL(request.url).pathname
  } catch {
    return ''
  }
  if (pathname !== routePath && !pathname.startsWith(`${routePath}/`)) return ''
  const rest = pathname.slice(routePath.length + 1)
  if (!rest || rest.includes('/')) return ''
  let jobId = ''
  try {
    jobId = decodeURIComponent(rest)
  } catch {
    return ''
  }
  return /^[0-9a-zA-Z][0-9a-zA-Z-]{7,63}$/.test(jobId) ? jobId : ''
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
export function attachmentHeader(fileName: string): string {
  const safe = String(fileName || 'download')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["\\]/g, '_')
    .trim() || 'download'
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

function refuse(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...extra } })
}

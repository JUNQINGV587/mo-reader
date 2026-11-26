import { createRequire } from 'node:module'
import { dirname, extname } from 'node:path'
import {
  createProtectedFileRoute,
  registerProtectedFileRoute,
  type ArtifactRoute,
  type ArtifactWebServer,
  type FileArtifactDescriptor,
  type ProtectedFileRouteOptions,
} from './routes.js'
import { PDFJS_ASSET_ROUTE_PATH, type PdfjsAssetKind } from '../core/pdfjs-assets.js'

/** pdfjs 资源随依赖版本变化，URL 不带版本，缓存只放宽到一天，升级后最多留一天旧文件。 */
export const PDFJS_ASSET_CACHE_CONTROL = 'private, max-age=86400'

/** 资源种类就是 PDF 入口字面量：只允许 pdfjs 自己会请求的三类目录。 */
const ASSET_KIND_PATTERN = /^(cmaps|standard_fonts|wasm)$/

const CONTENT_TYPES: Record<string, string> = {
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/x-font-type1',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

/** 已安装的 pdfjs-dist 根目录：资源随依赖一起发布，不走网络也不进客户端包。 */
export function pdfjsAssetRoot(): string {
  const require = createRequire(import.meta.url)
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

export interface PdfjsAssetRouteOptions {
  /** 路由前缀，默认 /reader/pdfjs。 */
  path?: string
  /** 资源根目录；每次取用时求值，便于测试指向临时目录。 */
  root?: () => string
}

function contentTypeOf(fileName: string): string {
  return CONTENT_TYPES[extname(fileName).toLowerCase()] ?? 'application/octet-stream'
}

function protectedOptions(options: PdfjsAssetRouteOptions, root: () => string): ProtectedFileRouteOptions {
  return {
    path: options.path ?? PDFJS_ASSET_ROUTE_PATH,
    auth: 'required',
    root,
    cacheControl: PDFJS_ASSET_CACHE_CONTROL,
    // 文件名是第二段：pdfjs 按 <kind>/<file> 拼地址，不存在单段资源。
    allowName: true,
    idPattern: ASSET_KIND_PATTERN,
    locate(kind, name): FileArtifactDescriptor | null {
      if (!name) return null
      return {
        filePath: `${kind as PdfjsAssetKind}/${name}`,
        fileName: name,
        contentType: contentTypeOf(name),
        disposition: 'inline',
      }
    },
  }
}

/** 资源路由：#117 的 cmaps / standard_fonts 走这里，鉴权与文件服务复用受保护文件路由。 */
export function createPdfjsAssetRoute(options: PdfjsAssetRouteOptions = {}): ArtifactRoute {
  return createProtectedFileRoute(protectedOptions(options, options.root ?? pdfjsAssetRoot))
}

/** 注册资源路由并返回释放函数；根目录在注册时就解析，依赖缺失直接失败而不是每个请求 500。 */
export function registerPdfjsAssetRoute(
  webServer: ArtifactWebServer,
  options: PdfjsAssetRouteOptions = {},
): () => void {
  const root = options.root ?? pdfjsAssetRoot
  const resolved = root()
  return registerProtectedFileRoute(webServer, protectedOptions(options, () => resolved))
}

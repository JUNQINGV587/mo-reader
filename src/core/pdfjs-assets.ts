/** pdfjs 资源路由：宿主服务端从已安装的 pdfjs-dist 提供，客户端与导入路径共用同一套文件。 */
export const PDFJS_ASSET_ROUTE_PATH = '/reader/pdfjs'

/** pdfjs 需要的三类资源目录，与 pdfjs-dist 包内目录同名。 */
export const PDFJS_ASSET_KINDS = ['cmaps', 'standard_fonts', 'wasm'] as const

export type PdfjsAssetKind = (typeof PDFJS_ASSET_KINDS)[number]

/** 资源目录地址，末尾斜杠是 pdfjs 拼文件名的前提（缺了会直接抛 Invalid factory url）。 */
export function pdfjsAssetUrl(kind: PdfjsAssetKind): string {
  return `${PDFJS_ASSET_ROUTE_PATH}/${kind}/`
}

export interface PdfjsDocumentOptions {
  url: string
  cMapUrl: string
  cMapPacked: true
  standardFontDataUrl: string
  wasmUrl: string
  /**
   * 必须由主线程取资源：网页里的 PDF worker 是内联 data: URL，worker 内的相对地址解析不出
   * 具体地址（fetch 会抛 Failed to parse URL），cmaps 会静默退化成缺字形。
   */
  useWorkerFetch: false
}

/** 原版阅读的 pdfjs 初始化参数：文档地址原样传，三类资源指向本机路由目录。 */
export function pdfjsDocumentOptions(src: string): PdfjsDocumentOptions {
  return {
    url: src,
    cMapUrl: pdfjsAssetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: pdfjsAssetUrl('standard_fonts'),
    wasmUrl: pdfjsAssetUrl('wasm'),
    useWorkerFetch: false,
  }
}

/**
 * 媒体响应完整性（#121）：下载时能证明「这份字节就是完整表示」的信号只有两类：
 * 1. 响应不是部分内容（未请求 Range 却收到 206，说明服务器只给了半份，不能当完整文件）；
 * 2. 响应声明的 Content-Length 与实际落盘字节一致（有 Content-Encoding 时长度是编码后的，跳过）。
 * 解密后的 HLS 分片长度与密文 Content-Length 不同，按明文落盘后不参与这个比对；
 * 发布前再用索引记录的大小逐文件 stat 复核，见 media-cache.ts。
 */

/** 解析 Content-Length；缺失或非法按「未知」处理，不阻断下载。 */
export function responseContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return null
  return value
}

/**
 * 下载器没有发 Range，任何 206 都只是资源的一部分。
 * 先取消响应体再拒绝，避免把半份表示写进索引后反复播放失败。
 */
export async function assertCompleteMediaResponse(
  response: Response,
  what = '媒体文件',
): Promise<void> {
  if (response.status !== 206) return
  try {
    await response.body?.cancel()
  } catch {
    // 取消失败不影响报错。
  }
  throw new Error(`${what}只返回了部分内容（HTTP 206），无法确认完整`)
}

export interface WrittenLengthOptions {
  /** 解密后的明文长度与传输层密文长度不同，不比对 Content-Length。 */
  decrypted?: boolean
  what?: string
}

/** 下载完成后核对声明的长度；未知长度、压缩传输、解密分片都不误判。 */
export function assertWrittenLength(
  response: Response,
  bytes: number,
  options: WrittenLengthOptions = {},
): void {
  if (options.decrypted) return
  const encoding = (response.headers.get('content-encoding') ?? '').trim().toLowerCase()
  if (encoding && encoding !== 'identity') return
  const expected = responseContentLength(response)
  if (expected === null) return
  if (expected !== bytes) {
    throw new Error(
      `${options.what ?? '媒体文件'}长度校验失败：响应声明 ${expected} 字节，实际写入 ${bytes} 字节`,
    )
  }
}

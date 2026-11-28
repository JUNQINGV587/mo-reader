/**
 * 把浏览器/宿主传输层的裸错误换成用户能照着处理的一句话。
 * 只做展示映射，不改变调用成败；服务端给的中文文案原样保留。
 */
// 宿主可能把裸错误包进自己的前缀（如「client api: reader/getToc failed: Failed to fetch」）。
const TRANSPORT_ERROR =
  /(?:typeerror:\s*)?(failed to fetch|fetch failed|load failed|networkerror\b|network request failed|econnrefused|enotfound|enetunreach)/i

export const NETWORK_ERROR_TEXT = '网络连接失败，请检查网络后重试'

export function isTransportError(message: string): boolean {
  return TRANSPORT_ERROR.test(String(message ?? ''))
}

/** 传输层失败换成固定文案；其他错误（含服务端中文）原样返回。 */
export function readableNetworkError(message: string, fallback: string = NETWORK_ERROR_TEXT): string {
  const text = String(message ?? '').trim()
  if (!text) return fallback
  return isTransportError(text) ? fallback : text
}
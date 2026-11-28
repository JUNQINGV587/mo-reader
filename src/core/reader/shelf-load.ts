/**
 * 书架加载失败时的人话原因：服务端/宿主已给的文案原样保留，
 * 只把浏览器与传输层的裸错误换成用户能照着处理的一句。
 */
// 允许宿主把裸错误包进自己的前缀（如「Remote 调用失败：Failed to fetch」）。
const TRANSPORT_ERROR = /(?:typeerror:\s*)?(failed to fetch|fetch failed|load failed|networkerror\b|network request failed)/i

export function shelfLoadErrorMessage(reason: string): string {
  const text = String(reason ?? '').trim()
  if (!text) return '书架加载失败，请稍后重试'
  if (TRANSPORT_ERROR.test(text)) return '网络连接失败，请检查网络后重试'
  if (/^Remote 未就绪[：:]/.test(text)) return '插件尚未就绪，请稍后重试'
  if (text === '[object Object]') return '书架加载失败，请稍后重试'
  return text
}

/** 只有「确实没有书，也没加载失败」才算空书架；失败时不能再引导去导入书源。 */
export function shelfShowsEmpty(bookCount: number, error: string): boolean {
  return !error && bookCount <= 0
}

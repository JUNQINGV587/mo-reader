import { ReaderError } from './errors.js'
import { fetchRemote, parseRemoteUrl } from './http.js'

// 抽址只做一次快速探测，用户不该为一条失效的线路等满网络超时。
export const MEDIA_PROBE_TIMEOUT_MS = 8000
export const MAX_MEDIA_CANDIDATES = 5
const PROBE_MAX_BYTES = 64 * 1024
const MEDIA_EXTENSION = /\.(?:m3u8|mp4)(?:[?#]|$)/i

function unescapeMarkup(value) {
  return String(value ?? '')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/g, '&')
}

function collectTagSources(html) {
  const values = []
  const pattern = /<(?:video|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
  let match
  while ((match = pattern.exec(html))) values.push({ value: match[1] ?? match[2] ?? match[3], at: match.index })
  return values
}

function collectLiteralSources(html) {
  const values = []
  const absolute = /(?:https?:)?\/\/[^\s"'<>()\\]+/gi
  const relative = /(["'])((?:\/|\.\/)[^"'\s<>]+)\1/g
  let match
  while ((match = absolute.exec(html))) values.push({ value: match[0], at: match.index })
  while ((match = relative.exec(html))) values.push({ value: match[2], at: match.index })
  return values
}

// 一段正文里可能既有 <video src>，也有脚本里的 m3u8 字面量；
// 按出现位置排序后去重，保证「第一个可用」就是页面里排在前面的那条线路。
export function extractMediaCandidates(html, baseUrl, { limit = MAX_MEDIA_CANDIDATES, allowHttp = false } = {}) {
  if (typeof html !== 'string' || !html) return []
  const text = unescapeMarkup(html)
  const hits = [...collectTagSources(text), ...collectLiteralSources(text)].sort((left, right) => left.at - right.at)
  const seen = new Set()
  const values = []
  for (const hit of hits) {
    const raw = String(hit.value ?? '').trim()
    if (!raw || !MEDIA_EXTENSION.test(raw)) continue
    let href
    try { href = new URL(raw, baseUrl).href } catch { continue }
    try { parseRemoteUrl(href, { allowHttp }) } catch { continue }
    if (seen.has(href)) continue
    seen.add(href)
    values.push(href)
    if (values.length >= limit) break
  }
  return values
}

function playableResponse(response) {
  const status = Number(response?.status ?? 200)
  if (!(status >= 200 && status < 300)) return false
  const type = String(response?.headers?.['content-type'] ?? '').toLowerCase()
  // 有些站点对失效地址返回 200 的 HTML 错误页，不能把它当成可播地址。
  return !type.startsWith('text/html')
}

function remainingMs(options) {
  const timeout = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : MEDIA_PROBE_TIMEOUT_MS
  if (!options.deadline) return timeout
  return Math.max(0, Number(options.deadline) - Date.now())
}

function withTimeout(promise, ms) {
  if (!(ms > 0)) return Promise.reject(new Error('probe budget exhausted'))
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('probe timeout')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function attempt(fetch, url, options, method, range) {
  try {
    const timeoutMs = remainingMs(options)
    const response = await withTimeout(fetch(url, {
      method,
      headers: { ...(options.headers ?? {}), ...(range ? { range: 'bytes=0-0' } : {}) },
      timeoutMs,
      maxBytes: PROBE_MAX_BYTES,
      allowHttp: options.allowHttp === true,
      // 只关心状态码与 content-type；服务端忽略 Range 返回整个文件时也不读取正文。
      readBody: false,
    }), timeoutMs)
    return playableResponse(response)
  } catch {
    return false
  }
}

export async function probeMediaUrl(url, options = {}) {
  const fetch = options.fetch ?? fetchRemote
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : MEDIA_PROBE_TIMEOUT_MS
  const settings = { ...options, fetch, timeoutMs }
  // HEAD 最省流量；有些站点拒绝 HEAD，再用 1 字节 Range 的 GET 复核一次。
  if (await attempt(fetch, url, settings, 'HEAD', false)) return url
  if (await attempt(fetch, url, settings, 'GET', true)) return url
  return null
}

export async function firstPlayableMedia(candidates, options = {}) {
  // 5 条候选不能各等 8 秒；给整条条目一个总预算，超时就明确报失效。
  const budget = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : MEDIA_PROBE_TIMEOUT_MS
  const deadline = Date.now() + budget
  for (const url of candidates) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    if (await probeMediaUrl(url, { ...options, deadline, timeoutMs: Math.min(budget, remaining) })) return url
  }
  throw new ReaderError('reader/media-unavailable', '媒体地址失效：' + candidates.length + ' 个候选地址都不可用，请稍后重试。', { candidates })
}

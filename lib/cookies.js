// Cookie 只按 host-only 保存：Domain 属性一律忽略，避免一个源把 Cookie
// 发给同一站点下的其他源或跨站重定向目标。上限与浏览器常见的每域限制接近。
export const MAX_COOKIES = 200
export const MAX_COOKIE_VALUE = 4096
export const MAX_COOKIE_HEADER = 8000
const NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/

function hostname(url) {
  return String(url?.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
}

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function safeName(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && NAME.test(value)
}

function safeValue(value) {
  return typeof value === 'string' && value.length <= MAX_COOKIE_VALUE && VALUE.test(value)
}

function defaultPath(url) {
  const path = url?.pathname || '/'
  return path === '/' || !path.startsWith('/') ? '/' : path.slice(0, path.lastIndexOf('/') + 1) || '/'
}

function normalizedPath(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/')) return fallback
  return value.length > 4096 ? fallback : value
}

function normalizeExpires(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function normalizeRecord(value) {
  if (!value || typeof value !== 'object') return null
  if (!safeName(value.name) || !safeValue(value.value)) return null
  const domain = typeof value.domain === 'string' ? value.domain.trim().toLowerCase() : ''
  if (!domain) return null
  return {
    name: value.name,
    value: value.value,
    domain,
    path: normalizedPath(value.path),
    secure: value.secure === true,
    httpOnly: value.httpOnly === true,
    expires: normalizeExpires(value.expires),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : 0,
  }
}

export function normalizeCookies(value) {
  if (!Array.isArray(value)) return []
  const now = Date.now()
  const seen = new Map()
  for (const raw of value) {
    const cookie = normalizeRecord(raw)
    if (!cookie) continue
    if (cookie.expires !== null && cookie.expires <= now) continue
    const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`
    const previous = seen.get(key)
    if (!previous || cookie.createdAt >= previous.createdAt) seen.set(key, cookie)
  }
  return [...seen.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_COOKIES)
}

function splitPair(value) {
  const text = String(value ?? '').trim()
  const index = text.indexOf('=')
  if (index <= 0) return null
  const name = text.slice(0, index).trim()
  let cookieValue = text.slice(index + 1).trim()
  if (cookieValue.startsWith('"') && cookieValue.endsWith('"') && cookieValue.length >= 2) cookieValue = cookieValue.slice(1, -1)
  return { name, value: cookieValue }
}

// 把导入源里的 Cookie 请求头拆成 jar。这里只接受 name=value，属性（Path 等）
// 来自显式 Set-Cookie，不会因为导入一个静态头而扩大作用域。
export function cookiesFromHeader(value, url) {
  const target = parseUrl(url)
  if (!target) return []
  const now = Date.now()
  const result = new Map()
  for (const part of String(value ?? '').split(';')) {
    const pair = splitPair(part)
    if (!pair || pair.name.startsWith('$') || !safeName(pair.name) || !safeValue(pair.value)) continue
    result.set(pair.name, {
      name: pair.name,
      value: pair.value,
      domain: hostname(target),
      path: '/',
      secure: target.protocol === 'https:',
      httpOnly: false,
      expires: null,
      createdAt: now,
    })
  }
  return [...result.values()]
}

function matchesPath(cookie, path) {
  if (cookie.path === '/' || path === cookie.path) return true
  const prefix = cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`
  return path.startsWith(prefix)
}

export function cookieHeader(cookies, url) {
  const target = parseUrl(url)
  if (!target) return undefined
  const now = Date.now()
  const host = hostname(target)
  const path = target.pathname || '/'
  const pairs = normalizeCookies(cookies)
    .filter(cookie => cookie.domain === host)
    .filter(cookie => cookie.expires === null || cookie.expires > now)
    .filter(cookie => !cookie.secure || target.protocol === 'https:')
    .filter(cookie => matchesPath(cookie, path))
    .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt)
    .map(cookie => `${cookie.name}=${cookie.value}`)
  let header = ''
  for (const pair of pairs) {
    const next = header ? `${header}; ${pair}` : pair
    if (next.length > MAX_COOKIE_HEADER) break
    header = next
  }
  return header || undefined
}

function parseSetCookie(line, url) {
  const text = String(line ?? '').trim()
  const first = text.split(';')[0]
  const pair = splitPair(first)
  if (!pair || !safeName(pair.name)) return null
  if (!safeValue(pair.value)) return null
  const attributes = new Map()
  for (const part of text.split(';').slice(1)) {
    const index = part.indexOf('=')
    if (index < 0) attributes.set(part.trim().toLowerCase(), '')
    else attributes.set(part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim())
  }
  let expires = null
  let deleted = false
  if (attributes.has('max-age')) {
    const seconds = Number(attributes.get('max-age'))
    if (Number.isFinite(seconds)) {
      if (seconds <= 0) deleted = true
      else expires = Date.now() + seconds * 1000
    }
  }
  if (expires === null && !deleted && attributes.has('expires')) {
    const parsed = Date.parse(attributes.get('expires'))
    if (Number.isFinite(parsed)) {
      if (parsed <= Date.now()) deleted = true
      else expires = parsed
    }
  }
  return {
    name: pair.name,
    value: deleted ? '' : pair.value,
    domain: hostname(url),
    path: normalizedPath(attributes.get('path'), defaultPath(url)),
    secure: attributes.has('secure'),
    httpOnly: attributes.has('httponly'),
    expires,
    createdAt: Date.now(),
    deleted,
  }
}

export function mergeSetCookies(cookies, setCookieHeaders, url) {
  const target = parseUrl(url)
  if (!target) return normalizeCookies(cookies)
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : (typeof setCookieHeaders === 'string' ? [setCookieHeaders] : [])
  const jar = normalizeCookies(cookies)
  for (const line of headers) {
    const cookie = parseSetCookie(line, target)
    if (!cookie) continue
    const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`
    const index = jar.findIndex(item => `${item.domain}\n${item.path}\n${item.name}` === key)
    if (cookie.deleted) {
      if (index >= 0) jar.splice(index, 1)
      continue
    }
    if (index >= 0) jar.splice(index, 1, cookie)
    else jar.push(cookie)
  }
  return normalizeCookies(jar)
}


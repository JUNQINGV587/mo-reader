import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import iconv from 'iconv-lite'
import { ReaderError } from './errors.js'

export const HTTP_LIMITS = Object.freeze({ timeoutMs: 12000, maxBytes: 5 * 1024 * 1024, maxRedirects: 3 })
const FORBIDDEN_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'cookie2', 'host', 'content-length', 'connection', 'transfer-encoding'])
const SENSITIVE_QUERY = /^(?:access_?token|api_?key|auth|authorization|cookie|credential|password|passwd|secret|session|token)$/i

export function isPrivateAddress(address) {
  const normalized = address.toLowerCase().split('%')[0]
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
  if (net.isIP(mapped) === 4) {
    const parts = mapped.split('.').map(Number)
    const [a, b] = parts
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 51 || b === 18 || b === 19))
      || (a === 203 && b === 0)
  }
  if (net.isIP(normalized) === 6) {
    // Public global unicast is currently 2000::/3. Refusing every other
    // family also covers mapped/private IPv4, NAT64, link-local and ULA.
    return !/^[23]/.test(normalized)
  }
  return true
}

export function parseRemoteUrl(value, { allowHttp = false } = {}) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ReaderError('reader/invalid-url', 'URL must be an absolute HTTP or HTTPS URL.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp)) {
    throw new ReaderError('reader/insecure-url', 'Only HTTPS is allowed; HTTP requires allowHttp: true.')
  }
  if (url.username || url.password) throw new ReaderError('reader/credentials-forbidden', 'URLs must not contain credentials.')
  if (url.href.length > 4096) throw new ReaderError('reader/invalid-url', 'URL is too long.')
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new ReaderError('reader/ssrf-blocked', 'Local and private network addresses are blocked.')
  }
  if (net.isIP(hostname) && isPrivateAddress(hostname)) {
    throw new ReaderError('reader/ssrf-blocked', 'Local and private network addresses are blocked.')
  }
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY.test(key)) throw new ReaderError('reader/credentials-forbidden', 'URLs must not contain credential query parameters.')
  }
  return url
}

export function cleanHeaders(headers = {}) {
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    throw new ReaderError('reader/invalid-source', 'headers must be an object.')
  }
  const result = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 ModuReader/1.0', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.1', 'accept-encoding': 'identity' }
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (FORBIDDEN_HEADERS.has(lower) || /(?:^|[-_])(?:auth(?:orization)?|cookie|api[-_]?key|credential|password|secret|session|token)(?:$|[-_])/i.test(lower)) {
      throw new ReaderError('reader/credentials-forbidden', `Header ${name} is not allowed.`)
    }
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || typeof value !== 'string' || /[\r\n]/.test(value) || value.length > 8192) {
      throw new ReaderError('reader/invalid-source', `Invalid HTTP header ${name}.`)
    }
    result[lower] = value
  }
  return result
}

async function resolvePublic(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new ReaderError('reader/ssrf-blocked', 'Private addresses are blocked.')
    return { address: hostname, family: net.isIP(hostname) }
  }
  let records
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new ReaderError('reader/network-error', `Could not resolve ${hostname}.`, undefined, { cause: error })
  }
  if (records.length === 0 || records.some(record => isPrivateAddress(record.address))) {
    throw new ReaderError('reader/ssrf-blocked', 'The destination resolves to a local or private address.')
  }
  // Prefer IPv4: containers often have an IPv6 record but no route, which
  // otherwise turns every request into a 12s timeout.
  return [...records].sort((a, b) => (a.family === 4 ? 0 : 1) - (b.family === 4 ? 0 : 1))
}

function requestOnce(url, options, pinned) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(url, {
      method: options.method,
      headers: options.headers,
      // Node 20+ enables autoSelectFamily, which asks lookup for every address
      // (`options.all`); answering with a bare string then fails with
      // ERR_INVALID_IP_ADDRESS. Answer in the shape the caller asked for.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions && lookupOptions.all) callback(null, Array.isArray(pinned) ? pinned : [pinned])
        else {
          const first = Array.isArray(pinned) ? pinned[0] : pinned
          callback(null, first.address, first.family)
        }
      },
      timeout: options.timeoutMs,
    }, response => {
      const chunks = []
      let size = 0
      const declared = Number(response.headers['content-length'] ?? 0)
      if (declared > options.maxBytes) {
        response.resume()
        reject(new ReaderError('reader/too-large', `Response exceeds ${options.maxBytes} bytes.`))
        return
      }
      response.on('data', chunk => {
        size += chunk.length
        if (size > options.maxBytes) {
          request.destroy(new ReaderError('reader/too-large', `Response exceeds ${options.maxBytes} bytes.`))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, buffer: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.on('timeout', () => request.destroy(new ReaderError('reader/timeout', `Request exceeded ${options.timeoutMs} ms.`)))
    request.on('error', reject)
    if (options.body) request.write(options.body)
    request.end()
  })
}

export async function fetchRemote(value, options = {}) {
  const settings = { ...HTTP_LIMITS, ...options }
  let url = parseRemoteUrl(value, settings)
  const requireAllowedOrigin = (candidate) => {
    if (settings.allowedOrigin && candidate.origin !== settings.allowedOrigin) {
      throw new ReaderError('reader/off-origin', `Request origin ${candidate.origin} is not allowed.`)
    }
  }
  requireAllowedOrigin(url)
  const method = (settings.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new ReaderError('reader/invalid-source', 'Only GET and POST are supported.')
  const headers = cleanHeaders(settings.headers)
  let body
  if (method === 'POST') {
    if (settings.jsonBody) {
      body = Buffer.from(settings.body ?? '')
      headers['content-type'] ??= 'application/json; charset=utf-8'
    } else {
      const form = new URLSearchParams(settings.form ?? settings.body ?? '').toString()
      body = Buffer.from(form)
      headers['content-type'] ??= 'application/x-www-form-urlencoded; charset=utf-8'
    }
    if (body.length > 1024 * 1024) throw new ReaderError('reader/too-large', 'POST body exceeds 1 MiB.')
    headers['content-length'] = String(body.length)
  }
  const resolveAddress = settings.resolvePublic ?? resolvePublic
  const requestRemote = settings.requestOnce ?? requestOnce
  for (let redirect = 0; redirect <= settings.maxRedirects; redirect += 1) {
    const pinned = await resolveAddress(url.hostname.replace(/^\[|\]$/g, ''))
    const response = await requestRemote(url, { ...settings, method, headers, body }, pinned)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw new ReaderError('reader/network-error', `Redirect ${response.status} has no Location header.`)
      if (redirect === settings.maxRedirects) throw new ReaderError('reader/too-many-redirects', 'Too many redirects.')
      url = parseRemoteUrl(new URL(response.headers.location, url).href, settings)
      requireAllowedOrigin(url)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ReaderError('reader/http-error', `Remote server returned HTTP ${response.status}.`, { status: response.status })
    }
    const contentType = String(response.headers['content-type'] ?? '')
    const detected = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
    const charset = (settings.charset ?? detected ?? 'utf-8').toLowerCase()
    if (!iconv.encodingExists(charset)) throw new ReaderError('reader/invalid-source', `Unsupported charset ${charset}.`)
    return { ...response, url: url.href, text: iconv.decode(response.buffer, charset), charset }
  }
  throw new ReaderError('reader/network-error', 'Request failed unexpectedly.')
}

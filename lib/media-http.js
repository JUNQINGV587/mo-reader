import fs from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ReaderError } from './errors.js'
import { parseRangeHeader } from './media-range.js'

const NO_STORE = 'private, no-store'
const SAFE_PREFIXES = ['audio/', 'video/', 'image/']
const SAFE_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
  'application/octet-stream',
  'text/plain',
])

function safeMediaType(value) {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase()
  if (type === 'image/svg+xml') return null
  if (SAFE_PREFIXES.some(prefix => type.startsWith(prefix))) return type
  if (SAFE_TYPES.has(type)) return type
  return null
}

const MEDIA_HEADERS = {
  'accept-ranges': 'bytes',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
}

function errorResponse(error) {
  const status = error?.code === 'reader/range-not-satisfiable'
    ? 416
    : error?.code === 'reader/invalid-range'
      ? 416
      : error?.code === 'reader/media-not-found'
        ? 404
        : error?.code === 'reader/media-forbidden' || error?.code === 'reader/invalid-media'
          ? 400
          : error?.code === 'reader/media-quota'
            ? 507
            : error?.code === 'reader/unsupported-media' || error?.code === 'reader/unsupported-source'
              ? 415
              : error?.code === 'reader/not-found'
                ? 404
                : error?.code === 'reader/media-busy'
                  ? 409
                  : error?.code === 'reader/source-disabled'
                    ? 403
                    : error?.code === 'reader/source-unavailable'
                      ? 410
                      : 502
  const message = status >= 500 ? '媒体请求失败。' : error?.message ?? '媒体请求失败。'
  return new Response(JSON.stringify({ error: error?.code ?? 'reader/media-error', message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': NO_STORE },
  })
}

export async function mediaResponse(store, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': NO_STORE } })
  }
  try {
    const url = new URL(request.url, 'http://reader.local')
    const id = url.searchParams.get('id')
    if (!id) throw new ReaderError('reader/invalid-media', '缺少媒体 id。')
    const record = store.record(id)
    const file = await store.filePath(record)
    const size = file.size
    let range = null
    try {
      range = parseRangeHeader(request.headers.get('range'), size)
    } catch (error) {
      if (error?.code === 'reader/invalid-range' || error?.code === 'reader/range-not-satisfiable') {
        return new Response(JSON.stringify({ error: error.code, message: error.message }), {
          status: 416,
          headers: { ...MEDIA_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-range': `bytes */${size}` },
        })
      }
      throw error
    }
    const start = range?.start ?? 0
    const end = range?.end ?? Math.max(0, size - 1)
    const length = size === 0 ? 0 : end - start + 1
    const declaredType = safeMediaType(record.contentType)
    const contentType = declaredType ?? 'application/octet-stream'
    const headers = {
      ...MEDIA_HEADERS,
      'content-type': contentType,
      'content-length': String(length),
      ...(declaredType ? {} : { 'content-disposition': 'attachment' }),
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    }
    await store.touch(record.id).catch(() => {})
    if (request.method === 'HEAD' || length === 0) {
      return new Response(null, { status: range ? 206 : 200, headers })
    }
    const body = Readable.toWeb(fs.createReadStream(file.path, { start, end }))
    return new Response(body, { status: range ? 206 : 200, headers })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function proxyResponse(service, request) {
  if (request.method !== 'GET') {
    return new Response(null, { status: 405, headers: { allow: 'GET', 'cache-control': NO_STORE } })
  }
  try {
    const url = new URL(request.url, 'http://reader.local')
    const bookId = url.searchParams.get('bookId')
    const chapterId = url.searchParams.get('chapterId')
    if (!bookId || !chapterId) throw new ReaderError('reader/invalid-media', '缺少 bookId 或 chapterId。')
    const book = service.book(bookId)
    if (book.contentType !== 'audio' && book.contentType !== 'video') {
      throw new ReaderError('reader/media-forbidden', '只有音频或视频章节可以走媒体代理。')
    }
    const chapter = await service.chapter({ bookId, chapterId })
    if (!chapter.mediaUrl) throw new ReaderError('reader/media-not-found', '章节没有可播放的媒体地址。')
    const source = service.source(book.sourceId)
    const headers = { ...(chapter.headers ?? {}), 'accept-encoding': 'identity' }
    const incomingRange = request.headers.get('range')
    if (incomingRange) headers.range = incomingRange
    const remote = await service.fetchRemote(chapter.mediaUrl, {
      method: 'GET',
      headers,
      allowHttp: source.allowHttp === true,
      maxBytes: 64 * 1024 * 1024,
      timeoutMs: 30000,
      maxRedirects: 3,
    })
    const contentType = safeMediaType(remote.headers['content-type'])
    if (!contentType) throw new ReaderError('reader/unsupported-media', '远端媒体类型不能在同源页面中播放。')
    const responseHeaders = {
      'content-type': contentType,
      'cache-control': NO_STORE,
      'accept-ranges': remote.headers['accept-ranges'] ?? 'bytes',
      'x-content-type-options': 'nosniff',
    }
    if (remote.headers['content-range']) responseHeaders['content-range'] = remote.headers['content-range']
    if (remote.headers['content-length']) responseHeaders['content-length'] = remote.headers['content-length']
    return new Response(remote.buffer, { status: remote.status, headers: responseHeaders })
  } catch (error) {
    if (error?.code === 'reader/http-error' && error?.status === 416) {
      return new Response(null, { status: 416, headers: { 'cache-control': NO_STORE } })
    }
    return errorResponse(error)
  }
}


export async function sendWebResponse(response, res) {
  res.statusCode = response.status
  response.headers.forEach((value, key) => res.setHeader(key, value))
  if (!response.body) {
    res.end()
    return
  }
  await pipeline(Readable.fromWeb(response.body), res)
}

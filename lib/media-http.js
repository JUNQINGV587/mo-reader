import fs from 'node:fs'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ReaderError } from './errors.js'
import { parseRangeHeader } from './media-range.js'
import { stableId } from './utils.js'

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
                      : error?.code === 'reader/auth-required'
                        ? 401
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


// Process-local key: playlists issued before a restart fail closed and are reissued on reload.
const HLS_SECRET = crypto.randomBytes(32)
const PART_TTL = 12 * 60 * 60 * 1000

function sealPart(bookId, chapterId, url, exp) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', HLS_SECRET, iv)
  cipher.setAAD(Buffer.from(`${exp}\n${bookId}\n${chapterId}`))
  const body = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, body]).toString('base64url')
}

function signPart(bookId, chapterId, url) {
  const exp = Date.now() + PART_TTL
  const part = sealPart(bookId, chapterId, url, exp)
  return `/api/reader/proxy?bookId=${encodeURIComponent(bookId)}&chapterId=${encodeURIComponent(chapterId)}&part=${part}&exp=${exp}`
}

function verifyPart(bookId, chapterId, part, exp) {
  if (!part || !exp || Number(exp) < Date.now()) return null
  try {
    const raw = Buffer.from(part, 'base64url')
    if (raw.length <= 28) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(12, 28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', HLS_SECRET, iv)
    decipher.setAAD(Buffer.from(`${exp}\n${bookId}\n${chapterId}`))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

function rewritePlaylist(text, baseUrl, bookId, chapterId) {
  const rewrite = (value) => {
    try {
      const url = new URL(value, baseUrl)
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return value
      return signPart(bookId, chapterId, url.href)
    } catch { return value }
  }
  return text.split(/\r?\n/).map((line) => {
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${rewrite(uri)}"`)
    const value = line.trim()
    return value ? rewrite(value) : line
  }).join('\n')
}

function playlistType(type) {
  return /mpegurl|x-mpegurl/i.test(String(type ?? ''))
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
    const chapter = service.db.chapters.get(chapterId)
    if (!chapter || chapter.bookId !== bookId) throw new ReaderError('reader/not-found', '章节不存在。')
    const imageIndex = url.searchParams.get('image')
    const blockIndex = url.searchParams.get('block')
    const isBlockImage = blockIndex !== null
    const isImage = imageIndex !== null || isBlockImage
    if (imageIndex !== null && isBlockImage) throw new ReaderError('reader/invalid-media', '图片参数只能指定一种。')
    let imageTarget = ''
    let imageAsset = ''
    if (imageIndex !== null) {
      if (book.contentType !== 'comic') throw new ReaderError('reader/media-forbidden', '只有漫画章节可以走图片代理。')
      if (!/^\d+$/.test(imageIndex) || !Array.isArray(chapter.images) || !chapter.images[Number(imageIndex)]) {
        throw new ReaderError('reader/media-not-found', '漫画图片不存在。')
      }
      imageTarget = chapter.images[Number(imageIndex)]
      imageAsset = `image-${Number(imageIndex)}`
    } else if (isBlockImage) {
      if (book.contentType !== 'subscription') throw new ReaderError('reader/media-forbidden', '只有订阅条目可以走图文图片代理。')
      if (!/^\d+$/.test(blockIndex)) throw new ReaderError('reader/media-not-found', '订阅图片不存在。')
      const block = Array.isArray(chapter.blocks) ? chapter.blocks[Number(blockIndex)] : null
      if (!block || block.type !== 'image' || typeof block.url !== 'string' || !block.url) {
        throw new ReaderError('reader/media-not-found', '订阅图片不存在。')
      }
      imageTarget = block.url
      imageAsset = `block-image-${stableId('image', imageTarget).slice(0, 12)}`
    } else if (book.contentType !== 'audio' && book.contentType !== 'video') {
      throw new ReaderError('reader/media-forbidden', '只有音频或视频章节可以走媒体代理。')
    }
    if (!isImage && !chapter.mediaUrl) throw new ReaderError('reader/media-not-found', '章节没有可播放的媒体地址。')
    const source = service.source(book.sourceId)
    if (isBlockImage && service.media) {
      const cached = service.media.findAsset({ sourceId: source.id, bookId, chapterId, asset: imageAsset })
      if (cached?.status === 'ready') {
        const local = await mediaResponse(service.media, new Request(`http://reader.local/api/reader/media?id=${encodeURIComponent(cached.id)}`))
        if (local.ok) {
          const headers = new Headers(local.headers)
          headers.set('cache-control', 'private, max-age=86400')
          return new Response(local.body, { status: local.status, headers })
        }
      }
    }
    const headers = { ...(service.streamHeaders?.get(chapterId) ?? {}), 'accept-encoding': 'identity' }
    const incomingRange = request.headers.get('range')
    if (incomingRange && !isImage) headers.range = incomingRange
    const part = url.searchParams.get('part')
    const signed = part ? verifyPart(bookId, chapterId, part, url.searchParams.get('exp')) : null
    if (part && !signed) throw new ReaderError('reader/media-forbidden', '媒体分片地址已失效。')
    const target = isImage ? imageTarget : signed || chapter.mediaUrl
    const remote = await service.fetchRemote(target, {
      method: 'GET',
      headers,
      allowHttp: source.allowHttp === true,
      maxBytes: isImage ? 32 * 1024 * 1024 : 64 * 1024 * 1024,
      timeoutMs: 30000,
      maxRedirects: 3,
    })
    const declaredType = String(remote.headers['content-type'] ?? '')
    if (isBlockImage && !safeMediaType(declaredType)?.startsWith('image/')) {
      throw new ReaderError('reader/unsupported-media', '远端内容不是图片。')
    }
    if (!isBlockImage && (playlistType(declaredType) || /\.m3u8(?:[?#]|$)/i.test(target))) {
      if (/SAMPLE-AES|WIDEVINE|PLAYREADY|FAIRPLAY/i.test(remote.text)) {
        throw new ReaderError('reader/unsupported-media', '该媒体使用 SAMPLE-AES 或 DRM 加密，暂不支持在线播放。')
      }
      const rewritten = rewritePlaylist(remote.text, remote.url || target, bookId, chapterId)
      return new Response(rewritten, {
        status: 200,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'cache-control': NO_STORE,
          'x-content-type-options': 'nosniff',
        },
      })
    }
    const contentType = safeMediaType(declaredType)
    if (!contentType) throw new ReaderError('reader/unsupported-media', '远端媒体类型不能在同源页面中播放。')
    if (isBlockImage && service.media && remote.buffer) {
      await service.media.put({
        sourceId: source.id,
        bookId,
        chapterId,
        asset: imageAsset,
        title: chapter.title,
        contentType,
        data: remote.buffer,
      }).catch(() => {})
    }
    const responseHeaders = {
      'content-type': contentType,
      'cache-control': isBlockImage ? 'private, max-age=86400' : NO_STORE,
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

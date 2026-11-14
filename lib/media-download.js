import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { ReaderError } from './errors.js'
import { isMediaPayloadType } from './content-types.js'
import { parseHlsPlaylist, decryptHlsSegment } from './hls.js'

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl'
const SEGMENT_TYPE = 'video/mp2t'
const MAX_MEDIA_BYTES = 256 * 1024 * 1024

function mediaPath(id) {
  return `/api/reader/media?id=${encodeURIComponent(id)}`
}

async function request(fetchRemote, url, { headers = {}, allowHttp = false, maxBytes = MAX_MEDIA_BYTES } = {}) {
  const response = await fetchRemote(url, { headers, allowHttp, maxBytes, timeoutMs: 60_000 })
  if (!response || response.buffer === undefined) {
    throw new ReaderError('reader/media-download', '媒体响应缺少内容。')
  }
  return response
}

function bufferOf(response) {
  return Buffer.isBuffer(response.buffer) ? response.buffer : Buffer.from(response.buffer)
}

function typeOf(response, fallback) {
  return String(response.headers?.['content-type'] ?? fallback).split(';')[0].trim() || fallback
}

async function existingAsset(store, book, chapter, asset) {
  return store.findAsset({ sourceId: book.sourceId, bookId: book.id, chapterId: chapter.id, asset })
}

async function putAsset(store, book, chapter, asset, data, contentType, title) {
  const ready = await existingAsset(store, book, chapter, asset)
  if (ready?.status === 'ready') return ready
  return store.put({
    bookId: book.id,
    chapterId: chapter.id,
    sourceId: book.sourceId,
    asset,
    title,
    contentType,
    data,
  })
}

export function isHlsUrl(value) {
  try { return /\.m3u8$/i.test(new URL(value).pathname) } catch { return false }
}

export async function downloadComicChapter({ store, book, chapter, payload, fetchRemote, isRunning = async () => true, allowHttp = false }) {
  const images = Array.isArray(payload.images) ? payload.images : []
  if (!images.length) throw new ReaderError('reader/media-empty', '漫画章节没有图片。', { chapterId: chapter.id })
  const ids = []
  for (let index = 0; index < images.length; index += 1) {
    if (!(await isRunning())) return { paused: true }
    const url = images[index]
    const asset = `image-${String(index).padStart(5, '0')}`
    let record = await existingAsset(store, book, chapter, asset)
    if (!record || record.status !== 'ready') {
      const response = await request(fetchRemote, url, { headers: payload.headers, allowHttp })
      const bytes = bufferOf(response)
      const declared = Number(response.headers?.['content-length'])
      if (Number.isFinite(declared) && declared !== bytes.length) throw new ReaderError('reader/media-download', '漫画图片长度与响应声明不一致。')
      record = await putAsset(store, book, chapter, asset, bytes, typeOf(response, 'image/jpeg'), `${chapter.title} · 图 ${index + 1}`)
    }
    ids.push(record.id)
  }
  return { kind: 'comic', images: ids }
}

async function fetchKey(fetchRemote, url, headers, cache, allowHttp = false) {
  if (cache.has(url)) return cache.get(url)
  const response = await request(fetchRemote, url, { headers, allowHttp, maxBytes: 1024 })
  const key = bufferOf(response)
  if (key.length !== 16) throw new ReaderError('reader/unsupported-media', 'HLS AES-128 密钥长度无效。')
  cache.set(url, key)
  return key
}

function localPlaylist(segments, init) {
  const target = Math.max(1, Math.ceil(Math.max(...segments.map(segment => segment.duration || 1))))
  const lines = ['#EXTM3U', `#EXT-X-VERSION:${init ? 6 : 3}`, '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0']
  if (init) lines.push(`#EXT-X-MAP:URI="${mediaPath(init.id)}"`)
  for (const segment of segments) {
    lines.push(`#EXTINF:${Number(segment.duration || 0).toFixed(3)},`)
    lines.push(mediaPath(segment.id))
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

export async function downloadHlsChapter({ store, book, chapter, payload, fetchRemote, isRunning = async () => true, allowHttp = false }) {
  const headers = payload.headers ?? {}
  let playlistResponse = await request(fetchRemote, payload.mediaUrl, { headers, allowHttp, maxBytes: 2 * 1024 * 1024 })
  let playlist = parseHlsPlaylist(playlistResponse.text ?? bufferOf(playlistResponse).toString('utf8'), payload.mediaUrl)
  if (playlist.type === 'master') {
    let mediaPlaylist = null
    let lastError = null
    for (const variant of [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)) {
      try {
        const response = await request(fetchRemote, variant.url, { headers, allowHttp, maxBytes: 2 * 1024 * 1024 })
        const candidate = parseHlsPlaylist(response.text ?? bufferOf(response).toString('utf8'), variant.url)
        if (candidate.type !== 'media') throw new ReaderError('reader/parse-error', 'HLS 码率列表没有媒体分片。')
        mediaPlaylist = candidate
        playlistResponse = response
        break
      } catch (error) {
        lastError = error
      }
    }
    if (!mediaPlaylist) throw new ReaderError('reader/parse-error', 'HLS 码率列表都不可用。', undefined, { cause: lastError })
    playlist = mediaPlaylist
  }
  if (playlist.type !== 'media') throw new ReaderError('reader/parse-error', 'HLS 播放列表没有分片。')
  const keys = new Map()
  const variantKey = createHash('sha1').update(playlistResponse.url ?? payload.mediaUrl).digest('hex').slice(0, 8)
  let init = null
  if (playlist.segments[0]?.map) {
    const map = playlist.segments[0].map
    let record = await existingAsset(store, book, chapter, `init-${variantKey}`)
    if (!record || record.status !== 'ready') {
      if (!(await isRunning())) return { paused: true }
      let response = await request(fetchRemote, map.uri, { headers, allowHttp })
      let data = bufferOf(response)
      if (map.key) data = decryptHlsSegment(data, await fetchKey(fetchRemote, map.key.uri, headers, keys, allowHttp), map.key.iv, playlist.segments[0].sequence)
      const fallbackType = book.contentType === 'audio' ? 'audio/mp4' : 'video/mp4'
      const initType = (() => { const type = typeOf(response, fallbackType); return /^(video|audio)\/(mp4|iso\.segment)$/i.test(type) ? type : fallbackType })()
      record = await putAsset(store, book, chapter, `init-${variantKey}`, data, initType, `${chapter.title} · init`)
    }
    init = { id: record.id }
  }
  const segments = []
  for (let index = 0; index < playlist.segments.length; index += 1) {
    if (!(await isRunning())) return { paused: true }
    const segment = playlist.segments[index]
    const asset = `segment-${variantKey}-${String(index).padStart(5, '0')}`
    let record = await existingAsset(store, book, chapter, asset)
    if (!record || record.status !== 'ready') {
      const response = await request(fetchRemote, segment.url, { headers, allowHttp })
      let data = bufferOf(response)
      if (segment.key) data = decryptHlsSegment(data, await fetchKey(fetchRemote, segment.key.uri, headers, keys, allowHttp), segment.key.iv, segment.sequence)
      const fallbackType = init ? (book.contentType === 'audio' ? 'audio/mp4' : 'video/mp4') : SEGMENT_TYPE
      const rawType = typeOf(response, fallbackType)
      const segmentType = /^(video|audio)\/(mp4|iso\.segment|mp2t)$/i.test(rawType) ? rawType : fallbackType
      record = await putAsset(store, book, chapter, asset, data, segmentType, `${chapter.title} · 分片 ${index + 1}`)
    }
    segments.push({ id: record.id, duration: segment.duration })
    if (!(await isRunning())) return { paused: true }
  }
  if (!segments.length) throw new ReaderError('reader/media-empty', 'HLS 没有可下载分片。')
  if (!(await isRunning())) return { paused: true }
  const text = Buffer.from(localPlaylist(segments, init))
  const playlistRecord = await putAsset(store, book, chapter, 'playlist', text, PLAYLIST_TYPE, `${chapter.title} · 离线播放列表`)
  return { kind: 'hls', playlistId: playlistRecord.id, segments: segments.map(segment => segment.id), ...(init ? { initId: init.id } : {}) }
}

export async function downloadDirectChapter({ store, book, chapter, payload, fetchRemote, isRunning = async () => true, allowHttp = false }) {
  if (!(await isRunning())) return { paused: true }
  const probe = await request(fetchRemote, payload.mediaUrl, {
    headers: { ...(payload.headers ?? {}), Range: 'bytes=0-0' }, allowHttp,
  })
  if (!(await isRunning())) return { paused: true }
  const probeBytes = bufferOf(probe)
  const contentType = typeOf(probe, 'application/octet-stream')
  const contentRange = String(probe.headers?.['content-range'] ?? '')
  const range = /^bytes 0-0\/(\d+)$/i.exec(contentRange)
  if (probe.status !== 206) {
    const declared = Number(probe.headers?.['content-length'])
    if (Number.isFinite(declared) && declared !== probeBytes.length) throw new ReaderError('reader/media-download', '媒体内容长度与响应声明不一致。')
    const record = await putAsset(store, book, chapter, 'media', probeBytes, contentType, chapter.title)
    return { kind: 'file', mediaId: record.id }
  }
  if (!range) throw new ReaderError('reader/media-download', '媒体服务器返回的 Range 响应无效。')
  const total = Number(range[1])
  if (!Number.isSafeInteger(total) || total <= 0) throw new ReaderError('reader/media-download', '媒体文件长度无效。')
  const reservation = await store.reserveFile({
    bookId: book.id,
    chapterId: chapter.id,
    sourceId: book.sourceId,
    asset: 'media',
    title: chapter.title,
    contentType,
    size: total,
  })
  if (reservation.ready) return { kind: 'file', mediaId: reservation.record.id }
  const part = reservation.path
  let offset = 0
  if (reservation.resumed) {
    offset = await fs.stat(part).then(info => info.size).catch(error => {
      if (error?.code === 'ENOENT') return 0
      throw error
    })
  } else {
    await fs.rm(part, { force: true })
  }
  if (offset > total) throw new ReaderError('reader/media-download', '媒体临时文件长度超过目标文件。')
  if (offset === 0 && probeBytes.length === 1 && total >= 1) {
    await fs.writeFile(part, probeBytes)
    offset = 1
  }
  const chunkSize = 8 * 1024 * 1024
  while (offset < total) {
    if (!(await isRunning())) return { paused: true }
    const end = Math.min(total - 1, offset + chunkSize - 1)
    const response = await request(fetchRemote, payload.mediaUrl, {
      headers: { ...(payload.headers ?? {}), Range: `bytes=${offset}-${end}` },
      allowHttp,
      maxBytes: end - offset + 1,
    })
    if (response.status !== 206) throw new ReaderError('reader/media-download', '媒体服务器不支持断点下载。')
    const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(String(response.headers?.['content-range'] ?? ''))
    if (!rangeMatch || Number(rangeMatch[1]) !== offset || Number(rangeMatch[3]) !== total) {
      throw new ReaderError('reader/media-download', '媒体服务器返回了不一致的 Range。')
    }
    const bytes = bufferOf(response)
    if (!bytes.length || bytes.length !== end - offset + 1) throw new ReaderError('reader/media-download', '媒体分块长度不一致。')
    await fs.appendFile(part, bytes)
    offset += bytes.length
    if (!(await isRunning())) return { paused: true }
  }
  const record = await store.commitPartial(reservation.record.id)
  return { kind: 'file', mediaId: record.id }
}

export async function downloadMediaChapter({ store, book, chapter, payload, fetchRemote, isRunning, allowHttp }) {
  const type = book.contentType
  if (type === 'comic') return downloadComicChapter({ store, book, chapter, payload, fetchRemote, isRunning, allowHttp })
  if (isMediaPayloadType(type)) {
    if (!payload?.mediaUrl) throw new ReaderError('reader/media-empty', '媒体章节没有播放地址。', { chapterId: chapter.id })
    return isHlsUrl(payload.mediaUrl)
      ? downloadHlsChapter({ store, book, chapter, payload, fetchRemote, isRunning, allowHttp })
      : downloadDirectChapter({ store, book, chapter, payload, fetchRemote, isRunning, allowHttp })
  }
  throw new ReaderError('reader/unsupported-media', '这个作品类型不支持离线媒体缓存。')
}

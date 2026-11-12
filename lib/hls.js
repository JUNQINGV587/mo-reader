import { createDecipheriv } from 'node:crypto'
import { ReaderError } from './errors.js'

function resolve(base, value) {
  try { return new URL(value, base).href } catch { throw new ReaderError('reader/parse-error', 'HLS 播放列表包含无效地址。') }
}

function attrs(line) {
  const result = {}
  const body = line.slice(line.indexOf(':') + 1)
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let match
  while ((match = pattern.exec(body))) result[match[1]] = match[2].replace(/^"|"$/g, '')
  return result
}

function unsupported(message) {
  throw new ReaderError('reader/unsupported-media', message)
}

function ivBytes(value, sequence) {
  if (value) {
    const hex = value.replace(/^0x/i, '')
    if (!/^[0-9a-f]{32}$/i.test(hex)) unsupported('HLS AES-128 的 IV 无效。')
    return Buffer.from(hex, 'hex')
  }
  const buffer = Buffer.alloc(16)
  buffer.writeBigUInt64BE(BigInt(sequence), 8)
  return buffer
}

export function parseHlsPlaylist(text, baseUrl) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (lines[0] !== '#EXTM3U') throw new ReaderError('reader/parse-error', '不是有效的 HLS 播放列表。')
  if (lines.some(line => /^#EXT-X-SESSION-KEY:.*(?:SAMPLE-AES|WIDEVINE|PLAYREADY|FAIRPLAY)/i.test(line))) unsupported('暂不支持 DRM/SAMPLE-AES 媒体。')
  const variants = []
  let pending = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('#EXT-X-STREAM-INF:')) { pending = attrs(line); continue }
    if (line.startsWith('#')) continue
    if (pending) {
      const bandwidth = Number(pending.BANDWIDTH ?? pending['AVERAGE-BANDWIDTH'] ?? 0)
      variants.push({ url: resolve(baseUrl, line), bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0, attrs: pending })
      pending = null
    }
  }
  if (variants.length) return { type: 'master', variants }
  if (lines.some(line => line.startsWith('#EXT-X-BYTERANGE'))) unsupported('暂不支持 HLS 分片字节范围。')
  if (lines.some(line => /SAMPLE-AES|WIDEVINE|PLAYREADY|FAIRPLAY/i.test(line))) unsupported('暂不支持 DRM/SAMPLE-AES 媒体。')
  const segments = []
  let duration = 0
  let sequence = 0
  let key = null
  let map = null
  let ended = false
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]) || 0
    else if (line.startsWith('#EXT-X-KEY:')) {
      const info = attrs(line)
      const method = String(info.METHOD ?? 'NONE').toUpperCase()
      if (method === 'NONE') key = null
      else if (method === 'AES-128') {
        if (info.KEYFORMAT && info.KEYFORMAT.toLowerCase() !== 'identity') unsupported('暂不支持非 identity 的 HLS 密钥格式。')
        if (!info.URI) unsupported('HLS AES-128 缺少密钥地址。')
        key = { method, uri: resolve(baseUrl, info.URI), iv: info.IV }
      } else unsupported(`暂不支持 HLS 加密方式 ${method}。`)
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const info = attrs(line)
      if (!info.URI) throw new ReaderError('reader/parse-error', 'HLS init segment 缺少地址。')
      map = { uri: resolve(baseUrl, info.URI), key }
    } else if (line.startsWith('#EXTINF:')) duration = Number.parseFloat(line.slice(8)) || 0
    else if (line === '#EXT-X-ENDLIST') ended = true
    else if (!line.startsWith('#')) {
      segments.push({ url: resolve(baseUrl, line), duration, sequence: sequence + segments.length, key, map })
      duration = 0
    }
  }
  if (!segments.length) throw new ReaderError('reader/parse-error', 'HLS 播放列表没有分片。')
  if (!ended) unsupported('直播 HLS 不能离线缓存。')
  return { type: 'media', segments, targetDuration: Math.max(...segments.map(segment => segment.duration || 1)) }
}

export function selectHighestVariant(playlist) {
  if (playlist.type !== 'master') return null
  return [...playlist.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null
}

export function decryptHlsSegment(data, key, value, sequence) {
  if (!key) return Buffer.from(data)
  const cipher = createDecipheriv('aes-128-cbc', key, ivBytes(value, sequence))
  try { return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]) }
  catch (error) { throw new ReaderError('reader/media-decrypt', 'HLS 分片解密失败。', undefined, { cause: error }) }
}

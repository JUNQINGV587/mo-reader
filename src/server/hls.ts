/**
 * HLS 离线下载（#113）：把 master/media playlist 解析成「本地 playlist + 解密后的分片」。
 *
 * 设计约束：
 * - 所有 playlist / 分片 / 密钥请求都走调用方注入的流式抓取器（默认 openMediaStream），
 *   由它负责 SSRF 守卫与逐跳重定向复检；这里不直接 fetch。
 * - AES-128 密钥只在内存里用于解密，不落盘、不进索引；本地 playlist 不残留 EXT-X-KEY。
 * - SAMPLE-AES / 非 identity KEYFORMAT 等 DRM 抛 PermanentMediaError，调用方不得重试。
 * - 断点续传只补缺分片：同指纹复用已下完的分片，指纹变化（源 playlist 变了）才整章重下。
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBodyLimited, type MediaStreamOptions, type MediaStreamResult } from '../core/net/http.js'
import { MEDIA_ABORTED_MESSAGE, MEDIA_MAX_FILE_BYTES, mediaRoot, prepareMediaDir, saveMediaStream, writeMediaFile } from './media-cache.js'
import { contentTypeForExt, extFromUrl, PLAYLIST_MAX_BYTES } from './media.js'
import { PermanentMediaError } from './media-download.js'

/** 本地 playlist 在章节目录里的固定文件名：播放地址为 .../<fileId>/index.m3u8。 */
export const HLS_PLAYLIST_NAME = 'index.m3u8'
/** 断点续传清单：记录源 playlist 指纹与已下完的分片，下一次只补缺。 */
export const HLS_PARTIAL_FILE = '.hls-partial.json'
/** DRM 明确失败的统一文案：作业 error 直接展示给用户。 */
export const HLS_DRM_MESSAGE = '该 HLS 使用 DRM 加密（SAMPLE-AES/Widevine），无法离线下载'
/** 播放列表最多嵌套几层（master -> media），防御异常站点构造的递归。 */
const MAX_PLAYLIST_DEPTH = 4
/** 密钥响应上限：标准 AES-128 密钥固定 16 字节。 */
const KEY_MAX_BYTES = 1024
/** 续传清单文件名与分片名共用：只允许单段、非点开头，防止清单被篡改成越界路径。 */
const SAFE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export type HlsStreamOpener = (url: string, options: MediaStreamOptions) => Promise<MediaStreamResult>

export interface HlsVariant {
  bandwidth: number
  uri: string
}

export interface HlsKey {
  method: 'AES-128'
  uri: string
  /** playlist 里显式给了 IV 就用它，否则按分片 media sequence 推导。 */
  iv: Buffer | null
}

export interface HlsMap {
  uri: string
  name: string
}

export interface HlsSegment {
  uri: string
  /** 该分片当前生效的密钥；明文分片为 null。 */
  key: HlsKey | null
  /** EXT-X-MEDIA-SEQUENCE + 分片下标，缺省 IV 用它的 16 字节大端。 */
  sequence: number
  /** 落盘文件名（本地 playlist 里写相对名）。 */
  name: string
  /** 该分片所属的初始化段（fMP4），没有则为 null。 */
  mapName: string | null
}

export interface HlsMediaPlan {
  /** 选中的 media playlist 原文。 */
  text: string
  /** 选中的 media playlist 最终地址（相对地址的解析基准）。 */
  playlistUrl: string
  segments: HlsSegment[]
  maps: HlsMap[]
}

export interface HlsFileResult {
  name: string
  mime: string
  bytes: number
}

export interface HlsDownloadResult {
  files: HlsFileResult[]
  fingerprint: string
}

export interface HlsDownloadOptions {
  playlistUrl: string
  headers?: Record<string, string>
  storeId: string
  signal?: AbortSignal
  opener: HlsStreamOpener
}

interface PlaylistPayload {
  text: string
  url: string
  headers: Record<string, string>
}

interface HlsPartialState {
  version: 1
  fingerprint: string
  done: Record<string, number>
}

function linesOf(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/)
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Za-z0-9-]+)=("[^"]*"|[^,]*)/g
  for (const match of text.matchAll(pattern)) {
    const key = (match[1] ?? '').toUpperCase()
    const raw = match[2] ?? ''
    attributes[key] = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw.trim()
  }
  return attributes
}

function resolveUri(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).toString()
  } catch {
    return uri
  }
}

function tagOf(line: string): string {
  const match = /^(#[A-Za-z0-9-]+)/.exec(line)
  return (match?.[1] ?? '').toUpperCase()
}

/** 带 URI 的属性行（EXT-X-MAP 等）把 URI 改写成新的名字，其余属性原样保留。 */
function rewriteUriAttribute(line: string, rewrite: (uri: string) => string): string {
  return line.replace(/(URI=)("[^"]*"|[^,\s]+)/g, (_all, prefix: string, raw: string) => {
    const uri = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    return `${prefix}"${rewrite(uri)}"`
  })
}

/** 非 identity KEYFORMAT 或非 AES-128/NONE 的方法一律视为 DRM；整个作业必须永久失败。 */
function assertSupportedKey(attributes: Record<string, string>): void {
  const method = (attributes.METHOD ?? '').trim().toUpperCase()
  const keyFormat = (attributes.KEYFORMAT ?? 'identity').trim().toLowerCase()
  const formats = keyFormat.split(',').map((item) => item.trim()).filter(Boolean)
  const drmFormat = formats.some((item) => item !== 'identity')
  if (drmFormat || (method !== '' && method !== 'NONE' && method !== 'AES-128')) {
    throw new PermanentMediaError(HLS_DRM_MESSAGE)
  }
}

function assertMasterHasNoDrm(text: string): void {
  for (const raw of linesOf(text)) {
    const line = raw.trim()
    const tag = tagOf(line)
    if (tag !== '#EXT-X-KEY' && tag !== '#EXT-X-SESSION-KEY') continue
    assertSupportedKey(attributesOf(line.slice(line.indexOf(':') + 1)))
  }
}

export function isMasterPlaylist(text: string): boolean {
  return linesOf(text).some((line) => tagOf(line.trim()) === '#EXT-X-STREAM-INF')
}

/** 解析 master playlist 里的码率变体；相对地址按 master 最终 URL 补全。 */
export function parseMasterPlaylist(text: string, baseUrl: string): HlsVariant[] {
  const lines = linesOf(text).map((line) => line.trim())
  const variants: HlsVariant[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (tagOf(line) !== '#EXT-X-STREAM-INF') continue
    const attributes = attributesOf(line.slice(line.indexOf(':') + 1))
    const bandwidthText = attributes.BANDWIDTH ?? attributes['AVERAGE-BANDWIDTH'] ?? ''
    const bandwidth = Number(bandwidthText)
    let next = index + 1
    while (next < lines.length && (!lines[next] || (lines[next] ?? '').startsWith('#'))) next += 1
    const uri = lines[next] ?? ''
    if (!uri) continue
    variants.push({
      bandwidth: Number.isFinite(bandwidth) ? bandwidth : 0,
      uri: resolveUri(uri, baseUrl),
    })
  }
  return variants
}

/** 选 BANDWIDTH 最高的变体；同码率保留先出现的那个。 */
export function selectHighestVariant(variants: HlsVariant[]): HlsVariant | null {
  let best: HlsVariant | null = null
  for (const variant of variants) {
    if (!best || variant.bandwidth > best.bandwidth) best = variant
  }
  return best
}

function parseIv(value: string | undefined): Buffer | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  const match = /^0x([0-9a-fA-F]{32})$/.exec(text)
  if (!match) throw new Error('HLS 加密 IV 无法识别')
  return Buffer.from(match[1] ?? '', 'hex')
}

/** AES-128 缺省 IV：分片 media sequence 的 16 字节大端表示。 */
function ivForSequence(sequence: number): Buffer {
  const iv = Buffer.alloc(16)
  const value = BigInt(Math.max(0, Math.floor(sequence)))
  for (let index = 0; index < 8; index += 1) {
    iv[15 - index] = Number((value >> BigInt(index * 8)) & 0xffn)
  }
  return iv
}

/** 解析 media playlist：分片按出现顺序编号，密钥/初始化段跟随 EXT-X-KEY/EXT-X-MAP 生效。 */
export function parseMediaPlaylist(text: string, playlistUrl: string): HlsMediaPlan {
  const lines = linesOf(text)
  const segments: HlsSegment[] = []
  const maps: HlsMap[] = []
  const mapByUri = new Map<string, HlsMap>()
  let mediaSequence = 0
  let currentKey: HlsKey | null = null
  let currentMap: HlsMap | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      const tag = tagOf(line)
      const attributes = line.includes(':') ? attributesOf(line.slice(line.indexOf(':') + 1)) : {}
      if (tag === '#EXT-X-MEDIA-SEQUENCE') {
        const value = Number((attributesOf(line.slice(line.indexOf(':') + 1)).VALUE ?? line.slice(line.indexOf(':') + 1)).trim())
        mediaSequence = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
      } else if (tag === '#EXT-X-KEY') {
        assertSupportedKey(attributes)
        const method = (attributes.METHOD ?? '').trim().toUpperCase()
        if (method === 'NONE') {
          currentKey = null
        } else {
          const uri = String(attributes.URI ?? '').trim()
          if (!uri) throw new Error('HLS 加密缺少密钥地址')
          currentKey = { method: 'AES-128', uri: resolveUri(uri, playlistUrl), iv: parseIv(attributes.IV) }
        }
      } else if (tag === '#EXT-X-MAP') {
        if (attributes.BYTERANGE) throw new Error('暂不支持按字节范围切分的 HLS 初始化段')
        const uri = String(attributes.URI ?? '').trim()
        if (uri) {
          const absolute = resolveUri(uri, playlistUrl)
          let map = mapByUri.get(absolute)
          if (!map) {
            const ext = extFromUrl(absolute, 'mp4')
            map = { uri: absolute, name: `init-${String(maps.length).padStart(3, '0')}.${ext}` }
            mapByUri.set(absolute, map)
            maps.push(map)
          }
          currentMap = map
        }
      } else if (tag === '#EXT-X-BYTERANGE') {
        throw new Error('暂不支持按字节范围切分的 HLS 分片')
      }
      continue
    }
    const uri = resolveUri(line, playlistUrl)
    const ext = extFromUrl(uri, 'ts')
    segments.push({
      uri,
      key: currentKey,
      sequence: mediaSequence + segments.length,
      name: `seg-${String(segments.length).padStart(3, '0')}.${ext}`,
      mapName: currentMap?.name ?? null,
    })
  }
  if (!segments.length) throw new Error('HLS 播放列表没有分片')
  return { text, playlistUrl, segments, maps }
}

/** 生成本地 playlist：去掉密钥/低延迟分片标签，分片与初始化段改成相对文件名。 */
export function localPlaylistText(plan: HlsMediaPlan): string {
  const mapNames = new Map(plan.maps.map((map) => [map.uri, map.name]))
  const output: string[] = []
  let cursor = 0
  for (const raw of linesOf(plan.text)) {
    const line = raw.trim()
    if (!line) continue
    const tag = tagOf(line)
    if (
      tag === '#EXT-X-KEY' ||
      tag === '#EXT-X-SESSION-KEY' ||
      tag === '#EXT-X-PART' ||
      tag === '#EXT-X-PRELOAD-HINT' ||
      tag === '#EXT-X-RENDITION-REPORT'
    ) {
      continue
    }
    if (tag === '#EXT-X-MAP') {
      output.push(
        rewriteUriAttribute(line, (uri) => {
          const name = mapNames.get(resolveUri(uri, plan.playlistUrl))
          if (!name) throw new Error('HLS 初始化段解析不一致')
          return name
        }),
      )
      continue
    }
    if (line.startsWith('#')) {
      output.push(line)
      continue
    }
    const segment = plan.segments[cursor]
    if (!segment) throw new Error('HLS 播放列表分片解析不一致')
    cursor += 1
    output.push(segment.name)
  }
  if (cursor !== plan.segments.length) throw new Error('HLS 播放列表分片解析不一致')
  return `${output.join('\n')}\n`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(MEDIA_ABORTED_MESSAGE)
}

async function openStream(
  opener: HlsStreamOpener,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<MediaStreamResult> {
  throwIfAborted(signal)
  const opened = await opener(url, { method: 'GET', headers })
  throwIfAborted(signal)
  if (!opened.response.ok && opened.response.status !== 206) {
    try {
      await opened.response.body?.cancel()
    } catch {
      // 响应体可能已关闭，取消失败不影响错误处理。
    }
    throw new Error(`HTTP ${opened.response.status}`)
  }
  return opened
}

async function fetchPlaylist(
  opener: HlsStreamOpener,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<PlaylistPayload> {
  const opened = await openStream(opener, url, headers, signal)
  const buffer = await readBodyLimited(opened.response, PLAYLIST_MAX_BYTES)
  throwIfAborted(signal)
  const text = buffer.toString('utf8')
  if (!text.includes('#EXTM3U')) throw new Error('不是 HLS 播放列表')
  return { text, url: opened.finalUrl || url, headers }
}

function withReferer(headers: Record<string, string>, referer: string): Record<string, string> {
  const next: Record<string, string> = { ...headers }
  if (referer) next.Referer = referer
  return next
}

/** 逐层解开 master playlist，返回选中的 media playlist 计划。 */
async function resolveMediaPlan(
  top: PlaylistPayload,
  opener: HlsStreamOpener,
  signal: AbortSignal | undefined,
): Promise<HlsMediaPlan> {
  let current = top
  for (let depth = 0; depth < MAX_PLAYLIST_DEPTH; depth += 1) {
    assertMasterHasNoDrm(current.text)
    if (!isMasterPlaylist(current.text)) return parseMediaPlaylist(current.text, current.url)
    const variants = parseMasterPlaylist(current.text, current.url)
    const best = selectHighestVariant(variants)
    if (!best) throw new Error('HLS master 播放列表没有可用码率')
    current = await fetchPlaylist(opener, best.uri, withReferer(current.headers, current.url), signal)
  }
  throw new Error('HLS 播放列表嵌套过深')
}

function extOfName(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'bin'
}

async function fileBytes(storeId: string, name: string): Promise<number | null> {
  try {
    const info = await stat(join(mediaRoot(), storeId, name))
    return info.isFile() ? info.size : null
  } catch {
    return null
  }
}

async function readPartial(storeId: string): Promise<HlsPartialState | null> {
  try {
    const text = await readFile(join(mediaRoot(), storeId, HLS_PARTIAL_FILE), 'utf8')
    const parsed = JSON.parse(text) as Record<string, unknown>
    if (parsed.version !== 1 || typeof parsed.fingerprint !== 'string') return null
    const rawDone = parsed.done
    if (!rawDone || typeof rawDone !== 'object') return null
    const done: Record<string, number> = {}
    for (const [name, value] of Object.entries(rawDone as Record<string, unknown>)) {
      if (!SAFE_MEDIA_NAME.test(name) || typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
      done[name] = Math.floor(value)
    }
    return { version: 1, fingerprint: parsed.fingerprint, done }
  } catch {
    return null
  }
}

async function savePartial(storeId: string, state: HlsPartialState): Promise<void> {
  const dir = join(mediaRoot(), storeId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, HLS_PARTIAL_FILE), JSON.stringify(state))
}

async function loadKey(
  opener: HlsStreamOpener,
  uri: string,
  cache: Map<string, Buffer>,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<Buffer> {
  const cached = cache.get(uri)
  if (cached) return cached
  const opened = await openStream(opener, uri, headers, signal)
  const data = await readBodyLimited(opened.response, KEY_MAX_BYTES)
  throwIfAborted(signal)
  if (data.length !== 16) throw new Error('HLS 密钥长度不是 16 字节')
  cache.set(uri, data)
  return data
}

function decryptSegment(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (!data.length || data.length % 16 !== 0) throw new Error('HLS 加密分片长度异常')
  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 明文分片：流式落盘，受 MEDIA_MAX_FILE_BYTES 保护；已完整下载的分片直接复用。 */
async function downloadPlainSegment(
  opener: HlsStreamOpener,
  segment: HlsSegment,
  headers: Record<string, string>,
  storeId: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const opened = await openStream(opener, segment.uri, headers, signal)
  const bytes = await saveMediaStream(storeId, segment.name, opened.response.body, signal)
  if (!bytes) throw new Error('媒体文件为空')
  return bytes
}

/** 加密分片：读入内存→AES-128-CBC 解密→落盘；密钥用完即丢，不写文件。 */
async function downloadEncryptedSegment(
  opener: HlsStreamOpener,
  segment: HlsSegment,
  key: Buffer,
  headers: Record<string, string>,
  storeId: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const opened = await openStream(opener, segment.uri, headers, signal)
  const encrypted = await readBodyLimited(opened.response, MEDIA_MAX_FILE_BYTES)
  throwIfAborted(signal)
  const plain = decryptSegment(encrypted, key, segment.key?.iv ?? ivForSequence(segment.sequence))
  const bytes = await writeMediaFile(storeId, segment.name, plain)
  if (!bytes) throw new Error('媒体文件为空')
  return bytes
}

/**
 * 下载一整章 HLS：选最高码率 → 初始化段 → 分片（按需解密）→ 本地 playlist。
 * 全部文件落盘后才返回；调用方据此发布索引。断点续传只补缺分片。
 */
export async function downloadHlsChapter(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const signal = options.signal
  const opener = options.opener
  const baseHeaders = options.headers ?? {}
  throwIfAborted(signal)
  const top = await fetchPlaylist(opener, options.playlistUrl, baseHeaders, signal)
  const plan = await resolveMediaPlan(top, opener, signal)
  const fingerprint = createHash('sha1').update(plan.text).digest('hex')
  const previous = await readPartial(options.storeId)
  const reusable = previous !== null && previous.fingerprint === fingerprint
  if (reusable) await mkdir(join(mediaRoot(), options.storeId), { recursive: true })
  else await prepareMediaDir(options.storeId)
  const state: HlsPartialState = { version: 1, fingerprint, done: reusable ? { ...previous.done } : {} }
  const headers = withReferer(baseHeaders, plan.playlistUrl)
  const keyCache = new Map<string, Buffer>()
  const files: HlsFileResult[] = []

  for (const map of plan.maps) {
    throwIfAborted(signal)
    const cached = state.done[map.name]
    const bytes = cached !== undefined && (await fileBytes(options.storeId, map.name)) === cached
      ? cached
      : await downloadPlainSegment(
          opener,
          { uri: map.uri, key: null, sequence: 0, name: map.name, mapName: null },
          headers,
          options.storeId,
          signal,
        )
    state.done[map.name] = bytes
    files.push({ name: map.name, mime: contentTypeForExt(extOfName(map.name)), bytes })
  }

  for (const segment of plan.segments) {
    throwIfAborted(signal)
    const cached = state.done[segment.name]
    let bytes: number
    if (cached !== undefined && (await fileBytes(options.storeId, segment.name)) === cached) {
      bytes = cached
    } else {
      if (segment.key) {
        const key = await loadKey(opener, segment.key.uri, keyCache, headers, signal)
        bytes = await downloadEncryptedSegment(opener, segment, key, headers, options.storeId, signal)
      } else {
        bytes = await downloadPlainSegment(opener, segment, headers, options.storeId, signal)
      }
      state.done[segment.name] = bytes
      await savePartial(options.storeId, state)
    }
    files.push({ name: segment.name, mime: contentTypeForExt(extOfName(segment.name)), bytes })
  }

  throwIfAborted(signal)
  const playlist = localPlaylistText(plan)
  const playlistBytes = await writeMediaFile(
    options.storeId,
    HLS_PLAYLIST_NAME,
    Buffer.from(playlist, 'utf8'),
  )
  state.done[HLS_PLAYLIST_NAME] = playlistBytes
  await savePartial(options.storeId, state)
  files.unshift({ name: HLS_PLAYLIST_NAME, mime: contentTypeForExt('m3u8'), bytes: playlistBytes })
  return { files, fingerprint }
}

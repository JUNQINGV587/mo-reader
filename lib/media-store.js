import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ReaderError } from './errors.js'
import { stableId } from './utils.js'

export const DEFAULT_MEDIA_QUOTA = 50 * 1024 * 1024 * 1024
export const MEDIA_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function defaultRoot() {
  return path.join(os.homedir(), '.dsh', 'reader', 'media')
}

function finiteSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ReaderError('reader/invalid-media', `${label} 必须是非负整数。`)
  return value
}

function mediaId(value) {
  const id = String(value ?? '')
  if (!MEDIA_ID_PATTERN.test(id)) throw new ReaderError('reader/invalid-media', '媒体 id 无效。')
  return id
}

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!MEDIA_ID_PATTERN.test(String(raw.id ?? ''))) return null
  if (!MEDIA_ID_PATTERN.test(String(raw.bookId ?? '')) && typeof raw.bookId !== 'string') return null
  if (typeof raw.bookId !== 'string' || !raw.bookId) return null
  if (typeof raw.chapterId !== 'string' || !raw.chapterId) return null
  const status = raw.status === 'downloading' ? 'downloading' : 'ready'
  return {
    id: raw.id,
    bookId: raw.bookId,
    chapterId: raw.chapterId,
    sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    contentType: typeof raw.contentType === 'string' ? raw.contentType : 'application/octet-stream',
    file: status === 'ready' ? `${raw.id}.bin` : null,
    size: finiteSize(Number(raw.size ?? 0), 'size'),
    status,
    retained: raw.retained === true,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    lastAccessedAt: Number.isFinite(raw.lastAccessedAt) ? raw.lastAccessedAt : Date.now(),
  }
}

export class MediaStore {
  constructor({ root = defaultRoot(), quotaBytes = DEFAULT_MEDIA_QUOTA, now = () => Date.now() } = {}) {
    this.root = path.resolve(root)
    this.filesDir = path.join(this.root, 'files')
    this.indexPath = path.join(this.root, 'index.json')
    this.quotaBytes = finiteSize(Number(quotaBytes), 'quotaBytes')
    this.now = now
    this.records = new Map()
    this.loaded = false
    this.queue = Promise.resolve()
    this.persistedAccess = new Map()
  }

  async init() {
    if (this.loaded) return this
    await fs.mkdir(this.filesDir, { recursive: true })
    this.root = await fs.realpath(this.root)
    this.filesDir = path.join(this.root, 'files')
    this.indexPath = path.join(this.root, 'index.json')
    const filesInfo = await fs.lstat(this.filesDir)
    if (!filesInfo.isDirectory() || filesInfo.isSymbolicLink()) {
      throw new ReaderError('reader/media-forbidden', '媒体目录不能是符号链接。')
    }
    if (await fs.realpath(this.filesDir) !== this.filesDir) {
      throw new ReaderError('reader/media-forbidden', '媒体目录逃出了缓存根目录。')
    }
    let raw
    try {
      raw = JSON.parse(await fs.readFile(this.indexPath, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new ReaderError('reader/media-index', '媒体索引无法读取。', undefined, { cause: error })
      raw = { version: 1, records: [] }
    }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) {
      throw new ReaderError('reader/media-index', '媒体索引格式无效。')
    }
    for (const value of raw.records) {
      const record = cleanRecord(value)
      if (!record) continue
      // A process restart cannot resume an in-flight write; do not let a stale
      // reservation pin a whole work forever.
      if (record.status === 'downloading') continue
      this.records.set(record.id, record)
    }
    const available = new Set(await fs.readdir(this.filesDir))
    for (const [id, record] of this.records) {
      if (!available.has(record.file)) this.records.delete(id)
    }
    const keep = new Set([...this.records.values()].map(record => record.file))
    for (const name of available) {
      if (keep.has(name)) continue
      await fs.rm(path.join(this.filesDir, name), { force: true, recursive: true }).catch(() => {})
    }
    if (this.records.size !== raw.records.length) await this.persist()
    this.loaded = true
    return this
  }

  assertLoaded() {
    if (!this.loaded) throw new ReaderError('reader/media-unavailable', '媒体存储尚未初始化。')
  }

  mutate(work) {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  async persist() {
    const temp = path.join(this.root, `.index-${process.pid}-${randomUUID()}.tmp`)
    const body = JSON.stringify({ version: 1, records: [...this.records.values()] })
    await fs.writeFile(temp, body, { mode: 0o600 })
    await fs.rename(temp, this.indexPath)
  }

  totalBytes() {
    let total = 0
    for (const record of this.records.values()) total += record.size
    return total
  }

  stats() {
    const books = new Set()
    let retained = 0
    let downloading = 0
    for (const record of this.records.values()) {
      books.add(record.bookId)
      if (record.retained) retained += 1
      if (record.status === 'downloading') downloading += 1
    }
    const usedBytes = this.totalBytes()
    return {
      root: this.root,
      quotaBytes: this.quotaBytes,
      usedBytes,
      freeBytes: Math.max(0, this.quotaBytes - usedBytes),
      mediaCount: this.records.size,
      bookCount: books.size,
      retainedCount: retained,
      downloadingCount: downloading,
    }
  }

  list({ bookId } = {}) {
    this.assertLoaded()
    return [...this.records.values()]
      .filter(record => bookId === undefined || record.bookId === bookId)
      .map(record => structuredClone(record))
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
  }

  record(id) {
    this.assertLoaded()
    const record = this.records.get(mediaId(id))
    if (!record) throw new ReaderError('reader/media-not-found', '未找到媒体缓存。')
    return record
  }

  async setQuotaBytes(value) {
    this.quotaBytes = finiteSize(Number(value), 'quotaBytes')
    return this.quotaBytes
  }

  async filePath(record) {
    if (record.status !== 'ready' || record.file !== `${record.id}.bin`) {
      throw new ReaderError('reader/media-not-found', '媒体文件尚未就绪。')
    }
    if (await fs.realpath(this.filesDir) !== this.filesDir) {
      throw new ReaderError('reader/media-forbidden', '媒体目录逃出了缓存根目录。')
    }
    const candidate = path.join(this.filesDir, record.file)
    const resolved = path.resolve(candidate)
    if (!resolved.startsWith(`${this.filesDir}${path.sep}`)) {
      throw new ReaderError('reader/media-forbidden', '媒体路径无效。')
    }
    const info = await fs.lstat(resolved).catch(error => {
      if (error?.code === 'ENOENT') throw new ReaderError('reader/media-not-found', '媒体文件不存在。')
      throw error
    })
    if (info.isSymbolicLink()) throw new ReaderError('reader/media-forbidden', '媒体文件不能是符号链接。')
    if (!info.isFile()) throw new ReaderError('reader/media-not-found', '媒体文件不存在。')
    return { path: resolved, size: info.size }
  }

  async bookUsage(bookId, excludeId) {
    let bytes = 0
    const records = []
    for (const record of this.records.values()) {
      if (record.bookId !== bookId || record.id === excludeId) continue
      bytes += record.size
      records.push(record)
    }
    return { bytes, records }
  }

  async evictFor(requiredBytes, { ignoreBookId, reclaim = 0 } = {}) {
    const target = finiteSize(requiredBytes, 'requiredBytes')
    if (target > this.quotaBytes) {
      throw new ReaderError('reader/media-quota', '这个文件超过媒体缓存总配额。', { quotaBytes: this.quotaBytes, requiredBytes: target })
    }
    let used = this.totalBytes() - reclaim
    if (used + target <= this.quotaBytes) return []
    const groups = new Map()
    for (const record of this.records.values()) {
      if (record.bookId === ignoreBookId) continue
      if (!groups.has(record.bookId)) groups.set(record.bookId, [])
      groups.get(record.bookId).push(record)
    }
    const candidates = [...groups.entries()].map(([bookId, records]) => ({
      bookId,
      records,
      bytes: records.reduce((sum, record) => sum + record.size, 0),
      lastAccessedAt: Math.max(...records.map(record => record.lastAccessedAt)),
    })).filter(group => !group.records.some(record => record.retained || record.status === 'downloading'))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
    const evicted = []
    for (const group of candidates) {
      if (used + target <= this.quotaBytes) break
      for (const record of group.records) {
        this.records.delete(record.id)
        if (record.file) await fs.unlink(path.join(this.filesDir, record.file)).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
        used -= record.size
      }
      evicted.push({ bookId: group.bookId, bytes: group.bytes })
    }
    if (evicted.length) await this.persist()
    if (used + target > this.quotaBytes) {
      throw new ReaderError('reader/media-quota', '媒体缓存已满，没有可淘汰的作品。', {
        quotaBytes: this.quotaBytes,
        usedBytes: used,
        requiredBytes: target,
      })
    }
    return evicted
  }

  async reserve({ bookId, chapterId, sourceId, title, contentType = 'application/octet-stream', size, retained = false }) {
    this.assertLoaded()
    const expected = finiteSize(Number(size), 'size')
    if (expected === 0) throw new ReaderError('reader/invalid-media', '媒体大小必须大于 0。')
    if (typeof bookId !== 'string' || !bookId) throw new ReaderError('reader/invalid-media', 'bookId 无效。')
    if (typeof chapterId !== 'string' || !chapterId) throw new ReaderError('reader/invalid-media', 'chapterId 无效。')
    return this.mutate(async () => {
      const id = stableId('media', sourceId ?? '', bookId, chapterId)
      const previous = this.records.get(id)
      if (previous?.status === 'downloading') throw new ReaderError('reader/media-busy', '这个章节正在缓存。')
      await this.evictFor(expected, { ignoreBookId: bookId, reclaim: previous?.size ?? 0 })
      if (previous?.file) {
        await fs.unlink(path.join(this.filesDir, previous.file)).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
      }
      const timestamp = this.now()
      const record = {
        id,
        bookId,
        chapterId,
        sourceId,
        title: typeof title === 'string' ? title : undefined,
        contentType,
        file: null,
        size: expected,
        status: 'downloading',
        retained: retained === true,
        createdAt: previous?.createdAt ?? timestamp,
        lastAccessedAt: timestamp,
      }
      this.records.set(id, record)
      await this.persist()
      return structuredClone(record)
    })
  }

  async commit(id, data) {
    this.assertLoaded()
    const bytes = Buffer.from(data)
    return this.mutate(async () => {
      const record = this.record(id)
      if (record.status !== 'downloading') throw new ReaderError('reader/media-busy', '媒体记录不处于写入状态。')
      if (bytes.length === 0) throw new ReaderError('reader/invalid-media', '媒体内容为空。')
      const delta = bytes.length - record.size
      if (delta > 0) await this.evictFor(delta, { ignoreBookId: record.bookId })
      const file = `${record.id}.bin`
      const target = path.join(this.filesDir, file)
      const temp = path.join(this.filesDir, `.${record.id}-${randomUUID()}.tmp`)
      await fs.writeFile(temp, bytes, { mode: 0o600 })
      await fs.rename(temp, target)
      record.file = file
      record.size = bytes.length
      record.status = 'ready'
      record.lastAccessedAt = this.now()
      this.records.set(record.id, record)
      await this.persist()
      return structuredClone(record)
    })
  }

  async put(input) {
    const data = Buffer.from(input.data)
    const reservation = await this.reserve({ ...input, size: data.length })
    try {
      return await this.commit(reservation.id, data)
    } catch (error) {
      await this.abort(reservation.id).catch(() => {})
      throw error
    }
  }

  async abort(id) {
    this.assertLoaded()
    return this.mutate(async () => {
      const record = this.records.get(mediaId(id))
      if (!record) return false
      if (record.file) await fs.unlink(path.join(this.filesDir, record.file)).catch(error => {
        if (error?.code !== 'ENOENT') throw error
      })
      this.records.delete(record.id)
      await this.persist()
      return true
    })
  }

  async remove(id) {
    return this.abort(id)
  }

  async touch(id) {
    this.assertLoaded()
    return this.mutate(async () => {
      const record = this.record(id)
      const timestamp = this.now()
      record.lastAccessedAt = timestamp
      this.records.set(record.id, record)
      // Range requests are frequent; persist the LRU clock at most once a minute.
      const persisted = this.persistedAccess.get(record.id)
      if (persisted === undefined || timestamp - persisted >= 60_000) {
        await this.persist()
        this.persistedAccess.set(record.id, timestamp)
      }
      return structuredClone(record)
    })
  }

  async setRetained(id, retained) {
    this.assertLoaded()
    if (typeof retained !== 'boolean') throw new ReaderError('reader/invalid-input', 'retained 必须是布尔值。')
    return this.mutate(async () => {
      const record = this.record(id)
      record.retained = retained
      this.records.set(record.id, record)
      await this.persist()
      return structuredClone(record)
    })
  }

  async removeBook(bookId) {
    this.assertLoaded()
    return this.mutate(async () => {
      const records = [...this.records.values()].filter(record => record.bookId === bookId)
      for (const record of records) {
        if (record.file) await fs.unlink(path.join(this.filesDir, record.file)).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
        this.records.delete(record.id)
      }
      if (records.length) await this.persist()
      return records.length
    })
  }
}

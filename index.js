import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createBackup, parseBackup } from './lib/backup.js'
import { ReaderError } from './lib/errors.js'
import { fetchRemote } from './lib/http.js'
import { importEpub, importedSource, importTxt } from './lib/importers.js'
import { ACTIVE_JOBS, createJob, jobView, transitionJob } from './lib/jobs.js'

const MAX_PARALLEL_JOBS = 4
const MAX_PER_SOURCE_JOBS = 2
const MAX_CHAPTER_ATTEMPTS = 2
import { applyReplacements } from './lib/replacements.js'
import { assertSettingKeys, normalizeReaderPrefs, normalizeSettings } from './lib/settings.js'
import { normalizeSource } from './lib/rules.js'
import { BUILTIN_SOURCES } from './lib/builtin-sources.js'
import { SourceEngine } from './lib/source-engine.js'
import { DEFAULT_SETTINGS, entries, openReaderStorage } from './lib/storage.js'
import { base64ToBuffer, clone, id, MAX_ARCHIVE_BYTES, MAX_TEXT_BYTES, now, pageNumber, requiredString, stableId, textToBuffer } from './lib/utils.js'

const COVER_MAX_BYTES = 2 * 1024 * 1024

export const REMOTE_METHODS = Object.freeze([
  'state', 'importSource', 'restoreBuiltinSources', 'removeSource', 'search', 'discover', 'addBook', 'removeBook', 'toc', 'chapter',
  'saveProgress', 'download', 'cancelJob', 'pauseJob', 'resumeJob', 'checkUpdates', 'importLocal', 'setSettings', 'setBookSettings', 'saveNote', 'deleteNote',
  'exportBackup', 'importBackup', 'fetchCover', 'cacheBookCover', 'bookCandidates', 'applyBookMeta',
])

function assertObject(value, label = 'arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReaderError('reader/invalid-input', `${label} must be an object.`)
}

export class ReaderService extends TypertRemoteService {
  static inject = ['storageDomain', 'timer']

  constructor(ctx, options = {}) {
    super(ctx, 'reader')
    this.engine = options.engine ?? new SourceEngine(options)
    this.fetchRemote = options.fetchRemote ?? fetchRemote
    this.runningJobs = new Map()
    this.coverCache = new Map()
    this.disposed = false
    const service = this
    for (const name of REMOTE_METHODS) {
      Remote(name)(null, {
        name,
        private: false,
        static: false,
        addInitializer(fn) { fn.call(service) },
      })
    }
  }

  async [Service.init]() {
    this.db = await openReaderStorage(this.ctx)
    await this.seedBuiltinSources()
    this.ctx.effect(() => async () => {
      this.disposed = true
      for (const job of entries(this.db.jobs)) {
        if (ACTIVE_JOBS.has(job.status)) await this.db.jobs.put(job.id, transitionJob(job, 'cancel'))
      }
      await Promise.allSettled([...this.runningJobs.values()])
      await this.db.domain.close()
    }, 'reader: close storage and jobs')
    this.stopUpdates = this.ctx.interval(() => {
      this.checkUpdates().catch(error => this.log('warn', 'Scheduled update check failed', error))
    }, 3_600_000)
    for (const job of entries(this.db.jobs)) {
      if (job.status === 'running') await this.db.jobs.put(job.id, transitionJob(job, 'recover'))
    }
    try {
      await this.checkUpdates()
    } catch (error) {
      this.log('warn', 'Startup update check failed', error)
    }
    for (const job of entries(this.db.jobs)) if (job.status === 'queued') this.scheduleJob(job.id)
  }

  async restoreBuiltinSources(args) {
    args ??= {}
    this.assertReady()
    const settings = this.db.settings.get()
    let added = 0
    for (const raw of BUILTIN_SOURCES) {
      const source = normalizeSource(raw)
      if (this.db.sources.get(source.id)) continue
      await this.db.sources.put(source.id, { ...source, builtin: true })
      added += 1
    }
    await this.db.settings.set({ ...settings, builtinSourcesAt: settings.builtinSourcesAt ?? now() })
    return { added, total: BUILTIN_SOURCES.length }
  }

  async seedBuiltinSources() {
    const settings = this.db.settings.get()
    if (settings.builtinSourcesAt) return
    for (const raw of BUILTIN_SOURCES) {
      const source = normalizeSource(raw)
      if (!this.db.sources.get(source.id)) await this.db.sources.put(source.id, { ...source, builtin: true })
    }
    await this.db.settings.set({ ...settings, builtinSourcesAt: now() })
  }

  log(level, message, error) {
    const logger = this.ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level]('%s: %s', message, error?.message ?? error ?? '')
  }

  assertReady() {
    if (!this.db || this.disposed) throw new ReaderError('reader/unavailable', 'Reader service is not ready.')
  }

  source(sourceId) {
    const source = this.db.sources.get(requiredString(sourceId, 'sourceId'))
    if (!source) throw new ReaderError('reader/not-found', `Source ${sourceId} not found.`)
    return source
  }

  book(bookId) {
    const book = this.db.books.get(requiredString(bookId, 'bookId'))
    if (!book) throw new ReaderError('reader/not-found', `Book ${bookId} not found.`)
    return book
  }

  chapters(bookId) {
    return entries(this.db.chapters).filter(chapter => chapter.bookId === bookId).sort((a, b) => a.index - b.index)
  }

  chapterView(chapter) {
    return {
      id: chapter.id,
      bookId: chapter.bookId,
      index: chapter.index,
      title: chapter.title,
      url: chapter.url,
      downloaded: typeof chapter.text === 'string',
      downloadedAt: chapter.downloadedAt,
    }
  }

  bookView(book) {
    const chapters = this.chapters(book.id)
    const downloaded = chapters.filter(chapter => typeof chapter.text === 'string').length
    const readIndex = book.progress ? chapters.findIndex(chapter => chapter.id === book.progress.chapterId) : -1
    const status = book.download?.status === 'completed' && downloaded < chapters.length ? 'partial' : book.download?.status ?? (downloaded ? 'partial' : 'none')
    return {
      ...clone(book),
      unread: Math.max(0, readIndex < 0 ? chapters.length : chapters.length - readIndex - 1),
      lastRead: clone(book.progress ?? null),
      readerPrefs: book.readerPrefs && Object.keys(book.readerPrefs).length ? clone(book.readerPrefs) : null,
      download: { status, total: chapters.length, done: downloaded, jobId: book.download?.jobId, auto: book.download?.auto === true },
    }
  }

  async state() {
    this.assertReady()
    return {
      sources: [importedSource(), ...entries(this.db.sources)].map(clone),
      books: entries(this.db.books).map(book => this.bookView(book)),
      jobs: entries(this.db.jobs).map(jobView),
      settings: clone(this.db.settings.get()),
      notes: entries(this.db.notes).map(clone),
    }
  }

  async importSource(args) {
    args ??= {}
    this.assertReady()
    assertObject(args)
    let text = args.text
    if (text === undefined && args.url !== undefined) {
      const response = await fetchRemote(requiredString(args.url, 'url', 4096), { allowHttp: args.allowHttp === true, maxBytes: 2 * 1024 * 1024 })
      text = response.text
    }
    if (typeof text !== 'string') throw new ReaderError('reader/invalid-input', 'importSource requires text or url.')
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new ReaderError('reader/invalid-source', '书源不是有效 JSON。', undefined, { cause: error })
    }
    if (Array.isArray(raw)) {
      const imported = []
      const skipped = []
      raw.forEach((item, index) => {
        try {
          imported.push(normalizeSource(item, { allowHttp: args.allowHttp === true }))
        } catch (error) {
          skipped.push({ index, reason: error?.message || String(error) })
        }
      })
      if (!imported.length) throw new ReaderError('reader/invalid-source', '这批书源都不符合规则，一个也没有导入。', undefined, { cause: skipped.length ? new Error(skipped[0].reason) : undefined })
      for (const source of imported) await this.db.sources.put(source.id, source)
      return { imported: imported.length, skipped, total: raw.length, names: imported.map(item => item.name) }
    }
    const source = normalizeSource(raw, { allowHttp: args.allowHttp === true })
    await this.db.sources.put(source.id, source)
    return { imported: 1, skipped: [], total: 1, names: [source.name], ...clone(source) }
  }

  async removeSource(args) {
    args ??= {}
    this.assertReady()
    const source = this.source(args.id)
    if (source.builtin) throw new ReaderError('reader/unsupported-source', '内置书源不能删除，可以关闭。')
    if (entries(this.db.books).some(book => book.sourceId === source.id)) throw new ReaderError('reader/source-in-use', '请先从书架移除该书源的书籍。')
    await this.db.sources.delete(source.id)
    return { removed: true, id: source.id }
  }

  async markSourceStatus(sourceId, error) {
    const source = this.db.sources.get(sourceId)
    if (!source) return
    const failed = !!error
    if (!failed && !source.lastError) return
    await this.db.sources.put(source.id, {
      ...source,
      lastError: failed ? String(error.message || error).slice(0, 200) : undefined,
      lastErrorAt: failed ? now() : source.lastErrorAt,
      updatedAt: now(),
    })
  }

  async search(args) {
    args ??= {}
    this.assertReady()
    const source = this.source(args.sourceId)
    try {
      const list = await this.engine.search(source, { query: requiredString(args.query, 'query', 500), page: pageNumber(args.page) })
      await this.markSourceStatus(source.id, null)
      return list
    } catch (error) {
      await this.markSourceStatus(source.id, error)
      throw error
    }
  }

  async discover(args) {
    args ??= {}
    this.assertReady()
    return this.engine.discover(this.source(args.sourceId), { exploreIndex: args.exploreIndex ?? 0, page: pageNumber(args.page) })
  }

  async addBook(args) {
    args ??= {}
    this.assertReady()
    const source = this.source(args.sourceId)
    const bookUrl = requiredString(args.bookUrl, 'bookUrl', 4096)
    const hint = args.book && typeof args.book === 'object' ? args.book : {}
    const info = { ...hint, ...(await this.engine.bookInfo(source, bookUrl)) }
    if (!info.name) throw new ReaderError('reader/parse-error', '书籍详情缺少 name；请在搜索结果的书籍信息里补上书名。')
    const timestamp = now()
    const bookId = stableId('book', source.id, bookUrl)
    const previous = this.db.books.get(bookId)
    const book = {
      ...info,
      id: bookId,
      sourceId: source.id,
      bookUrl,
      name: String(info.name).trim(),
      local: false,
      addedAt: previous?.addedAt ?? timestamp,
      updatedAt: timestamp,
      progress: previous?.progress ?? null,
      download: previous?.download ?? { status: 'none', auto: false },
    }
    await this.db.books.put(book.id, book)
    await this.cacheCover(book)
    if (args.download === true) {
      const job = await this.download({ bookId: book.id })
      return { ...this.bookView(book), download: { ...this.bookView(book).download, status: 'queued', jobId: job.id } }
    }
    return this.bookView(book)
  }

  async removeBook(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    for (const job of entries(this.db.jobs).filter(job => job.bookId === book.id)) {
      if (ACTIVE_JOBS.has(job.status)) await this.db.jobs.put(job.id, transitionJob(job, 'cancel'))
      await this.db.jobs.delete(job.id)
    }
    await this.db.chapters.deleteMany(this.chapters(book.id).map(chapter => chapter.id))
    await this.db.notes.deleteMany(entries(this.db.notes).filter(note => note.bookId === book.id).map(note => note.id))
    await this.db.books.delete(book.id)
    return { removed: true, id: book.id }
  }

  async syncToc(book, fresh) {
    const old = new Map(this.chapters(book.id).map(chapter => [chapter.id, chapter]))
    const chapters = fresh.map(chapter => {
      const cached = old.get(chapter.id)
      return cached ? { ...chapter, text: cached.text, html: cached.html, downloadedAt: cached.downloadedAt } : chapter
    })
    const freshIds = new Set(chapters.map(chapter => chapter.id))
    await this.db.chapters.deleteMany([...old.keys()].filter(chapterId => !freshIds.has(chapterId)))
    for (const chapter of chapters) await this.db.chapters.put(chapter.id, chapter)
    const latest = this.db.books.get(book.id) ?? book
    await this.db.books.put(book.id, { ...latest, latestChapter: chapters.at(-1)?.title, lastCheckedAt: now(), updatedAt: now() })
    return chapters
  }

  async toc(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const cached = this.chapters(book.id)
    if (cached.length && args.refresh !== true) return cached.map(chapter => this.chapterView(chapter))
    if (book.local) return cached.map(chapter => this.chapterView(chapter))
    const fresh = await this.engine.toc(this.source(book.sourceId), book)
    return (await this.syncToc(book, fresh)).map(chapter => this.chapterView(chapter))
  }

  async chapter(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const chapterId = requiredString(args.chapterId, 'chapterId')
    let chapter = this.db.chapters.get(chapterId)
    if (!chapter || chapter.bookId !== book.id) throw new ReaderError('reader/not-found', `Chapter ${chapterId} not found in this book.`)
    if (typeof chapter.text !== 'string') {
      if (book.local) throw new ReaderError('reader/not-found', 'Local chapter cache is missing.')
      const content = await this.engine.content(this.source(book.sourceId), book, chapter)
      chapter = { ...chapter, text: content.text, html: content.html, downloadedAt: now() }
      await this.db.chapters.put(chapter.id, chapter)
    }
    return { ...this.chapterView(chapter), text: applyReplacements(chapter.text, this.db.settings.get().replacements), downloaded: true }
  }

  async saveProgress(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const chapter = this.db.chapters.get(requiredString(args.chapterId, 'chapterId'))
    if (!chapter || chapter.bookId !== book.id) throw new ReaderError('reader/not-found', 'Progress chapter does not belong to this book.')
    const offset = args.offset ?? 0
    const percent = args.percent ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw new ReaderError('reader/invalid-input', 'offset must be a non-negative integer and percent must be between 0 and 100.')
    }
    const progress = { chapterId: chapter.id, offset, percent, updatedAt: now() }
    await this.db.books.put(book.id, { ...book, progress, updatedAt: now() })
    return clone(progress)
  }

  activeJobFor(bookId) {
    return entries(this.db.jobs).find(job => job.bookId === bookId && job.type === 'download' && ['queued', 'running', 'paused'].includes(job.status))
  }

  async pauseJob(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const job = this.activeJobFor(book.id)
    if (!job) throw new ReaderError('reader/not-found', 'No active download for this book.')
    const paused = transitionJob(job, 'pause')
    await this.db.jobs.put(paused.id, paused)
    await this.db.books.put(book.id, { ...this.book(book.id), download: { status: 'paused', jobId: paused.id, auto: true }, updatedAt: now() })
    return jobView(paused)
  }

  async resumeJob(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const job = this.activeJobFor(book.id)
    if (!job || job.status !== 'paused') throw new ReaderError('reader/not-found', 'No paused download for this book.')
    const resumed = transitionJob(job, 'resume')
    await this.db.jobs.put(resumed.id, resumed)
    await this.db.books.put(book.id, { ...this.book(book.id), download: { status: 'queued', jobId: resumed.id, auto: true }, updatedAt: now() })
    this.scheduleJob(resumed.id)
    return jobView(resumed)
  }

  async download(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const existing = entries(this.db.jobs).find(job => job.bookId === book.id && job.type === 'download' && ACTIVE_JOBS.has(job.status))
    if (existing) return jobView(existing)
    const total = this.chapters(book.id).length
    const job = createJob({ bookId: book.id, total })
    await this.db.jobs.put(job.id, job)
    await this.db.books.put(book.id, { ...book, download: { status: 'queued', jobId: job.id, auto: true }, updatedAt: now() })
    this.scheduleJob(job.id)
    return jobView(job)
  }

  canStartJob(job) {
    if (this.runningJobs.size >= MAX_PARALLEL_JOBS) return false
    const book = this.db.books.get(job.bookId)
    if (!book) return true
    let sameSource = 0
    for (const id of this.runningJobs.keys()) {
      const other = this.db.jobs.get(id)
      const otherBook = other && this.db.books.get(other.bookId)
      if (other && otherBook && otherBook.sourceId === book.sourceId) sameSource += 1
    }
    return sameSource < MAX_PER_SOURCE_JOBS
  }

  scheduleJob(jobId) {
    if (this.disposed || this.runningJobs.has(jobId)) return
    const pending = this.db.jobs.get(jobId)
    if (!pending || pending.status !== 'queued') return
    if (!this.canStartJob(pending)) return
    const promise = this.runJob(jobId)
      .catch(error => this.log('error', `Job ${jobId} could not update persisted state`, error))
      .finally(() => {
        this.runningJobs.delete(jobId)
        for (const next of entries(this.db.jobs)) {
          if (next.status === 'queued' && !this.runningJobs.has(next.id)) { this.scheduleJob(next.id); break }
        }
      })
    this.runningJobs.set(jobId, promise)
    return promise
  }

  async runJob(jobId) {
    try {
      let job = this.db.jobs.get(jobId)
      if (!job || job.status !== 'queued') return
      job = transitionJob(job, 'start')
      await this.db.jobs.put(job.id, job)
      if (job.type !== 'download') throw new ReaderError('reader/job-state', `Unknown job type ${job.type}.`)
      const book = this.book(job.bookId)
      const chapters = book.local ? this.chapters(book.id) : await this.syncToc(book, await this.engine.toc(this.source(book.sourceId), book))
      job = this.db.jobs.get(jobId)
      if (!job || job.status !== 'running') return
      job = { ...job, total: chapters.length, updatedAt: now() }
      await this.db.jobs.put(job.id, job)
      for (const chapter of chapters) {
        job = this.db.jobs.get(jobId)
        if (!job || job.status !== 'running' || this.disposed) return
        if (typeof chapter.text !== 'string') {
          let content = null
          let lastError = null
          for (let attempt = 1; attempt <= MAX_CHAPTER_ATTEMPTS; attempt += 1) {
            try { content = await this.engine.content(this.source(book.sourceId), book, chapter); lastError = null; break }
            catch (error) {
              lastError = error
              if (this.disposed) return
              const status = error && error.details && error.details.status
              if (attempt < MAX_CHAPTER_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, (status === 429 ? 1500 : 400) * attempt))
            }
          }
          job = this.db.jobs.get(jobId)
          if (!job || job.status !== 'running' || this.disposed) return
          if (content) await this.db.chapters.put(chapter.id, { ...chapter, ...content, downloadedAt: now() })
          else {
            this.log('warn', `Chapter ${chapter.id} skipped`, lastError)
            job = { ...job, failedChapters: [...(job.failedChapters || []), chapter.id] }
            await this.db.jobs.put(job.id, job)
          }
        }
        job = transitionJob(this.db.jobs.get(jobId), 'chapter')
        await this.db.jobs.put(job.id, job)
        if (!book.local) await new Promise(resolve => setTimeout(resolve, 200))
      }
      job = this.db.jobs.get(jobId)
      if (!job || job.status !== 'running') return
      await this.db.jobs.put(jobId, transitionJob(job, 'complete'))
      const latestBook = this.book(book.id)
      await this.db.books.put(book.id, { ...latestBook, download: { status: 'completed', jobId, auto: true }, updatedAt: now() })
    } catch (error) {
      const job = this.db.jobs.get(jobId)
      if (job && ACTIVE_JOBS.has(job.status)) await this.db.jobs.put(jobId, transitionJob(job, 'fail', { error: error.message }))
      const book = this.db.books.get(job?.bookId)
      if (book) await this.db.books.put(book.id, { ...book, download: { ...book.download, status: 'failed', jobId }, updatedAt: now() })
      this.log('warn', `Download job ${jobId} failed`, error)
    }
  }

  async cancelJob(args) {
    args ??= {}
    this.assertReady()
    const jobId = requiredString(args.jobId, 'jobId')
    const job = this.db.jobs.get(jobId)
    if (!job) throw new ReaderError('reader/not-found', `Job ${jobId} not found.`)
    const next = transitionJob(job, 'cancel')
    await this.db.jobs.put(jobId, next)
    const book = this.db.books.get(job.bookId)
    if (book) await this.db.books.put(book.id, { ...book, download: { ...book.download, status: 'cancelled', jobId }, updatedAt: now() })
    return jobView(next)
  }

  async checkUpdates() {
    this.assertReady()
    const result = { checked: 0, updated: 0, errors: [] }
    for (const original of entries(this.db.books).filter(book => !book.local)) {
      result.checked += 1
      try {
        const before = new Set(this.chapters(original.id).map(chapter => chapter.id))
        const fresh = await this.engine.toc(this.source(original.sourceId), original)
        const chapters = await this.syncToc(original, fresh)
        const added = chapters.filter(chapter => !before.has(chapter.id))
        if (added.length) {
          result.updated += 1
          if (original.download?.auto && this.db.settings.get().autoDownloadNewChapters) await this.download({ bookId: original.id })
        }
      } catch (error) {
        result.errors.push({ bookId: original.id, message: error.message })
      }
    }
    return result
  }

  async importLocal(args) {
    args ??= {}
    this.assertReady()
    assertObject(args)
    const name = requiredString(args.name, 'name', 200)
    if (!['txt', 'epub'].includes(args.format)) throw new ReaderError('reader/invalid-input', "format must be 'txt' or 'epub'.")
    if ((args.text === undefined) === (args.base64 === undefined)) throw new ReaderError('reader/invalid-input', 'Provide exactly one of text or base64.')
    const buffer = args.text !== undefined
      ? textToBuffer(args.text)
      : base64ToBuffer(args.base64, args.format === 'txt' ? MAX_TEXT_BYTES : MAX_ARCHIVE_BYTES)
    const imported = args.format === 'txt' ? importTxt(name, buffer.toString('utf8')) : await importEpub(name, buffer)
    const previous = this.db.books.get(imported.book.id)
    const book = previous ? { ...imported.book, addedAt: previous.addedAt, progress: previous.progress } : imported.book
    await this.db.books.put(book.id, book)
    const oldIds = this.chapters(book.id).map(chapter => chapter.id)
    await this.db.chapters.deleteMany(oldIds)
    for (const chapter of imported.chapters) await this.db.chapters.put(chapter.id, chapter)
    return this.bookView(book)
  }

  async fetchCover(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    if (!book.coverUrl) throw new ReaderError('reader/not-found', '这本书没有封面。')
    const url = String(book.coverUrl)
    const cached = this.coverCache.get(url)
    if (cached) {
      this.coverCache.delete(url)
      this.coverCache.set(url, cached)
      return { dataUrl: cached, cached: true }
    }
    const response = await this.fetchRemote(url, { maxBytes: COVER_MAX_BYTES })
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!contentType.startsWith('image/')) throw new ReaderError('reader/parse-error', '封面地址返回的不是图片。')
    if (response.buffer.length > COVER_MAX_BYTES) throw new ReaderError('reader/too-large', `封面超过 ${COVER_MAX_BYTES} 字节。`)
    const dataUrl = `data:${contentType};base64,${response.buffer.toString('base64')}`
    this.coverCache.set(url, dataUrl)
    while (this.coverCache.size > 24) this.coverCache.delete(this.coverCache.keys().next().value)
    return { dataUrl, cached: false }
  }

  async cacheCover(book) {
    const url = String(book?.coverUrl || '').trim()
    if (!url || /^data:/i.test(url) || book.coverLocal) return book
    try {
      const result = await this.fetchCover({ bookId: book.id })
      const next = { ...book, coverLocal: result.dataUrl, updatedAt: now() }
      await this.db.books.put(next.id, next)
      return next
    } catch {
      return book
    }
  }

  async cacheBookCover(args) {
    args ??= {}
    this.assertReady()
    const book = { ...this.book(args.bookId), coverLocal: '' }
    if (!book.coverUrl) throw new ReaderError('reader/not-found', '这本书还没有封面地址。')
    const next = await this.cacheCover(book)
    return { book: this.bookView(next), cached: Boolean(next.coverLocal) }
  }

  async bookCandidates(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const keyword = requiredString(String(args.query ?? book.name ?? '').replace(/\.(?:txt|epub|md|pdf)$/i, '').trim(), 'query', 200)
    const targets = [importedSource(), ...entries(this.db.sources)].filter(source => source.enabled !== false && source.rules?.search?.url)
    const settled = await Promise.allSettled(targets.map(async (source) => {
      try {
        const items = await this.engine.search(source, { query: keyword, page: 1 })
        return items.slice(0, 2).map(item => ({ ...item, sourceId: source.id, sourceName: source.name }))
      } catch {
        return []
      }
    }))
    const candidates = []
    for (const outcome of settled) if (outcome.status === 'fulfilled') candidates.push(...outcome.value)
    return { query: keyword, candidates: candidates.slice(0, 8).map(item => ({
      sourceId: item.sourceId,
      sourceName: item.sourceName,
      name: String(item.name || '').trim(),
      author: String(item.author || '').trim(),
      intro: String(item.intro || '').trim(),
      coverUrl: String(item.coverUrl || '').trim(),
      bookUrl: String(item.bookUrl || '').trim(),
    })) }
  }

  async applyBookMeta(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const meta = args.meta && typeof args.meta === 'object' ? args.meta : {}
    const next = {
      ...book,
      author: String(meta.author ?? book.author ?? '').trim(),
      intro: String(meta.intro ?? book.intro ?? '').trim(),
      coverUrl: String(meta.coverUrl ?? book.coverUrl ?? '').trim(),
      coverLocal: String(meta.coverUrl ?? '') === String(book.coverUrl ?? '') ? book.coverLocal : '',
      updatedAt: now(),
    }
    await this.db.books.put(next.id, next)
    const cached = await this.cacheCover(next)
    return this.bookView(cached)
  }

  async setSettings(args) {
    const partial = args ?? {}
    this.assertReady()
    assertObject(partial, 'settings')
    assertSettingKeys(partial)
    const settings = normalizeSettings(partial, this.db.settings.get())
    if (typeof settings.autoDownloadNewChapters !== 'boolean') throw new ReaderError('reader/invalid-settings', 'autoDownloadNewChapters must be boolean.')
    await this.db.settings.set(settings)
    return clone(settings)
  }

  // Per-book overrides only carry mode/flipStyle/ambience. Passing clear:true
  // (or null for a single key) drops the override so the book follows global
  // settings again. Everything else stays device-wide.
  async setBookSettings(args) {
    args ??= {}
    this.assertReady()
    assertObject(args)
    const book = this.book(args.bookId)
    const partial = {}
    for (const [key, value] of Object.entries(args)) {
      if (key === 'bookId' || key === 'clear') continue
      if (value === null) continue
      Object.assign(partial, normalizeReaderPrefs({ [key]: value }))
    }
    const prefs = args.clear === true ? {} : { ...(book.readerPrefs ?? {}), ...partial }
    if (args.clear !== true) {
      for (const [key, value] of Object.entries(args)) {
        if (value === null && key !== 'bookId' && key !== 'clear') delete prefs[key]
      }
    }
    const next = { ...book, updatedAt: now() }
    if (Object.keys(prefs).length) next.readerPrefs = prefs
    else delete next.readerPrefs
    await this.db.books.put(book.id, next)
    return clone({ bookId: book.id, readerPrefs: next.readerPrefs ?? null })
  }

  async saveNote(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const chapter = this.db.chapters.get(requiredString(args.chapterId, 'chapterId'))
    if (!chapter || chapter.bookId !== book.id) throw new ReaderError('reader/not-found', 'Note chapter does not belong to this book.')
    const text = requiredString(args.text, 'text', 100000)
    const timestamp = now()
    const previous = args.id === undefined ? undefined : this.db.notes.get(requiredString(args.id, 'id'))
    if (args.id !== undefined && !previous) throw new ReaderError('reader/not-found', 'Note not found.')
    if (previous && previous.bookId !== book.id) throw new ReaderError('reader/invalid-input', 'Cannot move a note to another book.')
    const color = args.color ?? previous?.color ?? '#f2c94c'
    if (typeof color !== 'string' || color.length > 32) throw new ReaderError('reader/invalid-input', 'Invalid note color.')
    const note = {
      id: previous?.id ?? id('note'),
      bookId: book.id,
      chapterId: chapter.id,
      text,
      quote: args.quote === undefined ? previous?.quote ?? '' : String(args.quote).slice(0, 100000),
      color,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    }
    await this.db.notes.put(note.id, note)
    return clone(note)
  }

  async deleteNote(args) {
    args ??= {}
    this.assertReady()
    const noteId = requiredString(args.id, 'id')
    if (!this.db.notes.get(noteId)) throw new ReaderError('reader/not-found', 'Note not found.')
    await this.db.notes.delete(noteId)
    return { removed: true, id: noteId }
  }

  async exportBackup() {
    this.assertReady()
    return createBackup({
      sources: entries(this.db.sources),
      books: entries(this.db.books),
      chapters: entries(this.db.chapters),
      settings: this.db.settings.get(),
      notes: entries(this.db.notes),
    })
  }

  async importBackup(args) {
    args ??= {}
    this.assertReady()
    if (this.runningJobs.size) throw new ReaderError('reader/busy', '请先取消或等待下载任务结束。')
    const backup = parseBackup(args.data)
    await this.db.jobs.deleteMany(entries(this.db.jobs).map(job => job.id))
    await this.db.chapters.deleteMany(entries(this.db.chapters).map(chapter => chapter.id))
    await this.db.notes.deleteMany(entries(this.db.notes).map(note => note.id))
    await this.db.books.deleteMany(entries(this.db.books).map(book => book.id))
    await this.db.sources.deleteMany(entries(this.db.sources).map(source => source.id))
    for (const source of backup.sources) await this.db.sources.put(source.id, source)
    for (const book of backup.books) await this.db.books.put(book.id, book)
    for (const chapter of backup.chapters) await this.db.chapters.put(chapter.id, chapter)
    for (const note of backup.notes) await this.db.notes.put(note.id, note)
    await this.db.settings.set({ ...DEFAULT_SETTINGS, ...backup.settings })
    return this.state()
  }
}

export default ReaderService


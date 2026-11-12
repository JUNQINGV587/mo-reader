import { Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createBackup, parseBackup } from './lib/backup.js'
import { hasChapterPayload, normalizeBookContentType, normalizeSourceContentType } from './lib/content-types.js'
import { ReaderError } from './lib/errors.js'
import { fetchRemote } from './lib/http.js'
import { MediaStore, DEFAULT_MEDIA_QUOTA } from './lib/media-store.js'
import { mediaResponse, proxyResponse, sendWebResponse } from './lib/media-http.js'
import { importEpub, importedSource, importTxt, exportEpub } from './lib/importers.js'
import { ACTIVE_JOBS, createJob, jobView, transitionJob } from './lib/jobs.js'

const MAX_PARALLEL_JOBS = 4
const MAX_PER_SOURCE_JOBS = 2
const MAX_CHAPTER_ATTEMPTS = 2
import { applyReplacements } from './lib/replacements.js'
import { assertSettingKeys, normalizeReaderPrefs, normalizeSettings } from './lib/settings.js'
import { normalizeSource } from './lib/rules.js'
import { BUILTIN_SOURCES } from './lib/builtin-sources.js'
import { SourceEngine } from './lib/source-engine.js'
import { parseSourceLibrary, permissionExpansion, planSourceRefresh } from './lib/subscription-refresh.js'
import { DEFAULT_SETTINGS, entries, openReaderStorage } from './lib/storage.js'
import { base64ToBuffer, clone, id, MAX_ARCHIVE_BYTES, MAX_TEXT_BYTES, now, pageNumber, requiredString, stableId, textToBuffer } from './lib/utils.js'

const COVER_MAX_BYTES = 2 * 1024 * 1024

export const REMOTE_METHODS = Object.freeze([
  'state', 'importSource', 'subscribeSourceLibrary', 'refreshSubscription', 'confirmSubscriptionUpdate', 'rejectSubscriptionUpdate', 'removeSubscription', 'restoreBuiltinSources', 'removeSource', 'setSourceEnabled', 'search', 'discover', 'addBook', 'removeBook', 'toc', 'chapter',
  'saveProgress', 'download', 'cancelJob', 'pauseJob', 'resumeJob', 'checkUpdates', 'importLocal', 'setSettings', 'setBookSettings', 'saveNote', 'deleteNote',
  'exportBackup', 'importBackup', 'fetchCover', 'cacheBookCover', 'bookCandidates', 'applyBookMeta',
  'createFolder', 'renameFolder', 'removeFolder', 'moveBooksToFolder', 'batchDeleteBooks', 'batchDownloadBooks', 'exportBook', 'markBookRead', 'exportNotes',
  'aiSummarize', 'aiTranslate', 'aiAsk',
  'mediaCacheStats', 'listMediaCache', 'setMediaRetained', 'removeMediaCache',
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
    this.subscriptionRefreshes = new Map()
    this.subscriptionMutations = new Map()
    this.coverCache = new Map()
    this.media = options.mediaStore ?? null
    this.mediaRoot = options.mediaRoot
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
    const settings = this.db.settings.get()
    this.media ??= new MediaStore({ root: this.mediaRoot, quotaBytes: settings.mediaQuotaBytes ?? DEFAULT_MEDIA_QUOTA })
    await this.media.init()
    await this.seedBuiltinSources()
    this.mediaRouteDisposers = []
    this.ctx.effect(() => async () => {
      this.disposed = true
      for (const job of entries(this.db.jobs)) {
        if (ACTIVE_JOBS.has(job.status)) await this.db.jobs.put(job.id, transitionJob(job, 'cancel'))
      }
      await Promise.allSettled([...this.runningJobs.values(), ...this.subscriptionRefreshes.values()])
      await this.media.queue.catch(() => {})
      await this.db.domain.close()
    }, 'reader: close storage and jobs')
    this.ctx.inject(['webServer', 'connection'], scope => this.registerMediaRoutes(scope))
    this.stopUpdates = this.ctx.interval(
      () => this.runMaintenance().catch(error => this.log('warn', 'Scheduled maintenance failed', error)),
      3_600_000,
    )
    for (const job of entries(this.db.jobs)) {
      if (job.status === 'running') await this.db.jobs.put(job.id, transitionJob(job, 'recover'))
    }
    try {
      await this.runMaintenance()
    } catch (error) {
      this.log('warn', 'Startup maintenance failed', error)
    }
    for (const job of entries(this.db.jobs)) if (job.status === 'queued') this.scheduleJob(job.id)
  }

  registerMediaRoutes(scope) {
    const guarded = (handler, methods) => async (req, res) => {
      const rejection = scope.connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (!methods.includes(req.method)) {
        res.statusCode = 405
        res.setHeader('allow', methods.join(', '))
        res.end()
        return
      }
      try {
        const request = new Request(new URL(req.url, 'http://reader.local'), { method: req.method, headers: req.headers })
        await sendWebResponse(await handler(request), res)
      } catch (error) {
        if (res.headersSent) res.destroy(error)
        else {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'reader/media-error', message: error?.message ?? '媒体请求失败。' }))
        }
      }
    }
    let disposed = false
    const dispose = () => {
      if (disposed) return
      disposed = true
      for (const unregister of this.mediaRouteDisposers.splice(0)) unregister()
    }
    this.mediaRouteDisposers.push(
      scope.webServer.register({
        kind: 'exact',
        path: '/api/reader/media',
        handler: guarded(req => mediaResponse(this.media, req), ['GET', 'HEAD']),
      }),
      scope.webServer.register({
        kind: 'exact',
        path: '/api/reader/proxy',
        handler: guarded(req => proxyResponse(this, req), ['GET']),
      }),
    )
    scope.effect(() => dispose)
  }

  async runMaintenance() {
    const [updates, subscriptions] = await Promise.allSettled([this.checkUpdates(), this.refreshSubscriptions()])
    if (updates.status === 'rejected') this.log('warn', 'Scheduled book update check failed', updates.reason)
    else for (const error of updates.value?.errors ?? []) this.log('warn', 'Book update failed', error)
    if (subscriptions.status === 'rejected') this.log('warn', 'Scheduled subscription refresh failed', subscriptions.reason)
    else for (const error of subscriptions.value?.errors ?? []) this.log('warn', 'Subscription refresh failed', error)
    return {
      updates: updates.status === 'fulfilled' ? updates.value : null,
      subscriptions: subscriptions.status === 'fulfilled' ? subscriptions.value : null,
    }
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

  source(sourceId, { allowDisabled = false } = {}) {
    const source = this.db.sources.get(requiredString(sourceId, 'sourceId'))
    if (!source) throw new ReaderError('reader/source-unavailable', `书源已不可用（${sourceId}）：可能已从订阅移除；已缓存的正文仍可阅读。`)
    if (!allowDisabled && source.enabled === false) throw new ReaderError('reader/source-disabled', `书源「${source.name}」已停用。`)
    return source
  }

  sourceView(source) {
    return { ...clone(source), enabled: source.enabled !== false, contentType: normalizeSourceContentType(source.contentType) }
  }

  withSubscriptionLock(id, operation) {
    const previous = this.subscriptionMutations.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.subscriptionMutations.set(id, next)
    return next.finally(() => {
      if (this.subscriptionMutations.get(id) === next) this.subscriptionMutations.delete(id)
    })
  }

  async withSubscriptionLocks(ids, operation) {
    const unique = [...new Set(ids)].sort()
    const run = async (index) => {
      if (index >= unique.length) return operation()
      return this.withSubscriptionLock(unique[index], () => run(index + 1))
    }
    return run(0)
  }

  async subscriptionMutation(id, operation) {
    const running = this.subscriptionRefreshes.get(id)
    if (running) await running.catch(() => {})
    return this.withSubscriptionLock(id, operation)
  }

  subscriptionView(subscription) {
    const { pending, ...rest } = subscription
    const view = { ...clone(rest), checking: this.subscriptionRefreshes.has(subscription.id) }
    if (pending) view.pending = { createdAt: pending.createdAt, permissions: clone(pending.permissions), changes: clone(pending.changes) }
    return view
  }

  async saveSource(source) {
    const previous = this.db.sources.get(source.id)
    const next = {
      ...source,
      enabled: previous ? previous.enabled !== false : source.enabled !== false,
      ...(previous?.builtin ? { builtin: true } : {}),
    }
    await this.db.sources.put(source.id, next)
    return next
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
      contentType: chapter.contentType,
      downloaded: hasChapterPayload(chapter, chapter.contentType),
      downloadedAt: chapter.downloadedAt,
    }
  }

  bookView(book) {
    const chapters = this.chapters(book.id)
    const contentType = normalizeBookContentType(book.contentType)
    const downloaded = chapters.filter(chapter => hasChapterPayload(chapter, contentType)).length
    const readIndex = book.progress ? chapters.findIndex(chapter => chapter.id === book.progress.chapterId) : -1
    const status = book.download?.status === 'completed' && downloaded < chapters.length ? 'partial' : book.download?.status ?? (downloaded ? 'partial' : 'none')
    return {
      ...clone(book),
      contentType: normalizeBookContentType(book.contentType),
      unread: Math.max(0, readIndex < 0 ? chapters.length : chapters.length - readIndex - 1),
      lastRead: clone(book.progress ?? null),
      readerPrefs: book.readerPrefs && Object.keys(book.readerPrefs).length ? clone(book.readerPrefs) : null,
      download: { status, total: chapters.length, done: downloaded, jobId: book.download?.jobId, auto: book.download?.auto === true },
    }
  }

  async state() {
    this.assertReady()
    return {
      sources: [importedSource(), ...entries(this.db.sources)].map(source => this.sourceView(source)),
      subscriptions: entries(this.db.subscriptions).map(subscription => this.subscriptionView(subscription)),
      books: entries(this.db.books).map(book => this.bookView(book)),
      folders: entries(this.db.folders).map(clone),
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
      const response = await this.fetchRemote(requiredString(args.url, 'url', 4096), { allowHttp: args.allowHttp === true, maxBytes: 2 * 1024 * 1024 })
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
      for (const source of imported) await this.saveSource(source)
      return { imported: imported.length, skipped, total: raw.length, names: imported.map(item => item.name) }
    }
    const source = normalizeSource(raw, { allowHttp: args.allowHttp === true })
    const saved = await this.saveSource(source)
    return { imported: 1, skipped: [], total: 1, names: [source.name], ...clone(saved) }
  }

  async removeSource(args) {
    args ??= {}
    this.assertReady()
    const source = this.source(args.id, { allowDisabled: true })
    if (source.builtin) throw new ReaderError('reader/unsupported-source', '内置书源不能删除，可以关闭。')
    if (entries(this.db.books).some(book => book.sourceId === source.id)) throw new ReaderError('reader/source-in-use', '请先从书架移除该书源的书籍。')
    const affected = entries(this.db.subscriptions).filter(subscription => subscription.sourceIds?.includes(source.id))
    return this.withSubscriptionLocks(affected.map(subscription => subscription.id), async () => {
      for (const original of affected) {
        const subscription = this.db.subscriptions.get(original.id) ?? original
        if (!subscription.sourceIds?.includes(source.id)) continue
        const pendingInvalid = subscription.pending?.candidates?.some(candidate => candidate.id === source.id)
        const next = {
          ...subscription,
          sourceIds: subscription.sourceIds.filter(id => id !== source.id),
          updatedAt: now(),
        }
        if (pendingInvalid) {
          delete next.pending
          next.status = 'ready'
        }
        await this.db.subscriptions.put(subscription.id, next)
      }
      await this.db.sources.delete(source.id)
      return { removed: true, id: source.id }
    })
  }

  async setSourceEnabled(args) {
    args ??= {}
    this.assertReady()
    const source = this.source(args.id, { allowDisabled: true })
    if (typeof args.enabled !== 'boolean') throw new ReaderError('reader/invalid-input', 'enabled 必须是布尔值。')
    const next = { ...source, enabled: args.enabled, updatedAt: now() }
    await this.db.sources.put(source.id, next)
    return this.sourceView(next)
  }

  async subscribeSourceLibrary(args) {
    args ??= {}
    this.assertReady()
    assertObject(args)
    const url = requiredString(args.url, 'url', 4096)
    const response = await this.fetchRemote(url, { allowHttp: args.allowHttp === true, maxBytes: 2 * 1024 * 1024 })
    let raw
    try {
      raw = JSON.parse(response.text)
    } catch (error) {
      throw new ReaderError('reader/invalid-source', '源库地址返回的不是有效 JSON。', undefined, { cause: error })
    }
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [raw]
    if (!items.length || items.length > 1000) throw new ReaderError('reader/invalid-source', '源库必须包含 1 到 1000 个书源。')
    const imported = []
    const skipped = []
    items.forEach((item, index) => {
      try {
        imported.push(normalizeSource(item, { allowHttp: args.allowHttp === true }))
      } catch (error) {
        skipped.push({ index, reason: error?.message || String(error) })
      }
    })
    if (!imported.length) {
      throw new ReaderError('reader/invalid-source', '源库里的书源都不符合规则，一个也没有导入。', undefined, { cause: skipped.length ? new Error(skipped[0].reason) : undefined })
    }
    for (const source of imported) await this.saveSource(source)
    const timestamp = now()
    const id = stableId('subscription', url)
    const previous = this.db.subscriptions.get(id)
    const subscription = {
      id,
      url,
      allowHttp: args.allowHttp === true,
      sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...imported.map(source => source.id)])],
      status: skipped.length ? 'partial' : 'ready',
      lastCheckedAt: timestamp,
      lastSuccessAt: skipped.length ? previous?.lastSuccessAt : timestamp,
      ...(skipped.length ? { lastFailureAt: timestamp } : {}),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      pending: undefined,
      ...(skipped.length ? { lastError: `${skipped.length} 个书源未通过校验` } : { lastError: undefined }),
    }
    await this.db.subscriptions.put(id, subscription)
    return {
      imported: imported.length,
      skipped,
      total: items.length,
      names: imported.map(source => source.name),
      subscription: clone(subscription),
    }
  }

  async refreshSubscription(args) {
    args ??= {}
    this.assertReady()
    const id = requiredString(args.id, 'id')
    const subscription = this.db.subscriptions.get(id)
    if (!subscription) throw new ReaderError('reader/not-found', '未找到这个订阅。')
    return this.runSubscriptionRefresh(subscription)
  }

  async refreshSubscriptions() {
    this.assertReady()
    const subscriptions = entries(this.db.subscriptions)
    const settled = await Promise.allSettled(subscriptions.map(subscription => this.runSubscriptionRefresh(subscription)))
    const errors = settled.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ id: subscriptions[index].id, message: outcome.reason?.message || String(outcome.reason) }]
      : [])
    return { checked: subscriptions.length, succeeded: settled.length - errors.length, failed: errors.length, errors }
  }

  runSubscriptionRefresh(subscription) {
    const running = this.subscriptionRefreshes.get(subscription.id)
    if (running) return running
    const task = this.withSubscriptionLock(subscription.id, () => this.performSubscriptionRefresh(subscription)).finally(() => {
      if (this.subscriptionRefreshes.get(subscription.id) === task) this.subscriptionRefreshes.delete(subscription.id)
    })
    this.subscriptionRefreshes.set(subscription.id, task)
    return task
  }

  buildSubscriptionPlan(subscription, candidates) {
    const allSubscriptions = entries(this.db.subscriptions)
    const otherOwned = new Set(allSubscriptions
      .filter(item => item.id !== subscription.id)
      .flatMap(item => item.sourceIds ?? []))
    const affected = new Set([...(subscription.sourceIds ?? []), ...candidates.map(source => source.id)])
    const existing = new Map([...affected].map(sourceId => [sourceId, this.db.sources.get(sourceId)]))
    return { plan: planSourceRefresh(subscription, candidates, existing, otherOwned), affected }
  }

  subscriptionAllowHttp(subscription) {
    return subscription.allowHttp === true
      || subscription.url.startsWith('http://')
      || (subscription.sourceIds ?? []).some(sourceId => this.db.sources.get(sourceId)?.bookSourceUrl?.startsWith('http://'))
  }

  async applySubscriptionPlan(subscription, candidates, checkedAt, allowHttp = this.subscriptionAllowHttp(subscription)) {
    const { plan } = this.buildSubscriptionPlan(subscription, candidates)
    const snapshotIds = new Set(subscription.sourceIds ?? [])
    const changedIds = new Set([...plan.writes.map(item => item.source.id), ...plan.deletes])
    const backups = new Map([...changedIds].map(sourceId => [sourceId, this.db.sources.get(sourceId) ? clone(this.db.sources.get(sourceId)) : undefined]))
    try {
      for (const item of plan.writes) await this.db.sources.put(item.source.id, item.source)
      for (const sourceId of plan.deletes) await this.db.sources.delete(sourceId)
      const succeededAt = now()
      const latest = this.db.subscriptions.get(subscription.id) ?? subscription
      const addedDuringRefresh = (latest.sourceIds ?? []).filter(sourceId => !snapshotIds.has(sourceId))
      const next = {
        ...latest,
        sourceIds: [...new Set([...plan.candidateIds, ...addedDuringRefresh])],
        allowHttp: allowHttp || latest.allowHttp === true || latest.url.startsWith('http://'),
        status: 'ready',
        lastCheckedAt: checkedAt,
        lastSuccessAt: succeededAt,
        lastFailureAt: undefined,
        lastError: undefined,
        updatedAt: succeededAt,
      }
      delete next.pending
      await this.db.subscriptions.put(subscription.id, next)
      return {
        added: plan.added,
        updated: plan.updated,
        removed: plan.removed,
        unchanged: plan.unchanged,
        subscription: clone(next),
      }
    } catch (error) {
      let rollbackFailed = false
      for (const [sourceId, previous] of backups) {
        try {
          if (previous) await this.db.sources.put(sourceId, previous)
          else await this.db.sources.delete(sourceId)
        } catch {
          rollbackFailed = true
        }
      }
      const latest = this.db.subscriptions.get(subscription.id) ?? subscription
      try {
        await this.db.subscriptions.put(subscription.id, latest)
      } catch {
        rollbackFailed = true
      }
      throw new ReaderError('reader/refresh-failed', rollbackFailed ? '订阅更新写入失败，旧版回滚未完成。' : '订阅更新写入失败，已保留旧版。', undefined, { cause: error })
    }
  }

  async performSubscriptionRefresh(subscription) {
    if (subscription.pending) {
      return {
        pending: true,
        permissions: clone(subscription.pending.permissions),
        changes: clone(subscription.pending.changes),
        subscription: clone(subscription),
      }
    }
    const checkedAt = now()
    const allowHttp = this.subscriptionAllowHttp(subscription)
    try {
      const response = await this.fetchRemote(subscription.url, { allowHttp, maxBytes: 2 * 1024 * 1024 })
      let raw
      try {
        raw = JSON.parse(response.text)
      } catch (error) {
        throw new ReaderError('reader/invalid-source', '源库地址返回的不是有效 JSON。', undefined, { cause: error })
      }
      const candidates = parseSourceLibrary(raw, { allowHttp })
      const activeSources = (subscription.sourceIds ?? []).map(sourceId => this.db.sources.get(sourceId)).filter(Boolean)
      const expansion = permissionExpansion(activeSources, candidates)
      if (expansion) {
        const { plan } = this.buildSubscriptionPlan(subscription, candidates)
        const latest = this.db.subscriptions.get(subscription.id) ?? subscription
        const pending = {
          createdAt: checkedAt,
          candidates: candidates.map(clone),
          permissions: expansion,
          changes: {
            added: plan.added,
            updated: plan.updated,
            removed: plan.removed,
            addedNames: plan.writes.filter(item => item.action === 'add').map(item => item.source.name),
            updatedNames: plan.writes.filter(item => item.action === 'update').map(item => item.source.name),
            removedNames: plan.deletes.map(sourceId => this.db.sources.get(sourceId)?.name).filter(Boolean),
          },
        }
        const next = {
          ...latest,
          status: 'pending',
          pending,
          lastCheckedAt: checkedAt,
          lastError: undefined,
          updatedAt: checkedAt,
        }
        await this.db.subscriptions.put(subscription.id, next)
        return { pending: true, permissions: clone(expansion), changes: clone(pending.changes), subscription: clone(next) }
      }
      return await this.applySubscriptionPlan(subscription, candidates, checkedAt, allowHttp)
    } catch (error) {
      const current = this.db.subscriptions.get(subscription.id) ?? subscription
      await this.db.subscriptions.put(subscription.id, {
        ...current,
        status: current.pending ? 'pending' : 'error',
        lastCheckedAt: checkedAt,
        lastFailureAt: checkedAt,
        lastError: String(error?.message || error).slice(0, 200),
        updatedAt: checkedAt,
      })
      throw error
    }
  }

  async confirmSubscriptionUpdate(args) {
    args ??= {}
    this.assertReady()
    const id = requiredString(args.id, 'id')
    return this.subscriptionMutation(id, async () => {
      const subscription = this.db.subscriptions.get(id)
      if (!subscription?.pending) throw new ReaderError('reader/not-found', '没有等待确认的订阅更新。')
      try {
        const result = await this.applySubscriptionPlan(subscription, subscription.pending.candidates, now())
        return { ...result, confirmed: true }
      } catch (error) {
        const current = this.db.subscriptions.get(id) ?? subscription
        await this.db.subscriptions.put(id, {
          ...current,
          status: 'pending',
          lastFailureAt: now(),
          lastError: String(error?.message || error).slice(0, 200),
          updatedAt: now(),
        })
        throw error
      }
    })
  }

  async rejectSubscriptionUpdate(args) {
    args ??= {}
    this.assertReady()
    const id = requiredString(args.id, 'id')
    return this.subscriptionMutation(id, async () => {
      const subscription = this.db.subscriptions.get(id)
      if (!subscription?.pending) throw new ReaderError('reader/not-found', '没有等待确认的订阅更新。')
      const { pending: _pending, ...rest } = subscription
      const next = { ...rest, status: 'ready', lastError: undefined, updatedAt: now() }
      await this.db.subscriptions.put(id, next)
      return { rejected: true, subscription: clone(next) }
    })
  }

  async removeSubscription(args) {
    args ??= {}
    this.assertReady()
    const id = requiredString(args.id, 'id')
    return this.subscriptionMutation(id, async () => {
      const subscription = this.db.subscriptions.get(id)
      if (!subscription) throw new ReaderError('reader/not-found', '未找到这个订阅。')
      await this.db.subscriptions.delete(id)
      return { removed: true, id, subscription: clone(subscription) }
    })
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
      contentType: normalizeBookContentType(source.contentType),
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
    await this.media?.removeBook(book.id)
    await this.db.notes.deleteMany(entries(this.db.notes).filter(note => note.bookId === book.id).map(note => note.id))
    await this.db.books.delete(book.id)
    return { removed: true, id: book.id }
  }

  async syncToc(book, fresh) {
    const old = new Map(this.chapters(book.id).map(chapter => [chapter.id, chapter]))
    const bookType = normalizeBookContentType(book.contentType)
    const chapters = fresh.map(chapter => {
      const cached = old.get(chapter.id)
      const next = { ...chapter, contentType: bookType }
      if (!cached) return next
      const preserved = {}
      for (const key of ['text', 'html', 'images', 'mediaUrl', 'headers', 'downloadedAt']) {
        if (cached[key] !== undefined) preserved[key] = cached[key]
      }
      return { ...next, ...preserved }
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
    const contentType = normalizeBookContentType(book.contentType)
    if (!hasChapterPayload(chapter, contentType)) {
      if (book.local) throw new ReaderError('reader/not-found', 'Local chapter cache is missing.')
      const content = await this.engine.content(this.source(book.sourceId), book, chapter)
      chapter = { ...chapter, ...content, downloadedAt: now() }
      await this.db.chapters.put(chapter.id, chapter)
    }
    const view = { ...this.chapterView(chapter), downloaded: true }
    if (contentType === 'novel') return { ...view, text: applyReplacements(chapter.text, this.db.settings.get().replacements) }
    for (const key of ['images', 'mediaUrl', 'headers']) if (chapter[key] !== undefined) view[key] = clone(chapter[key])
    return view
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
    if (!book.local) this.source(book.sourceId)
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
        if (!hasChapterPayload(chapter, book.contentType)) {
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
    const result = { checked: 0, skipped: 0, updated: 0, errors: [] }
    for (const original of entries(this.db.books).filter(book => !book.local)) {
      try {
        const source = this.source(original.sourceId, { allowDisabled: true })
        if (source.enabled === false) {
          result.skipped += 1
          continue
        }
        result.checked += 1
        const before = new Set(this.chapters(original.id).map(chapter => chapter.id))
        const fresh = await this.engine.toc(source, original)
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
    let enriched = { ...meta }
    if (meta.sourceId && meta.bookUrl) {
      let source = this.db.sources.get(meta.sourceId)
      if (source) source = this.source(meta.sourceId)
      if (source?.builtin && !source.rules?.bookInfo) {
        const raw = BUILTIN_SOURCES.find((item) => normalizeSource(item).id === source.id)
        if (raw) source = { ...source, rules: normalizeSource(raw).rules }
      }
      if (source) {
        try {
          const info = await this.engine.bookInfo(source, meta.bookUrl)
          for (const key of ['author', 'intro', 'coverUrl']) if (!enriched[key] && info[key]) enriched[key] = info[key]
        } catch (error) {
          this.log('warn', 'book info failed', error)
        }
      }
    }
    const next = {
      ...book,
      author: String(enriched.author ?? book.author ?? '').trim(),
      intro: String(enriched.intro ?? book.intro ?? '').trim(),
      coverUrl: String(enriched.coverUrl ?? book.coverUrl ?? '').trim(),
      coverLocal: String(enriched.coverUrl ?? '') === String(book.coverUrl ?? '') ? book.coverLocal : '',
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
    const previousQuota = this.db.settings.get().mediaQuotaBytes
    await this.media?.setQuotaBytes(settings.mediaQuotaBytes)
    try {
      await this.db.settings.set(settings)
    } catch (error) {
      await this.media?.setQuotaBytes(previousQuota)
      throw error
    }
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

  async exportNotes(args) {
    args ??= {}
    this.assertReady()
    const bookId = args.bookId
    const notes = entries(this.db.notes).filter(n => !bookId || n.bookId === bookId)
    const lines = []
    for (const note of notes) {
      const book = this.db.books.get(note.bookId)
      const chapter = this.db.chapters.get(note.chapterId)
      lines.push(`## ${book?.name || '未知书籍'} · ${chapter?.title || '未知章节'}\n`)
      if (note.quote) lines.push(`> ${note.quote}\n`)
      lines.push(`${note.text}\n`)
      lines.push(`---\n`)
    }
    return { text: lines.join('\n'), count: notes.length }
  }

  async createFolder(args) {
    args ??= {}
    this.assertReady()
    const name = requiredString(args.name, 'name', 200).trim()
    const folder = { id: id('folder'), name, createdAt: now() }
    await this.db.folders.put(folder.id, folder)
    return clone(folder)
  }

  async renameFolder(args) {
    args ??= {}
    this.assertReady()
    const folder = this.db.folders.get(requiredString(args.folderId, 'folderId'))
    if (!folder) throw new ReaderError('reader/not-found', 'Folder not found.')
    const next = { ...folder, name: requiredString(args.name, 'name', 200).trim() }
    await this.db.folders.put(next.id, next)
    return clone(next)
  }

  async removeFolder(args) {
    args ??= {}
    this.assertReady()
    const folder = this.db.folders.get(requiredString(args.folderId, 'folderId'))
    if (!folder) throw new ReaderError('reader/not-found', 'Folder not found.')
    // Move all books in this folder back to root
    for (const book of entries(this.db.books)) {
      if (book.folderId === folder.id) await this.db.books.put(book.id, { ...book, folderId: undefined, updatedAt: now() })
    }
    await this.db.folders.delete(folder.id)
    return { removed: true, id: folder.id }
  }

  async moveBooksToFolder(args) {
    args ??= {}
    this.assertReady()
    const folderId = args.folderId === null || args.folderId === undefined ? undefined : requiredString(args.folderId, 'folderId')
    if (folderId && !this.db.folders.get(folderId)) throw new ReaderError('reader/not-found', 'Folder not found.')
    const bookIds = Array.isArray(args.bookIds) ? args.bookIds : [args.bookId]
    if (!bookIds.length) throw new ReaderError('reader/invalid-input', 'No books selected.')
    const moved = []
    for (const bookId of bookIds) {
      const book = this.book(bookId)
      await this.db.books.put(book.id, { ...book, folderId, updatedAt: now() })
      moved.push(bookId)
    }
    return { moved, folderId }
  }

  async batchDeleteBooks(args) {
    args ??= {}
    this.assertReady()
    const bookIds = Array.isArray(args.bookIds) ? args.bookIds : [args.bookId]
    if (!bookIds.length) throw new ReaderError('reader/invalid-input', 'No books selected.')
    const removed = []
    for (const bookId of bookIds) {
      const book = this.db.books.get(bookId)
      if (!book) continue
      await this.removeBook({ bookId })
      removed.push(bookId)
    }
    return { removed }
  }

  async batchDownloadBooks(args) {
    args ??= {}
    this.assertReady()
    const bookIds = Array.isArray(args.bookIds) ? args.bookIds : [args.bookId]
    if (!bookIds.length) throw new ReaderError('reader/invalid-input', 'No books selected.')
    const queued = []
    for (const bookId of bookIds) {
      const book = this.db.books.get(bookId)
      if (!book) continue
      const job = await this.download({ bookId })
      queued.push({ bookId, jobId: job.id })
    }
    return { queued }
  }

  async exportBook(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const format = args.format || 'txt'
    const chapters = this.chapters(book.id)
    if (!chapters.length) throw new ReaderError('reader/invalid-input', '这本书还没有章节。')
    if (format === 'txt' || format === 'md') {
      const lines = []
      for (const chapter of chapters) {
        if (format === 'md') lines.push(`\n\n# ${chapter.title}\n\n`)
        else lines.push(`\n\n${chapter.title}\n\n`)
        if (typeof chapter.text === 'string') lines.push(chapter.text)
      }
      return { name: book.name, format, text: lines.join('') }
    }
    if (format === 'epub') {
      const buffer = await exportEpub(book, chapters)
      return { name: book.name, format, base64: buffer.toString('base64') }
    }
    throw new ReaderError('reader/invalid-input', `不支持的导出格式 ${format}，目前只支持 txt、md 和 epub。`)
  }

  async markBookRead(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    await this.db.books.put(book.id, { ...book, readAt: now(), updatedAt: now() })
    return this.bookView(this.book(book.id))
  }

  async exportBackup() {
    this.assertReady()
    return createBackup({
      sources: entries(this.db.sources),
      books: entries(this.db.books),
      chapters: entries(this.db.chapters),
      settings: this.db.settings.get(),
      notes: entries(this.db.notes),
      subscriptions: entries(this.db.subscriptions),
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
    await this.db.subscriptions.deleteMany(entries(this.db.subscriptions).map(subscription => subscription.id))
    for (const source of backup.sources) await this.db.sources.put(source.id, source)
    for (const subscription of backup.subscriptions) await this.db.subscriptions.put(subscription.id, subscription)
    for (const book of backup.books) await this.db.books.put(book.id, book)
    for (const chapter of backup.chapters) await this.db.chapters.put(chapter.id, chapter)
    for (const note of backup.notes) await this.db.notes.put(note.id, note)
    await this.db.settings.set({ ...DEFAULT_SETTINGS, ...backup.settings })
    return this.state()
  }

  mediaEntryView(record) {
    return {
      ...clone(record),
      url: `/api/reader/media?id=${encodeURIComponent(record.id)}`,
    }
  }

  async mediaCacheStats(args) {
    args ??= {}
    this.assertReady()
    return { ...this.media.stats(), entries: this.media.list().length }
  }

  async listMediaCache(args) {
    args ??= {}
    this.assertReady()
    const bookId = args.bookId === undefined ? undefined : requiredString(args.bookId, 'bookId')
    return this.media.list({ bookId }).map(record => this.mediaEntryView(record))
  }

  async setMediaRetained(args) {
    args ??= {}
    this.assertReady()
    const record = await this.media.setRetained(requiredString(args.id, 'id'), args.retained)
    return this.mediaEntryView(record)
  }

  async removeMediaCache(args) {
    args ??= {}
    this.assertReady()
    const removed = await this.media.remove(requiredString(args.id, 'id'))
    return { removed }
  }

  // AI 助手：摘要、翻译、问答
  async aiSummarize(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const chapters = this.chapters(book.id)
    const text = chapters.map(c => c.text || c.content || '').filter(Boolean).join('\n\n').slice(0, 8000)
    if (!text) throw new ReaderError('reader/invalid-input', '这本书还没有内容。')
    const result = await this.callLlm(`请用中文总结以下书籍内容，100字以内：\n\n${text}`)
    return { summary: result }
  }

  async aiTranslate(args) {
    args ??= {}
    this.assertReady()
    const text = String(args.text || '').slice(0, 4000)
    const target = args.target || 'zh'
    if (!text) throw new ReaderError('reader/invalid-input', '没有要翻译的内容。')
    const lang = target === 'zh' ? '中文' : target === 'en' ? '英文' : target
    const result = await this.callLlm(`请将以下内容翻译成${lang}，保持原意：\n\n${text}`)
    return { translated: result }
  }

  async aiAsk(args) {
    args ??= {}
    this.assertReady()
    const book = this.book(args.bookId)
    const question = String(args.question || '').trim()
    if (!question) throw new ReaderError('reader/invalid-input', '请输入问题。')
    const chapters = this.chapters(book.id)
    const context = chapters.slice(0, 3).map(c => c.text || c.content || '').filter(Boolean).join('\n\n').slice(0, 6000)
    const result = await this.callLlm(`基于以下书籍内容回答问题：\n\n${context}\n\n问题：${question}\n\n请用中文回答：`)
    return { answer: result }
  }

  async callLlm(prompt) {
    if (!this.ctx.llm) throw new ReaderError('reader/ai-unavailable', 'AI 服务不可用。')
    try {
      const chunks = []
      for await (const chunk of this.ctx.llm.stream({ messages: [{ role: 'user', content: prompt }] })) {
        if (chunk.type === 'text') chunks.push(chunk.text)
      }
      return chunks.join('').trim()
    } catch (error) {
      throw new ReaderError('reader/ai-error', `AI 调用失败：${error.message}`)
    }
  }
}

export default ReaderService


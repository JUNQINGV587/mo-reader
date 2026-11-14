import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, parseBackup } from '../lib/backup.js'
import { createJob, transitionJob } from '../lib/jobs.js'
import { stableId } from '../lib/utils.js'

test('persistent download state machine supports queue, recovery, progress and cancellation', () => {
  const created = createJob({ bookId: 'b1', total: 2 })
  assert.equal(created.status, 'queued')
  const running = transitionJob(created, 'start')
  assert.equal(running.status, 'running')
  const progressed = transitionJob(running, 'chapter')
  assert.equal(progressed.done, 1)
  assert.equal(progressed.status, 'running')
  const recovered = transitionJob(running, 'recover')
  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.done, 0)
  const completed = transitionJob(transitionJob(running, 'chapter'), 'complete')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.done, 2)
  assert.equal(transitionJob(running, 'cancel').status, 'cancelled')
  assert.throws(() => transitionJob(completed, 'start'), /Cannot start/)
  assert.throws(() => transitionJob(completed, 'fail'), /Cannot fail/)
})

test('backup allowlists records and strips secrets instead of exporting them', () => {
  const sourceId = stableId('source', 'https://example.com')
  const json = createBackup({
    sources: [{ id: sourceId, name: 'S', bookSourceUrl: 'https://example.com', allowHttp: false, token: 'drop-me', rules: { search: { url: '/s', headers: { Authorization: 'Bearer drop-me', Accept: 'application/json' } } } }],
    books: [{ id: 'b', sourceId, bookUrl: 'https://example.com/b', name: 'B', secret: 'drop-me', progress: { chapterId: 'c', offset: 4, percent: 50 } }],
    chapters: [{ id: 'c', bookId: 'b', index: 0, title: 'C', url: 'https://example.com/c', text: 'raw cache', cookie: 'drop-me' }],
    settings: { replacements: [{ type: 'text', pattern: 'x', replacement: 'y' }], autoDownloadNewChapters: true, password: 'drop-me' },
    notes: [{ id: 'n', bookId: 'b', chapterId: 'c', text: 'note', token: 'drop-me' }],
    subscriptions: [{ id: 'sub', url: 'https://user:pass@example.com/sources.json?token=drop-me&mirror=1#frag', sourceIds: [sourceId], status: 'error', allowHttp: true, lastCheckedAt: '2026-11-11T08:00:00.000Z', lastFailureAt: '2026-11-11T08:00:00.000Z', lastError: 'drop-me', createdAt: '2026-11-11T08:00:00.000Z', runtime: { code: 'drop-me' }, token: 'drop-me' }],
  })
  assert.equal(json.includes('drop-me'), false)
  assert.equal(json.includes('Authorization'), false)
  assert.equal(json.includes('password'), false)
  const parsed = parseBackup(json)
  assert.equal(parsed.chapters[0].text, 'raw cache')
  assert.equal(parsed.sources[0].rules.search.headers.Accept, 'application/json')
  assert.deepEqual(parsed.subscriptions, [{ id: 'sub', url: 'https://example.com/sources.json?mirror=1', sourceIds: [sourceId], status: 'error', allowHttp: true, lastCheckedAt: '2026-11-11T08:00:00.000Z', lastFailureAt: '2026-11-11T08:00:00.000Z', createdAt: '2026-11-11T08:00:00.000Z' }])
  assert.equal(json.includes('lastError'), false, '运行期错误详情不进入备份')
  assert.deepEqual(parseBackup(JSON.parse(json)), parsed)
})

test('backup keeps subscription anchors and dates but drops runtime anchor errors', () => {
  const json = createBackup({
    sources: [],
    books: [{
      id: 'b', sourceId: 's', bookUrl: 'https://example.com/b', name: 'B', contentType: 'subscription',
      subscription: { sourceId: 's', anchorUrl: 'https://example.com/post/2', anchorError: '发布时间不完整' },
    }],
    chapters: [{ id: 'c', bookId: 'b', index: 0, title: 'C', url: 'https://example.com/post/2', text: '正文', publishedAt: '2026-11-12', readAt: '2026-11-13T00:00:00.000Z' }],
    settings: {},
    notes: [],
  })
  assert.equal(json.includes('发布时间不完整'), false)
  const parsed = parseBackup(json)
  assert.equal(parsed.books[0].subscription.anchorUrl, 'https://example.com/post/2')
  assert.equal(parsed.books[0].subscription.anchorError, undefined)
  assert.equal(parsed.chapters[0].publishedAt, '2026-11-12')
  assert.equal(parsed.chapters[0].readAt, '2026-11-13T00:00:00.000Z')
})

test('backup keeps subscription categories, anchor and read state but no media cache or cookies', () => {
  const sourceId = 'rss-source-id'
  const json = createBackup({
    sources: [{
      id: sourceId,
      name: '订阅源',
      bookSourceUrl: 'https://feed.example/rss.xml',
      kind: 'rss',
      feed: true,
      categories: [{ name: '分类', url: 'https://feed.example/rss.xml' }],
      headers: { Cookie: 'secret' },
      rules: {},
    }],
    books: [{
      id: 'b',
      sourceId,
      bookUrl: 'https://feed.example/rss.xml',
      name: '订阅',
      contentType: 'subscription',
      subscription: {
        sourceId,
        sourceName: '订阅源',
        categoryName: '分类',
        sortUrl: 'https://feed.example/rss.xml',
        anchorUrl: 'https://feed.example/post/2',
      },
      readBaselineAt: '2026-11-13T00:00:00.000Z',
      latestChapter: '条目 2',
    }],
    chapters: [{
      id: 'c',
      bookId: 'b',
      index: 0,
      title: '条目 2',
      url: 'https://feed.example/post/2',
      text: '正文',
      readAt: '2026-11-13T01:00:00.000Z',
      mediaUrl: 'https://media.example/video.mp4',
      images: ['https://media.example/image.jpg'],
      blocks: [{ type: 'paragraph', text: '正文' }],
      offline: { path: '/cache/video.mp4' },
      headers: { Cookie: 'secret' },
      downloadedAt: '2026-11-13T01:00:00.000Z',
    }],
    settings: {},
    notes: [],
  })
  assert.equal(json.includes('Cookie'), false)
  assert.equal(json.includes('mediaUrl'), false)
  assert.equal(json.includes('images'), false)
  assert.equal(json.includes('offline'), false)
  const parsed = parseBackup(json)
  assert.equal(parsed.sources[0].feed, true)
  assert.deepEqual(parsed.sources[0].categories, [{ name: '分类', url: 'https://feed.example/rss.xml' }])
  assert.equal(parsed.books[0].subscription.anchorUrl, 'https://feed.example/post/2')
  assert.equal(parsed.books[0].readBaselineAt, '2026-11-13T00:00:00.000Z')
  assert.equal(parsed.books[0].latestChapter, '条目 2')
  assert.equal(parsed.chapters[0].readAt, '2026-11-13T01:00:00.000Z')
  assert.equal(parsed.chapters[0].mediaUrl, undefined)
})

test('backup accepts a subscription media entry without text', () => {
  const json = createBackup({
    sources: [{
      id: 's',
      name: '订阅源',
      bookSourceUrl: 'https://feed.example',
      kind: 'rss',
      categories: [{ name: '分类', url: 'https://feed.example' }],
      rules: {},
    }],
    books: [{
      id: 'b',
      sourceId: 's',
      bookUrl: 'https://feed.example',
      name: '订阅',
      contentType: 'subscription',
      subscription: { sourceId: 's', categoryName: '分类', sortUrl: 'https://feed.example' },
    }],
    chapters: [{
      id: 'c',
      bookId: 'b',
      index: 0,
      title: '视频条目',
      url: 'https://feed.example/post/1',
      publishedAt: '2026-11-14',
      readAt: '2026-11-14T01:00:00.000Z',
      mediaUrl: 'https://media.example/live.m3u8',
      mediaHls: true,
    }],
    settings: {},
    notes: [],
  })
  const parsed = parseBackup(json)
  assert.equal(parsed.chapters.length, 1)
  assert.equal(parsed.chapters[0].text, undefined)
  assert.equal(parsed.chapters[0].url, 'https://feed.example/post/1')
  assert.equal(parsed.chapters[0].readAt, '2026-11-14T01:00:00.000Z')
})

test('backup still rejects a novel chapter without text', () => {
  const json = createBackup({
    sources: [{ id: 's', name: '书源', bookSourceUrl: 'https://novel.example', rules: {} }],
    books: [{ id: 'b', sourceId: 's', bookUrl: 'https://novel.example/book/1', name: '小说' }],
    chapters: [{ id: 'c', bookId: 'b', index: 0, title: '第一章', url: 'https://novel.example/chapter/1' }],
    settings: {},
    notes: [],
  })
  assert.throws(() => parseBackup(json), /引用或内容无效/)
})

test('a version-1 backup without subscription fields still imports', () => {
  const old = {
    type: 'modu-reader-backup',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sources: [{ id: 's', name: '旧源', bookSourceUrl: 'https://old.example', rules: {} }],
    books: [{ id: 'b', sourceId: 's', bookUrl: 'https://old.example/book', name: '旧书' }],
    chapters: [{ id: 'c', bookId: 'b', index: 0, title: '第一章', url: 'https://old.example/c', text: '旧正文' }],
    notes: [],
    settings: {},
  }
  const parsed = parseBackup(old)
  assert.equal(parsed.books[0].contentType, 'novel')
  assert.equal(parsed.books[0].subscription, undefined)
  assert.equal(parsed.chapters[0].text, '旧正文')
  assert.equal(parsed.subscriptions.length, 0)
})

test('backup import rejects secrets and malformed references', () => {
  assert.throws(() => parseBackup('{"type":"modu-reader-backup","version":1,"token":"x"}'), /must not contain secrets/)
  assert.throws(() => parseBackup('{}'), /格式或版本/)
  assert.throws(() => parseBackup(undefined), /data 必须/)
})

test('backup never carries an unconfirmed candidate snapshot', () => {
  const json = createBackup({
    sources: [],
    books: [],
    chapters: [],
    settings: {},
    notes: [],
    subscriptions: [{
      id: 'sub', url: 'https://example.com/sources.json', sourceIds: [], status: 'pending',
      pending: { candidates: [{ name: '候选', bookSourceUrl: 'https://new.example', rules: {} }], permissions: { origins: ['https://new.example'], capabilities: ['js'] } },
    }],
  })
  assert.equal(json.includes('候选'), false)
  assert.equal(json.includes('pending'), false)
  const parsed = parseBackup(json)
  assert.equal(parsed.subscriptions[0].status, 'ready')
  assert.equal(parsed.subscriptions[0].pending, undefined)
})

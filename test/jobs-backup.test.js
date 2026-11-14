import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, parseBackup } from '../lib/backup.js'
import { createJob, transitionJob } from '../lib/jobs.js'
import { stableId } from '../lib/utils.js'
import { serviceFixture, source } from './helpers.js'

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

test('backup scrubs credentials from subscription header values but keeps ordinary headers', () => {
  const token = 'header-token-must-not-leak'
  const json = createBackup({
    sources: [{
      id: 'rss-source-id',
      name: '订阅源',
      bookSourceUrl: 'https://feed.example/rss.xml',
      kind: 'rss',
      categories: [{ name: '分类', url: 'https://feed.example/rss.xml' }],
      headers: {
        'user-agent': 'ExampleFeed/1.0',
        referer: 'https://feed.example/post/1?token=' + token + '&lang=zh#player',
        accept: 'application/json',
        cookie: 'session=' + token,
        authorization: 'Bearer ' + token,
        'x-preview': 'Bearer ' + token,
        'x-scheme': 'Token ' + token,
      },
      rules: {},
    }],
    books: [],
    chapters: [],
    settings: {},
    notes: [],
  })
  assert.equal(json.includes(token), false)
  assert.equal(JSON.parse(json).version, 2)
  const parsed = parseBackup(json)
  assert.deepEqual(parsed.sources[0].headers, {
    'user-agent': 'ExampleFeed/1.0',
    referer: 'https://feed.example/post/1?lang=zh',
    accept: 'application/json',
  })
})

test('feed backups drop headers and unsupported while rule subscriptions keep cleaned headers', () => {
  const json = createBackup({
    sources: [
      {
        id: 'feed-source-id',
        name: 'Feed',
        bookSourceUrl: 'https://feed.example/rss.xml',
        kind: 'rss',
        feed: true,
        categories: [{ name: '分类', url: 'https://feed.example/rss.xml' }],
        headers: {
          referer: 'https://feed.example/post/1?token=drop-me&lang=zh',
          accept: 'application/rss+xml',
        },
        unsupported: ['login'],
        rules: {},
      },
      {
        id: 'rule-source-id',
        name: '规则订阅',
        bookSourceUrl: 'https://rule.example/list',
        kind: 'rss',
        categories: [{ name: '分类', url: 'https://rule.example/list' }],
        headers: {
          referer: 'https://rule.example/post/1?token=drop-me&lang=zh',
          accept: 'text/html',
        },
        unsupported: ['login'],
        rules: { toc: { chapterList: '.entry' }, content: { content: '#player' } },
      },
    ],
    books: [],
    chapters: [],
    settings: {},
    notes: [],
  })
  const exported = JSON.parse(json)
  const feedSource = exported.sources.find((source) => source.feed === true)
  assert.equal(Object.hasOwn(feedSource, 'headers'), false)
  assert.equal(Object.hasOwn(feedSource, 'unsupported'), false)
  const ruleSource = exported.sources.find((source) => source.id === 'rule-source-id')
  assert.deepEqual(ruleSource.headers, {
    referer: 'https://rule.example/post/1?lang=zh',
    accept: 'text/html',
  })
  assert.deepEqual(ruleSource.unsupported, ['login'])
  const parsed = parseBackup(json)
  const restoredRule = parsed.sources.find((source) => source.kind === 'rss' && source.feed !== true)
  assert.equal(restoredRule.headers.referer, 'https://rule.example/post/1?lang=zh')
  assert.deepEqual(restoredRule.unsupported, ['login'])
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

test('a feed backup restores a summarized entry but rejects a link-only entry', () => {
  const source = {
    id: 'feed-source-id',
    name: 'Feed',
    bookSourceUrl: 'https://feed.example/rss.xml',
    kind: 'rss',
    feed: true,
    categories: [{ name: '分类', url: 'https://feed.example/rss.xml' }],
    rules: {},
  }
  const book = {
    id: 'b',
    sourceId: source.id,
    bookUrl: source.bookSourceUrl,
    name: '订阅',
    contentType: 'subscription',
    subscription: { sourceId: source.id, sourceName: 'Feed', categoryName: '分类', sortUrl: source.bookSourceUrl },
  }
  const backup = (chapter) => createBackup({
    sources: [source],
    books: [book],
    chapters: [{ ...chapter, bookId: 'b', index: 0 }],
    settings: {},
    notes: [],
  })

  const summarized = parseBackup(backup({
    id: 'c1',
    title: '摘要条目',
    url: 'https://feed.example/post/1',
    description: '<p>摘要</p>',
  }))
  assert.equal(summarized.chapters.length, 1)
  assert.equal(summarized.chapters[0].description, '<p>摘要</p>')

  assert.throws(
    () => parseBackup(backup({ id: 'c2', title: '只有链接', url: 'https://feed.example/post/2' })),
    (error) => error.code === 'reader/invalid-backup' && /摘要/.test(error.message),
  )
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

test('backup rejects text-less chapters for every non-subscription content type', async () => {
  for (const contentType of ['novel', 'comic', 'audio', 'video']) {
    const bookId = `book-${contentType}`
    const backup = createBackup({
      sources: [source],
      books: [{ id: bookId, sourceId: source.id, bookUrl: `https://example.com/${contentType}`, name: contentType, contentType }],
      chapters: [{ id: `chapter-${contentType}`, bookId, index: 0, title: '缺正文', url: `https://example.com/${contentType}/1` }],
      settings: {},
      notes: [],
    })
    const { service, db } = await serviceFixture()
    await assert.rejects(
      () => service.importBackup({ data: backup }),
      (error) => error.code === 'reader/invalid-backup' && /引用或内容无效/.test(error.message),
      `${contentType} 作品缺正文应被拒绝`,
    )
    assert.equal(db.sources.size, 0, `${contentType} 备份被拒绝后不应留下源`)
    assert.equal(db.books.size, 0, `${contentType} 备份被拒绝后不应留下作品`)
    assert.equal(db.chapters.size, 0, `${contentType} 备份被拒绝后不应留下章节`)
  }
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

test('backup round trip keeps chapter id, title, url, publishedAt and readAt through the service', async () => {
  const { service: exporter, db: sourceDb } = await serviceFixture()
  await sourceDb.sources.put(source.id, source)
  const book = { id: 'book-meta', sourceId: source.id, bookUrl: 'https://example.com/book/meta', name: '元数据', contentType: 'novel' }
  await sourceDb.books.put(book.id, book)
  const chapter = {
    id: 'chapter-meta',
    bookId: book.id,
    index: 0,
    title: '带元数据的章节',
    url: 'https://example.com/chapter/meta',
    text: '正文',
    publishedAt: '2026-11-01T08:30:00.000Z',
    readAt: '2026-11-02T09:45:00.000Z',
  }
  await sourceDb.chapters.put(chapter.id, chapter)

  const backup = await exporter.exportBackup()
  const { service: importer, db: restoredDb } = await serviceFixture()
  await importer.importBackup({ data: backup })

  const restored = restoredDb.chapters.get(chapter.id)
  assert.ok(restored, '恢复后应保留原条目 ID')
  assert.equal(restored.id, chapter.id)
  assert.equal(restored.title, chapter.title)
  assert.equal(restored.url, chapter.url)
  assert.equal(restored.publishedAt, chapter.publishedAt)
  assert.equal(restored.readAt, chapter.readAt)
})

test('a version-1 backup round trips through the service and repeated restore does not duplicate records', async () => {
  const oldSourceId = stableId('source', 'https://old.example')
  const old = {
    type: 'modu-reader-backup',
    version: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sources: [{ id: oldSourceId, name: '旧源', bookSourceUrl: 'https://old.example', rules: {} }],
    books: [{ id: 'old-book', sourceId: oldSourceId, bookUrl: 'https://old.example/book', name: '旧书' }],
    chapters: [{ id: 'old-chapter', bookId: 'old-book', index: 0, title: '第一章', url: 'https://old.example/c', text: '旧正文' }],
    notes: [],
    settings: {},
  }
  const data = JSON.stringify(old)
  const { service, db } = await serviceFixture()
  await service.importBackup({ data })
  await service.importBackup({ data })

  assert.equal(db.sources.size, 1)
  assert.equal(db.books.size, 1)
  assert.equal(db.chapters.size, 1)
  assert.equal(db.sources.get(oldSourceId).name, '旧源')
  assert.equal(db.books.get('old-book').name, '旧书')
  assert.equal(db.chapters.get('old-chapter').text, '旧正文')
})

test('a failed restore rolls back sources, books and chapters instead of leaving a partial import', async () => {
  const { service, db } = await serviceFixture()
  await db.sources.put(source.id, source)
  const oldBook = { id: 'old-book', sourceId: source.id, bookUrl: 'https://example.com/old', name: '旧书', contentType: 'novel' }
  await db.books.put(oldBook.id, oldBook)
  const oldChapter = { id: 'old-chapter', bookId: oldBook.id, index: 0, title: '旧章', url: 'https://example.com/old/1', text: '旧正文' }
  await db.chapters.put(oldChapter.id, oldChapter)

  const backupUrl = 'https://backup.example'
  const backupSource = { ...source, id: stableId('source', backupUrl), bookSourceUrl: backupUrl, rules: {} }
  const backupBook = { id: 'new-book', sourceId: backupSource.id, bookUrl: backupUrl + '/book', name: '新书', contentType: 'novel' }
  const backupChapter = { id: 'new-chapter', bookId: backupBook.id, index: 0, title: '新章', url: backupUrl + '/c', text: '新正文' }
  const backup = createBackup({ sources: [backupSource], books: [backupBook], chapters: [backupChapter], settings: {}, notes: [] })

  const originalPut = db.chapters.put.bind(db.chapters)
  db.chapters.put = async (key, value) => {
    if (key === backupChapter.id) throw new Error('simulated write failure')
    return originalPut(key, value)
  }
  await assert.rejects(
    () => service.importBackup({ data: backup }),
    (error) => error.code === 'reader/restore-failed' && /已保留原有数据/.test(error.message),
  )

  assert.equal(db.sources.size, 1)
  assert.equal(db.books.size, 1)
  assert.equal(db.chapters.size, 1)
  assert.equal(db.sources.get(source.id).name, source.name)
  assert.equal(db.books.get(oldBook.id).name, oldBook.name)
  assert.equal(db.chapters.get(oldChapter.id).text, oldChapter.text)
  assert.equal(db.sources.get(backupSource.id), undefined)
  assert.equal(db.books.get(backupBook.id), undefined)
  assert.equal(db.chapters.get(backupChapter.id), undefined)

  db.chapters.put = originalPut
  await service.importBackup({ data: backup })
  assert.equal(db.sources.size, 1)
  assert.equal(db.books.size, 1)
  assert.equal(db.chapters.size, 1)
  assert.equal(db.chapters.get(backupChapter.id).title, backupChapter.title)
})

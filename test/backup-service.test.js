import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

const EXPORT_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-backup-'))
process.env.MO_READER_EXPORT_ROOT = EXPORT_ROOT

const { ReaderService } = await import('../dist/server/service.js')
const { BACKUP_TOKEN_TTL_MS } = await import('../dist/core/reader/backup.js')

/**
 * 整包备份（#130）的服务端测试：假数据表 + 临时导出目录，不联网、不起端口。
 * 覆盖 zip 内容与 manifest 计数、未知字段保留、轻量备份、封面阈值、
 * 一次性 token 的过期与已用提示、取消不留半成品、失败可读且可重试。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const SMALL_PNG = Buffer.from(PNG_BASE64, 'base64')
const OVERSIZE_PNG = Buffer.concat([Buffer.from(PNG_BASE64, 'base64'), Buffer.alloc(3 * 1024 * 1024, 1)])

function fakeTable(records = []) {
  const map = new Map()
  for (const record of records) map.set(record.id, record)
  return {
    map,
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

function seedBooks() {
  return [
    {
      id: 'book-a',
      name: '小封面',
      author: '甲',
      group: '玄幻',
      coverUrl: `data:image/png;base64,${PNG_BASE64}`,
      bookUrl: 'https://example.com/a',
      origin: 'https://example.com',
      legacyFlag: 'keep-me',
    },
    {
      id: 'book-b',
      name: '超大封面',
      author: '乙',
      group: '玄幻',
      coverUrl: `data:image/png;base64,${OVERSIZE_PNG.toString('base64')}`,
      bookUrl: 'https://example.com/b',
      origin: 'https://example.com',
    },
    {
      id: 'book-c',
      name: '无封面',
      author: '丙',
      group: '都市',
      bookUrl: 'https://example.com/c',
      origin: 'https://example.com',
    },
  ]
}

async function makeService(overrides = {}) {
  const books = fakeTable(overrides.books ?? seedBooks())
  const sources = fakeTable([
    { id: 'src-a', bookSourceUrl: 'https://a.example', bookSourceName: '源 A' },
    { id: 'src-b', bookSourceUrl: 'https://b.example', bookSourceName: '源 B' },
  ])
  const db = {
    books,
    chapters: fakeTable(),
    sources,
    groups: fakeTable(),
    dictRules: fakeTable([{ id: 'dict-1', name: '词典', rules: [{ pattern: '甲', replacement: '乙' }] }]),
    notes: fakeTable([
      { id: 'note-1', bookId: 'book-a', content: '想法一' },
      { id: 'note-2', bookId: 'book-a', content: '想法二' },
    ]),
    bookmarks: fakeTable([{ id: 'mark-1', bookId: 'book-a', chapterIndex: 2 }]),
    readRecords: fakeTable([
      { id: 'book-a', bookId: 'book-a', chapterIndex: 5, readMs: 60000 },
      { id: 'book-b', bookId: 'book-b', chapterIndex: 1, readMs: 1000 },
      { id: 'book-c', bookId: 'book-c', chapterIndex: 0, readMs: 0 },
    ]),
    readConfigs: fakeTable([{ id: 'book-a', bookId: 'book-a', fontSize: 28 }]),
    jobs: fakeTable(),
    downloadEntries: fakeTable(),
    mediaEntries: fakeTable(),
    subscriptions: fakeTable([
      { id: 'src-rss-1', sourceUrl: 'https://rss.example/feed.xml', sourceName: '示例 RSS', enabled: true },
      { id: 'sub-1', name: '某订阅', url: 'https://example.com/sub' },
    ]),
    settings: {
      get: () => ({
        theme: 'dark',
        customThemes: [{ id: 'theme-1', name: '夜读' }],
        replaceRules: [{ id: 'rule-1', pattern: 'a', replacement: 'b', regex: false, enabled: true }],
        fontSize: 30,
        unknownSetting: 'keep',
      }),
      set: async () => undefined,
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  return { service, db }
}

async function readZip(job) {
  const data = await readFile(join(EXPORT_ROOT, job.filePath))
  const zip = await JSZip.loadAsync(data)
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir)
    .sort()
  return { zip, names }
}

test.after(async () => {
  await rm(EXPORT_ROOT, { recursive: true, force: true })
})

test('整包备份：zip 含 manifest 与全部数据文件、封面按约定命名、未知字段保留', async () => {
  const { service } = await makeService()
  const started = await service.startBackup({})
  assert.equal(started.existing, false)
  await service.waitForBackups()

  const { job } = await service.getBackupJob({ jobId: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.kind, 'backup')
  assert.match(job.fileName, /^mo-reader-backup-\d{4}-\d{2}-\d{2}\.zip$/)
  assert.equal(job.completed, job.total)
  // 13 类数据 + 封面 + 清单 + 压缩；压缩完成前不显示 100%。
  assert.equal(job.total, 16)
  assert.ok(job.bytes > 0)

  const { zip, names } = await readZip(job)
  assert.deepEqual(names, [
    'bookGroup.json',
    'bookSource.json',
    'bookmark.json',
    'bookshelf.json',
    'covers/book-a.png',
    'dictRule.json',
    'manifest.json',
    'note.json',
    'readConfig.json',
    'readRecord.json',
    'replaceRule.json',
    'rssSource.json',
    'settings.json',
    'subscription.json',
    'themeConfig.json',
  ])

  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.equal(manifest.format, 'mo-reader-backup')
  assert.equal(manifest.version, 1)
  assert.equal(manifest.light, false)
  assert.equal(manifest.counts.bookshelf, 3)
  assert.equal(manifest.counts.bookSource, 2)
  assert.equal(manifest.counts.note, 2)
  assert.equal(manifest.counts.readRecord, 3)
  assert.equal(manifest.counts.settings, 1)
  assert.equal(manifest.counts.themeConfig, 1)
  assert.equal(manifest.counts.replaceRule, 1)
  assert.equal(manifest.counts.rssSource, 1)
  assert.equal(manifest.counts.subscription, 1)
  // 分组表没写入方，分组从书目字段推导。
  assert.equal(manifest.counts.bookGroup, 2)
  assert.equal(manifest.covers.total, 1)
  assert.equal(manifest.covers.skipped, 1)
  assert.equal(manifest.covers.bytes, SMALL_PNG.length)
  assert.ok(manifest.files.includes('covers/book-a.png'))

  const books = JSON.parse(await zip.file('bookshelf.json').async('string'))
  assert.equal(books.length, 3)
  assert.equal(books.find((book) => book.id === 'book-a').legacyFlag, 'keep-me')
  assert.equal(books.find((book) => book.id === 'book-b').group, '玄幻')

  const groups = JSON.parse(await zip.file('bookGroup.json').async('string'))
  assert.deepEqual(
    groups.map((group) => group.name).sort(),
    ['玄幻', '都市'],
  )

  const settings = JSON.parse(await zip.file('settings.json').async('string'))
  assert.equal(settings[0].unknownSetting, 'keep')
  assert.equal(settings[0].fontSize, 30)
  const themes = JSON.parse(await zip.file('themeConfig.json').async('string'))
  assert.equal(themes[0].theme, 'dark')
  assert.equal(themes[0].customThemes[0].name, '夜读')
  const rules = JSON.parse(await zip.file('replaceRule.json').async('string'))
  assert.equal(rules[0].id, 'rule-1')

  const cover = await zip.file('covers/book-a.png').async('nodebuffer')
  assert.deepEqual(cover, SMALL_PNG)
})

test('轻量备份只含 manifest、书目与进度，不抓封面', async () => {
  const { service } = await makeService()
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const { job } = await service.getBackupJob({ jobId: started.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.light, true)
  assert.equal(job.total, 4)
  const { zip, names } = await readZip(job)
  assert.deepEqual(names, ['bookshelf.json', 'manifest.json', 'readRecord.json'])
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  assert.equal(manifest.light, true)
  assert.deepEqual(Object.keys(manifest.counts).sort(), ['bookshelf', 'readRecord'])
  assert.equal(manifest.covers.total, 0)
})

test('下载链接是 64 位随机 token，取一次即失效，过期与已用都有明确提示', async () => {
  const { service } = await makeService()
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const { job } = await service.getBackupJob({ jobId: started.job.id })

  const download = await service.getBackupDownload({ jobId: job.id })
  assert.match(download.url, /\/reader\/backups\/[0-9a-f]{64}$/)
  assert.equal(download.url.includes(job.id), false)
  assert.equal(download.singleUse, true)
  assert.equal(download.ttlMs, BACKUP_TOKEN_TTL_MS)
  assert.ok(download.expiresAt > Date.now())

  const token = download.url.split('/').pop()
  const first = await service.locateBackupTicket(token)
  assert.equal(first.filePath, job.filePath)
  assert.equal(first.contentType, 'application/zip')
  const second = await service.locateBackupTicket(token)
  assert.equal(second.status, 410)
  assert.match(second.message, /已使用/)

  // 先验过期：新签发的 token 会作废旧 token，顺序反过来就测不到过期文案。
  const fresh = service.backupCoordinator.tickets.issue(await service.backupCoordinator.get(job.id), Date.now())
  const expired = service.backupCoordinator.tickets.consume(fresh.token, Date.now() + BACKUP_TOKEN_TTL_MS + 1)
  assert.equal(expired.error.status, 410)
  assert.match(expired.error.message, /已过期/)
  const stillFresh = service.backupCoordinator.tickets.consume(fresh.token, Date.now())
  assert.equal(stillFresh.descriptor.filePath, job.filePath)

  const invalid = await service.locateBackupTicket('f'.repeat(64))
  assert.equal(invalid.status, 404)
  assert.match(invalid.message, /无效/)
})

test('取消备份：作业记为已取消，不留下 zip 与临时目录', async () => {
  const many = []
  for (let index = 0; index < 300; index += 1) {
    many.push({ id: `bulk-${index}`, name: `书 ${index}`, bookUrl: `https://example.com/${index}` })
  }
  const { service } = await makeService({ books: many })
  const started = await service.startBackup({})
  await service.cancelBackupJob({ id: started.job.id })
  await service.waitForBackups()
  const { job } = await service.getBackupJob({ jobId: started.job.id })
  assert.equal(job.status, 'cancelled')
  assert.equal(job.filePath, '')
  const entries = await readdir(EXPORT_ROOT)
  assert.equal(entries.includes(`${job.id}.zip`), false)
  assert.equal(entries.includes(`${job.id}.backup.parts`), false)
})

test('失败可读且可重试：读表抛错记为失败，恢复后再导出成功', async () => {
  const { service, db } = await makeService()
  const entries = db.books.entries
  db.books.entries = () => {
    throw new Error('磁盘暂时不可用')
  }
  const failed = await service.startBackup({ light: true })
  await service.waitForBackups()
  const first = await service.getBackupJob({ jobId: failed.job.id })
  assert.equal(first.job.status, 'failed')
  assert.equal(first.job.error, '磁盘暂时不可用')

  db.books.entries = entries
  const retried = await service.startBackup({ light: true })
  await service.waitForBackups()
  const second = await service.getBackupJob({ jobId: retried.job.id })
  assert.equal(second.job.status, 'done')
})

test('产物被删后不再签发下载链接', async () => {
  const { service } = await makeService()
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const { job } = await service.getBackupJob({ jobId: started.job.id })
  await rm(join(EXPORT_ROOT, job.filePath), { force: true })
  await assert.rejects(() => service.getBackupDownload({ jobId: job.id }), /备份文件不存在/)
})

test('已有进行中的备份时不重复开工', async () => {
  const { service } = await makeService()
  const started = await service.startBackup({})
  const again = await service.startBackup({})
  assert.equal(again.existing, true)
  assert.equal(again.job.id, started.job.id)
  await service.cancelBackupJob({ id: started.job.id })
  await service.waitForBackups()
})

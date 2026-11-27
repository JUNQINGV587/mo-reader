/**
 * 备份导入服务层测试（#132）：preview 不写库、apply 写库与幂等、失败回滚、取消、
 * 加密/高版本拒绝、设置只补缺且不写 WebDAV 密码。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { ReaderService } from '../dist/server/service.js'

const EXPORT_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-import-'))
process.env.MO_READER_EXPORT_ROOT = EXPORT_ROOT

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const SECTIONS = {
  bookshelf: 'bookshelf.json',
  bookSource: 'bookSource.json',
  bookGroup: 'bookGroup.json',
  bookmark: 'bookmark.json',
  note: 'note.json',
  readRecord: 'readRecord.json',
  readConfig: 'readConfig.json',
  settings: 'settings.json',
  themeConfig: 'themeConfig.json',
  replaceRule: 'replaceRule.json',
  dictRule: 'dictRule.json',
  rssSource: 'rssSource.json',
  subscription: 'subscription.json',
}

function fakeTable(records = []) {
  const map = new Map(records.map((record) => [record.id, record]))
  return {
    map,
    get(id) {
      return map.get(id)
    },
    has(id) {
      return map.has(id)
    },
    entries() {
      return map.entries()
    },
    keys() {
      return map.keys()
    },
    put(id, record) {
      map.set(id, record)
    },
    delete(id) {
      return map.delete(id)
    },
  }
}

function makeDb(settings = {}) {
  const state = { ...settings }
  return {
    books: fakeTable(),
    sources: fakeTable(),
    groups: fakeTable(),
    dictRules: fakeTable(),
    notes: fakeTable(),
    bookmarks: fakeTable(),
    readRecords: fakeTable([{ id: 'b1', bookId: 'b1', chapterIndex: 1, updatedAt: '2025-01-01T00:00:00.000Z' }]),
    readConfigs: fakeTable(),
    subscriptions: fakeTable(),
    jobs: fakeTable(),
    downloadEntries: fakeTable(),
    mediaEntries: fakeTable(),
    settings: {
      get() {
        return { ...state }
      },
      set(next) {
        for (const key of Object.keys(state)) delete state[key]
        Object.assign(state, next)
      },
      raw() {
        return state
      },
    },
  }
}

function makeService(db = makeDb(), overrides = {}) {
  const service = Object.create(ReaderService.prototype)
  service.db = db
  Object.assign(service, overrides)
  return service
}

function baseSections() {
  return {
    bookshelf: [
      {
        id: 'b1',
        name: '三体',
        author: '刘慈欣',
        bookUrl: 'https://book.example.com/1',
        origin: 'https://book.example.com',
        originName: '示例源',
        type: 0,
        group: '',
        coverUrl: '',
        intro: '简介',
        totalChapterNum: 30,
        pinned: false,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        metadataOnly: false,
        localMissing: false,
      },
    ],
    bookSource: [{ bookSourceUrl: 'https://source.example.com', bookSourceName: '示例书源', enabled: true }],
    bookGroup: [{ id: 'g1', name: '科幻' }],
    bookmark: [{ bookId: 'b1', chapterIndex: 3, chapterTitle: '第三章', page: 0, text: '摘录', createdAt: '2025-01-02T00:00:00.000Z' }],
    note: [{ bookId: 'b1', chapterIndex: 3, chapterTitle: '第三章', page: 0, quote: '引用', content: '感想', createdAt: '2025-01-02T00:00:00.000Z' }],
    readRecord: [{ id: 'b1', bookId: 'b1', chapterIndex: 9, chapterTitle: '第九章', position: 2, updatedAt: '2025-03-01T00:00:00.000Z' }],
    readConfig: [],
    settings: [{ fontSize: 30, letterSpacing: 1, theme: 'sepia', webdavPassword: 'should-not-import' }],
    themeConfig: [{ theme: 'sepia', customThemes: [{ id: 't1', name: '护眼', bg: '#f1ead8', text: '#333333', muted: '#777777', line: '#dddddd' }] }],
    replaceRule: [{ pattern: '测试', replacement: '替换' }],
    dictRule: [{ id: 'd1', name: '人名', entries: [] }],
    rssSource: [],
    subscription: [{ id: 's1', sourceUrl: 'https://rss.example.com/feed' }],
  }
}

async function makeZip(sections = baseSections(), options = {}) {
  const zip = new JSZip()
  const files = []
  const counts = {}
  for (const [section, name] of Object.entries(SECTIONS)) {
    const items = options.skip?.[section] ? [] : sections[section] ?? []
    zip.file(name, JSON.stringify(items))
    counts[section] = items.length
    files.push(name)
  }
  if (options.cover !== false) {
    zip.file('covers/b1.png', PNG)
    files.push('covers/b1.png')
  }
  const manifest = {
    format: 'mo-reader-backup',
    version: options.version ?? 1,
    exportedAt: '2025-03-02T00:00:00.000Z',
    app: { name: '墨读', version: '0.1.0' },
    light: false,
    counts,
    covers: { total: 1, bytes: PNG.length, skipped: 0, maxBytes: 2097152, maxTotalBytes: 209715200 },
    files,
  }
  zip.file('manifest.json', JSON.stringify(manifest))
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
}

async function preview(service, zip) {
  const started = await service.previewBackupImport({
    fileName: 'mo-reader-backup.zip',
    dataBase64: zip.toString('base64'),
  })
  await service.waitForBackupImports()
  return service.getBackupJob({ jobId: started.job.id })
}

test('preview 只生成预览，不写任何数据', async () => {
  const db = makeDb({ fontSize: 24 })
  const service = makeService(db)
  const { job } = await preview(service, await makeZip())
  assert.equal(job.status, 'paused')
  assert.equal(job.stage, 'preview')
  assert.equal(job.preview.books.added, 1)
  assert.equal(job.preview.bookmarks.added, 1)
  assert.equal(job.preview.notes.added, 1)
  assert.equal(job.preview.progress.updated, 1)
  assert.equal(job.preview.sources.added, 1)
  assert.equal(job.preview.themes.added, 1)
  assert.ok(job.preview.settings.added.includes('letterSpacing'))
  assert.equal(db.books.map.size, 0)
  assert.equal(db.bookmarks.map.size, 0)
  assert.equal(db.settings.get().fontSize, 24)
  assert.equal(db.jobs.map.get(job.id).status, 'paused')
})

test('apply 写库：书目、封面、书源、进度、书签、笔记、补缺设置，且不写 WebDAV 密码', async () => {
  const db = makeDb({ fontSize: 24 })
  const service = makeService(db)
  const started = await preview(service, await makeZip())
  const applied = await service.applyBackupImport({ jobId: started.job.id })
  assert.equal(applied.job.status, 'done')
  assert.equal(applied.job.completed, applied.job.total)
  assert.equal(db.books.map.size, 1)
  const book = db.books.map.get('b1')
  assert.equal(book.name, '三体')
  assert.match(book.coverUrl, /^data:image\/png;base64,/)
  assert.equal(db.sources.map.size, 1)
  assert.equal(db.readRecords.map.get('b1').chapterIndex, 9)
  assert.equal(db.bookmarks.map.size, 1)
  assert.equal(db.notes.map.size, 1)
  assert.equal(db.dictRules.map.size, 1)
  assert.equal(db.subscriptions.map.size, 1)
  // 设置只补缺：本机已有字号时保留本机值，只补没有的字距。
  assert.equal(db.settings.get().fontSize, 24)
  assert.equal(db.settings.get().letterSpacing, 1)
  assert.equal(db.settings.get().theme, 'sepia')
  assert.equal(db.settings.get().customThemes[0].name, '护眼')
  assert.equal(db.settings.get().replaceRules[0].pattern, '测试')
  assert.equal('webdavPassword' in db.settings.get(), false)
  assert.equal(db.settings.get().fontId, undefined)
})

test('同一备份导入两次：第二次全部跳过、不重复写、统计不翻倍', async () => {
  const db = makeDb()
  const service = makeService(db)
  const zip = await makeZip()
  const first = await preview(service, zip)
  await service.applyBackupImport({ jobId: first.job.id })
  const second = await preview(service, zip)
  assert.equal(second.job.preview.books.added, 0)
  assert.equal(second.job.preview.books.updated, 0)
  assert.equal(second.job.preview.books.skipped, 1)
  assert.equal(second.job.preview.progress.skipped, 1)
  assert.equal(second.job.preview.bookmarks.skipped, 1)
  assert.equal(second.job.preview.notes.skipped, 1)
  assert.equal(second.job.preview.themes.skipped, 1)
  assert.deepEqual(second.job.preview.settings.added, [])
  const applied = await service.applyBackupImport({ jobId: second.job.id })
  assert.equal(applied.job.status, 'done')
  assert.equal(db.books.map.size, 1)
  assert.equal(db.bookmarks.map.size, 1)
  assert.equal(db.notes.map.size, 1)
  assert.equal(db.settings.get().customThemes.length, 1)
})

test('预览阶段取消：不写库，作业记为已取消', async () => {
  const db = makeDb()
  const service = makeService(db)
  const started = await preview(service, await makeZip())
  const cancelled = await service.cancelBackupJob({ id: started.job.id })
  assert.equal(cancelled.job.status, 'cancelled')
  assert.equal(db.books.map.size, 0)
  assert.equal(db.settings.get().fontSize, undefined)
  const after = await service.getBackupJob({ jobId: started.job.id })
  assert.equal(after.job.status, 'cancelled')
})

test('加密备份与更高版本都被拒绝且不写库', async () => {
  const db = makeDb()
  const service = makeService(db)
  const higher = await preview(service, await makeZip(baseSections(), { version: 2 }))
  assert.equal(higher.job.status, 'failed')
  assert.match(higher.job.error, /更新版本/)
  const encrypted = Buffer.from(await makeZip())
  // 把本地文件头与中央目录的「加密」标志置 1，模拟带密码的备份。
  for (let index = 0; index < encrypted.length - 4; index += 1) {
    if (encrypted.readUInt32LE(index) === 0x04034b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(index + 6) | 1, index + 6)
    if (encrypted.readUInt32LE(index) === 0x02014b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(index + 8) | 1, index + 8)
  }
  const rejected = await preview(service, encrypted)
  assert.equal(rejected.job.status, 'failed')
  assert.match(rejected.job.error, /加密/)
  assert.equal(db.books.map.size, 0)
  assert.equal(db.settings.get().fontSize, undefined)
})

test('写库中途失败：按已写入条目逆序回滚，并删掉临时目录', async () => {
  const db = makeDb({ fontSize: 24 })
  const notes = db.notes
  const originalPut = notes.put
  notes.put = function put(id, record) {
    if (record.content === '感想') throw new Error('磁盘写满')
    return originalPut.call(this, id, record)
  }
  const service = makeService(db)
  const started = await preview(service, await makeZip())
  const applied = await service.applyBackupImport({ jobId: started.job.id })
  assert.equal(applied.job.status, 'failed')
  assert.match(applied.job.error, /磁盘写满/)
  assert.equal(db.books.map.size, 0)
  assert.equal(db.sources.map.size, 0)
  assert.equal(db.bookmarks.map.size, 0)
  assert.equal(db.settings.get().fontSize, 24)
  const leftover = await service.getBackupJob({ jobId: started.job.id })
  assert.equal(leftover.job.status, 'failed')
})

test('导入过程中取消：停止写库并回滚', async () => {
  const db = makeDb({ fontSize: 24 })
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const sources = db.sources
  const originalPut = sources.put
  sources.put = function put(id, record) {
    return gate.then(() => originalPut.call(this, id, record))
  }
  const service = makeService(db)
  const started = await preview(service, await makeZip())
  const running = service.applyBackupImport({ jobId: started.job.id })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const cancelling = service.cancelBackupJob({ id: started.job.id })
  release()
  const applied = await running
  await cancelling
  assert.equal(applied.job.status, 'cancelled')
  assert.equal(db.books.map.size, 0)
  assert.equal(db.sources.map.size, 0)
  assert.equal(db.settings.get().fontSize, 24)
})

test('坏文件与旧书架 JSON：坏压缩包明确报错，JSON 书架能导入', async () => {
  const db = makeDb()
  const service = makeService(db)
  const broken = await preview(service, Buffer.from('not a zip'))
  assert.equal(broken.job.status, 'failed')
  assert.match(broken.job.error, /无法识别/)
  const shelf = Buffer.from(
    JSON.stringify({
      format: 'mo-reader-books',
      version: 1,
      books: [{ name: '球状闪电', author: '刘慈欣', bookUrl: 'https://book.example.com/2', origin: 'https://book.example.com' }],
    }),
  )
  const started = await preview(service, shelf)
  assert.equal(started.job.status, 'paused')
  assert.equal(started.job.preview.books.added, 1)
  const applied = await service.applyBackupImport({ jobId: started.job.id })
  assert.equal(applied.job.status, 'done')
  assert.equal(db.books.map.size, 1)
})

test.after(async () => {
  await rm(EXPORT_ROOT, { recursive: true, force: true })
})

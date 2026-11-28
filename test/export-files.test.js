import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 导出成品清理（#143）的服务端测试：临时缓存/媒体/导出目录 + 假数据表，不联网、不起端口。
 * 覆盖列出成品（名称/大小/时间）、删除后磁盘与用量同步、进行中作业拒绝、
 * 路径穿越与陌生文件拒绝、删备份后旧链接失效、24 小时自动清理仍生效。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */
const { ReaderService } = await import('../dist/server/service.js')

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
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

/** 每次用例独立的缓存/媒体/导出根目录，导出根与 status 断言都按它算。 */
async function useRoots() {
  const root = await mkdtemp(path.join(tmpdir(), 'mo-export-files-'))
  const cache = path.join(root, 'cache')
  const media = path.join(root, 'media')
  const exports = path.join(root, 'exports')
  process.env.MO_READER_CACHE_ROOT = cache
  process.env.MO_READER_MEDIA_ROOT = media
  process.env.MO_READER_EXPORT_ROOT = exports
  delete process.env.MO_READER_MEDIA_QUOTA_BYTES
  await mkdir(cache, { recursive: true })
  await mkdir(media, { recursive: true })
  await mkdir(exports, { recursive: true })
  return { root, cache, media, exports }
}

async function makeService(records = []) {
  const db = {
    books: fakeTable(),
    mediaEntries: fakeTable(),
    downloadEntries: fakeTable(),
    jobs: fakeTable(records),
    sources: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    chapters: fakeTable(),
    subscriptions: fakeTable(),
    settings: { get: () => ({}), set: async () => {} },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  service.downloadRetryBaseMs = 1
  return { service, db, jobs: db.jobs }
}

async function putFile(root, name, body, { mtimeMs } = {}) {
  const target = path.join(root, name)
  await writeFile(target, body)
  if (mtimeMs !== undefined) await utimes(target, mtimeMs / 1000, mtimeMs / 1000)
  return target
}

function backupJob(id, overrides = {}) {
  const now = overrides.createdAt ?? Date.now()
  return {
    id,
    kind: 'backup',
    bookId: '',
    bookName: '',
    status: 'done',
    light: false,
    stage: 'done',
    stageText: '已完成',
    total: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    bytes: 0,
    records: 0,
    covers: 0,
    skippedCovers: 0,
    coverBytes: 0,
    fileName: 'mo-reader-backup.zip',
    filePath: '',
    error: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function exportJob(id, overrides = {}) {
  const now = overrides.createdAt ?? Date.now()
  return {
    id,
    kind: 'export',
    bookId: 'book-a',
    bookName: '山海',
    status: 'done',
    format: 'epub',
    fileName: '山海.epub',
    filePath: '',
    size: 0,
    failedChapters: [],
    failedTruncated: false,
    failedListFile: '',
    fontId: '',
    fromIndex: 0,
    toIndex: 0,
    all: true,
    total: 1,
    completed: 1,
    failed: 0,
    skipped: 0,
    bytes: 0,
    error: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

test('列出导出成品：名称、大小、时间、展示名齐全，临时目录与陌生文件不混进来', async () => {
  const roots = await useRoots()
  const now = Date.now()
  const backupId = randomUUID()
  const epubId = randomUUID()
  const failedId = randomUUID()
  const failedText = '第3章：超时'
  const { service } = await makeService([
    backupJob(backupId, {
      filePath: `${backupId}.zip`,
      bytes: 1200,
      fileName: 'mo-reader-backup-2026-11-28.zip',
      createdAt: now - 3000,
      updatedAt: now - 3000,
    }),
    exportJob(epubId, { bookName: '山海', filePath: `${epubId}.epub`, size: 700, fileName: '山海.epub', createdAt: now - 2000 }),
    exportJob(failedId, {
      bookName: '长夜',
      format: 'pdf',
      filePath: `${failedId}.pdf`,
      size: 100,
      fileName: '长夜.pdf',
      failedChapters: ['第3章'],
      failedTruncated: true,
      failedListFile: `${failedId}.failed.txt`,
      createdAt: now - 1000,
    }),
  ])
  await putFile(roots.exports, `${backupId}.zip`, 'b'.repeat(1200), { mtimeMs: now - 3000 })
  await putFile(roots.exports, `${epubId}.epub`, 'e'.repeat(700), { mtimeMs: now - 2000 })
  await putFile(roots.exports, `${failedId}.pdf`, 'p'.repeat(100), { mtimeMs: now - 1000 })
  await putFile(roots.exports, `${failedId}.failed.txt`, failedText, { mtimeMs: now - 1000 })
  // 临时章节目录与陌生文件都不算成品。
  await mkdir(path.join(roots.exports, `${randomUUID()}.parts`))
  await writeFile(path.join(roots.exports, 'note.zip'), 'not an artifact')

  const listed = await service.listExportFiles()
  assert.equal(listed.files.length, 4)
  const byName = new Map(listed.files.map((file) => [file.name, file]))
  const zip = byName.get(`${backupId}.zip`)
  assert.equal(zip.kind, 'backup')
  assert.equal(zip.size, 1200)
  assert.equal(zip.displayName, 'mo-reader-backup-2026-11-28.zip')
  assert.equal(zip.deletable, true)
  assert.ok(Math.abs(zip.mtimeMs - (now - 3000)) < 2000)
  const epub = byName.get(`${epubId}.epub`)
  assert.equal(epub.kind, 'export')
  assert.equal(epub.displayName, '山海.epub')
  const epubFailList = byName.get(`${failedId}.failed.txt`)
  assert.equal(epubFailList.kind, 'failed')
  assert.equal(epubFailList.displayName, '长夜（失败清单）')
  assert.equal(listed.total.files, 4)
  assert.equal(listed.total.bytes, 1200 + 700 + 100 + Buffer.byteLength(failedText))
  // 时间倒序：最新的失败清单在最前，28 小时前的备份在最后。
  assert.equal(listed.files[listed.files.length - 1].name, `${backupId}.zip`)
})

test('删单个导出文件：磁盘消失、列表变短、存储用量同步减少、作业记录清空路径', async () => {
  const roots = await useRoots()
  const id = randomUUID()
  const { service, jobs } = await makeService([
    backupJob(id, { filePath: `${id}.zip`, bytes: 2048, fileName: 'mo-reader-backup.zip' }),
  ])
  await putFile(roots.exports, `${id}.zip`, 'x'.repeat(2048))
  const before = await service.getStorageUsage()
  assert.equal(before.exports.bytes, 2048)
  assert.equal(before.exports.files, 1)

  const deleted = await service.deleteExportFile({ name: `${id}.zip` })
  assert.equal(deleted.name, `${id}.zip`)
  assert.equal(deleted.bytes, 2048)
  assert.equal(deleted.jobId, id)
  await assert.rejects(stat(path.join(roots.exports, `${id}.zip`)))

  const after = await service.getStorageUsage()
  assert.equal(after.exports.bytes, 0)
  assert.equal(after.total.bytes, before.total.bytes - 2048)
  assert.equal((await service.listExportFiles()).files.length, 0)
  const record = jobs.get(id)
  assert.equal(record.filePath, '')
  assert.equal(record.bytes, 0)
})

test('删失败清单只清清单字段，主产物与作业仍可下载', async () => {
  const roots = await useRoots()
  const id = randomUUID()
  const { service, jobs } = await makeService([
    exportJob(id, {
      format: 'pdf',
      bookName: '长夜',
      filePath: `${id}.pdf`,
      size: 300,
      failedTruncated: true,
      failedListFile: `${id}.failed.txt`,
    }),
  ])
  await putFile(roots.exports, `${id}.pdf`, 'p'.repeat(300))
  await putFile(roots.exports, `${id}.failed.txt`, '第3章：超时')

  await service.deleteExportFile({ name: `${id}.failed.txt` })
  const record = jobs.get(id)
  assert.equal(record.failedListFile, '')
  assert.equal(record.filePath, `${id}.pdf`)
  assert.equal((await stat(path.join(roots.exports, `${id}.pdf`))).size, 300)
  const listed = await service.listExportFiles()
  assert.deepEqual(listed.files.map((file) => file.name), [`${id}.pdf`])
})

test('进行中的导出与备份拒绝删除，产物原样保留', async () => {
  const roots = await useRoots()
  const backupId = randomUUID()
  const exportId = randomUUID()
  const { service } = await makeService([
    backupJob(backupId, { status: 'running', filePath: `${backupId}.zip`, bytes: 10 }),
    exportJob(exportId, { status: 'running', filePath: `${exportId}.epub`, size: 10 }),
  ])
  await putFile(roots.exports, `${backupId}.zip`, 'b'.repeat(10))
  await putFile(roots.exports, `${exportId}.epub`, 'e'.repeat(10))

  await assert.rejects(service.deleteExportFile({ name: `${backupId}.zip` }), /完成后再删/)
  await assert.rejects(service.deleteExportFile({ name: `${exportId}.epub` }), /完成后再删/)
  assert.equal((await stat(path.join(roots.exports, `${backupId}.zip`))).size, 10)
  assert.equal((await stat(path.join(roots.exports, `${exportId}.epub`))).size, 10)
  const listed = await service.listExportFiles()
  assert.equal(listed.files.length, 2)
  assert.equal(listed.files.find((file) => file.name === `${backupId}.zip`).deletable, false)
  assert.match(listed.files.find((file) => file.name === `${backupId}.zip`).reason, /完成后再删/)
})

test('正在上传到 WebDAV 的备份不能删，传完才能删', async () => {
  const roots = await useRoots()
  const backupId = randomUUID()
  const transferId = randomUUID()
  const { service } = await makeService([
    backupJob(backupId, { filePath: `${backupId}.zip`, bytes: 30 }),
    {
      id: transferId,
      kind: 'webdavTransfer',
      direction: 'upload',
      backupJobId: backupId,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ])
  await putFile(roots.exports, `${backupId}.zip`, 'z'.repeat(30))

  await assert.rejects(service.deleteExportFile({ name: `${backupId}.zip` }), /上传.*完成后再删/)
  assert.equal((await stat(path.join(roots.exports, `${backupId}.zip`))).size, 30)
})

test('路径穿越、绝对路径、陌生文件名、符号链接一律拒绝，导出目录外不受影响', async () => {
  const roots = await useRoots()
  const id = randomUUID()
  const { service } = await makeService([backupJob(id, { filePath: `${id}.zip`, bytes: 7 })])
  const outside = path.join(roots.root, 'outside.zip')
  await writeFile(outside, 'outside')
  const before = await readdir(roots.root)

  for (const name of ['../outside.zip', path.join(roots.root, 'outside.zip'), 'outside.zip', `${id}.zip/../x`, '', '…/x.zip']) {
    await assert.rejects(service.deleteExportFile({ name }), /缺少参数 name|文件名无效|只能删导出文件/)
  }
  // 符号链接长得像产物也不算，更不能顺着它删到目录外。
  await symlink(outside, path.join(roots.exports, `${id}.zip`))
  await assert.rejects(service.deleteExportFile({ name: `${id}.zip` }), /文件不存在/)

  assert.equal(await stat(outside).then((info) => info.size), 7)
  assert.deepEqual(await readdir(roots.root), before)
  assert.equal((await service.listExportFiles()).files.length, 0)
})

test('删掉备份成品后，之前发出的下载链接随即失效，避免删了还能下一半', async () => {
  const roots = await useRoots()
  const id = randomUUID()
  const { service } = await makeService([
    backupJob(id, { filePath: `${id}.zip`, bytes: 5, fileName: 'mo-reader-backup.zip' }),
  ])
  await putFile(roots.exports, `${id}.zip`, 'abcde')
  const manager = service.backupManager()
  const ticket = manager.tickets.issue(await manager.get(id))
  assert.ok(ticket?.token)

  await service.deleteExportFile({ name: `${id}.zip` })
  const result = manager.tickets.consume(ticket.token)
  assert.equal(result.error.status, 404)
  assert.match(result.error.message, /下载链接无效/)
})

test('24 小时自动清理仍生效：过期成品被清掉，新成品与进行中的作业不动', async () => {
  const roots = await useRoots()
  const { cleanupExpiredExports } = await import('../dist/server/exports.js')
  const { cleanupExpiredBackups } = await import('../dist/server/backup.js')
  const staleExportId = randomUUID()
  const freshExportId = randomUUID()
  const staleBackupId = randomUUID()
  const now = Date.now()
  const stale = now - 25 * 60 * 60 * 1000
  const { db } = await makeService([
    exportJob(staleExportId, { filePath: `${staleExportId}.epub`, createdAt: stale, updatedAt: stale }),
    exportJob(freshExportId, { filePath: `${freshExportId}.epub` }),
    backupJob(staleBackupId, { filePath: `${staleBackupId}.zip`, createdAt: stale, updatedAt: stale }),
  ])
  await putFile(roots.exports, `${staleExportId}.epub`, 'old', { mtimeMs: stale })
  await putFile(roots.exports, `${freshExportId}.epub`, 'new')
  await putFile(roots.exports, `${staleBackupId}.zip`, 'old', { mtimeMs: stale })

  const exportResult = await cleanupExpiredExports(db.jobs, now)
  const backupResult = await cleanupExpiredBackups(db.jobs, now)
  assert.ok(exportResult.files >= 1)
  assert.equal(backupResult.jobs, 1)
  assert.equal(await stat(path.join(roots.exports, `${freshExportId}.epub`)).then((info) => info.size), 3)
  const listed = await makeService([])
  const names = (await listed.service.listExportFiles()).files.map((file) => file.name)
  assert.deepEqual(names, [`${freshExportId}.epub`])
  assert.equal(db.jobs.has(staleExportId), false)
  assert.equal(db.jobs.has(staleBackupId), false)
})

test('删除中途失败不留下半份记录：文件删掉后作业路径才清空', async () => {
  const roots = await useRoots()
  const id = randomUUID()
  const { service, jobs } = await makeService([backupJob(id, { filePath: `${id}.zip`, bytes: 9 })])
  // 记录指向的产物已经被人手动删掉：再点删除给「文件不存在」，而不是报内部错误。
  await assert.rejects(service.deleteExportFile({ name: `${id}.zip` }), /文件不存在/)
  assert.equal(jobs.get(id).filePath, `${id}.zip`)
  await putFile(roots.exports, `${id}.zip`, 'ninebytes')
  await service.deleteExportFile({ name: `${id}.zip` })
  assert.equal(await stat(path.join(roots.exports, `${id}.zip`)).catch(() => null), null)
  assert.equal(jobs.get(id).filePath, '')
})

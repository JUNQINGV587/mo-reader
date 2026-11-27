import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BACKUP_FORMAT,
  BACKUP_MAX_COVER_BYTES,
  BACKUP_MAX_COVERS_TOTAL_BYTES,
  BACKUP_SECTION_FILES,
  BACKUP_TOKEN_TTL_MS,
  BACKUP_VERSION,
  backupCoverEntry,
  backupCoverExtension,
  backupFileName,
  backupSectionIncluded,
  backupSectionsFor,
  buildBackupManifest,
  coverBudgetAllows,
  mergeBackupRecords,
  parseBackupManifest,
  serializeBackupJson,
} from '../dist/core/reader/backup.js'

/**
 * 备份格式（#130）的纯函数测试：manifest、文件名、封面命名与阈值、导入扩展点。
 * 前置：npm run build:server（测试 import 的是 dist/core/reader/backup.js）。
 */

test('备份文件名带本地日期，格式固定', () => {
  const name = backupFileName(new Date(2026, 2, 5, 23, 30, 0))
  assert.equal(name, 'mo-reader-backup-2026-03-05.zip')
  assert.match(backupFileName(), /^mo-reader-backup-\d{4}-\d{2}-\d{2}\.zip$/)
})

test('完整备份与轻量备份的段落清单', () => {
  assert.deepEqual(backupSectionsFor(false), [
    'bookshelf',
    'bookSource',
    'bookGroup',
    'bookmark',
    'note',
    'readRecord',
    'readConfig',
    'settings',
    'themeConfig',
    'replaceRule',
    'dictRule',
    'rssSource',
    'subscription',
  ])
  assert.deepEqual(backupSectionsFor(true), ['bookshelf', 'readRecord'])
  assert.equal(backupSectionIncluded(true, 'settings'), false)
  assert.equal(backupSectionIncluded(true, 'readRecord'), true)
  assert.equal(BACKUP_SECTION_FILES.readRecord, 'readRecord.json')
  assert.equal(BACKUP_SECTION_FILES.rssSource, 'rssSource.json')
})

test('manifest 写格式、版本、计数与文件清单；轻量备份只列两类计数', () => {
  const full = buildBackupManifest({
    exportedAt: '2026-03-05T12:00:00.000Z',
    appVersion: '0.2.0-m0',
    light: false,
    counts: { bookshelf: 3, readRecord: 5, settings: 1 },
    covers: { total: 2, bytes: 1000, skipped: 1 },
    files: ['manifest.json', 'bookshelf.json', '', 'covers/a.png'],
  })
  assert.equal(full.format, BACKUP_FORMAT)
  assert.equal(full.version, BACKUP_VERSION)
  assert.equal(full.light, false)
  assert.equal(full.app.name, '墨读')
  assert.equal(full.app.version, '0.2.0-m0')
  assert.equal(full.counts.bookshelf, 3)
  assert.equal(full.counts.readRecord, 5)
  assert.equal(full.counts.note, 0)
  assert.equal(full.counts.settings, 1)
  assert.deepEqual(full.files, ['manifest.json', 'bookshelf.json', 'covers/a.png'])
  assert.equal(full.covers.maxBytes, BACKUP_MAX_COVER_BYTES)
  assert.equal(full.covers.maxTotalBytes, BACKUP_MAX_COVERS_TOTAL_BYTES)

  const light = buildBackupManifest({ appVersion: '0.2.0-m0', light: true, counts: { bookshelf: 1, note: 9 }, files: [] })
  assert.deepEqual(Object.keys(light.counts).sort(), ['bookshelf', 'readRecord'])
  assert.equal(light.counts.bookshelf, 1)
  assert.equal(light.counts.readRecord, 0)
})

test('封面扩展名与 zip 路径按约定；非法 bookId 不生成路径', () => {
  assert.equal(backupCoverExtension('image/jpeg'), 'jpg')
  assert.equal(backupCoverExtension('image/jpg; charset=binary'), 'jpg')
  assert.equal(backupCoverExtension('image/png'), 'png')
  assert.equal(backupCoverExtension('image/webp'), 'webp')
  assert.equal(backupCoverExtension('image/gif'), '')
  assert.equal(backupCoverEntry('book-a', 'png'), 'covers/book-a.png')
  assert.equal(backupCoverEntry('book-a', 'jpeg'), 'covers/book-a.jpg')
  assert.equal(backupCoverEntry('../book', 'png'), '')
  assert.equal(backupCoverEntry('book/a', 'png'), '')
  assert.equal(backupCoverEntry('book-a', 'gif'), '')
})

test('封面阈值：单张 2MB、总计 200MB，超限返回 false', () => {
  assert.equal(coverBudgetAllows(0, BACKUP_MAX_COVER_BYTES), true)
  assert.equal(coverBudgetAllows(0, BACKUP_MAX_COVER_BYTES + 1), false)
  assert.equal(coverBudgetAllows(BACKUP_MAX_COVERS_TOTAL_BYTES, 1), false)
  assert.equal(coverBudgetAllows(0, 10, 5), false)
})

test('manifest 校验：合法通过，格式/版本/时间/计数不合法给可读错误', () => {
  const valid = buildBackupManifest({ appVersion: '0.2.0-m0', light: false, counts: {}, files: [] })
  const parsed = parseBackupManifest(JSON.parse(serializeBackupJson(valid)))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.manifest.format, BACKUP_FORMAT)

  assert.deepEqual(parseBackupManifest('{oops'), { ok: false, error: 'manifest.json 不是合法的 JSON' })
  assert.equal(parseBackupManifest({}).ok, false)
  assert.equal(parseBackupManifest({ ...valid, format: 'other' }).error, '不是墨读备份文件')
  assert.equal(parseBackupManifest({ ...valid, version: BACKUP_VERSION + 1 }).error, '备份来自更新版本的墨读，请先升级')
  assert.equal(parseBackupManifest({ ...valid, exportedAt: '' }).error, '备份缺少导出时间')
  assert.equal(parseBackupManifest({ ...valid, counts: null }).ok, false)
})

test('导入合并扩展点按 key 覆盖、保留未知字段', () => {
  const merged = mergeBackupRecords(
    [
      { id: 'a', title: '旧', legacy: 'keep' },
      { id: 'b', title: '只旧记录' },
    ],
    [
      { id: 'a', title: '新', extra: 1 },
      { id: 'c', title: '新增' },
    ],
    (record) => record.id,
  )
  assert.deepEqual(merged, [
    { id: 'a', title: '新', legacy: 'keep', extra: 1 },
    { id: 'b', title: '只旧记录' },
    { id: 'c', title: '新增' },
  ])
})

test('序列化是可读 JSON：缩进 + 换行收尾', () => {
  assert.equal(serializeBackupJson({ a: 1 }), '{\n  "a": 1\n}\n')
})

test('token 有效期常量是 10 分钟', () => {
  assert.equal(BACKUP_TOKEN_TTL_MS, 10 * 60 * 1000)
})

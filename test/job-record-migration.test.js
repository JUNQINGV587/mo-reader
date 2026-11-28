import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * jobs 表兼容性（#151 遗留）：搜索作业曾把 skipped 存成数组，和下载作业的 skipped 数字冲突。
 * 读盘时必须迁移到 skippedSources，否则整个 mo_reader 域会因一条旧记录无法激活。
 */
const { ReaderDomain } = await import('../dist/server/storage.js')
const schema = ReaderDomain.tables.jobs.valueSchema

test('jobs 表把旧搜索作业的 skipped 数组迁到 skippedSources', () => {
  const parsed = schema.parse({
    id: 'legacy-search',
    kind: 'search',
    status: 'done',
    skipped: [
      { bookSourceUrl: 'https://a', sourceName: '源A', reason: '书源已停用或已删除' },
      { bookSourceUrl: 'https://b', sourceName: '源B', reason: '书源已停用或已删除' },
    ],
  })
  assert.equal(parsed.skipped, 0, '旧的 skipped 数组不能保留在数字字段里')
  assert.deepEqual(
    parsed.skippedSources.map((item) => item.bookSourceUrl),
    ['https://a', 'https://b'],
    '跳过源按原顺序迁移',
  )
})

test('jobs 表保留下载作业的 skipped 数字', () => {
  const parsed = schema.parse({ id: 'download-1', kind: 'download', skipped: 3 })
  assert.equal(parsed.skipped, 3)
  assert.equal(parsed.skippedSources, undefined, '下载作业不凭空多出 skippedSources')
})

test('已经是 skippedSources 的搜索作业不被旧字段覆盖', () => {
  const parsed = schema.parse({
    id: 'new-search',
    kind: 'search',
    skipped: 0,
    skippedSources: [{ bookSourceUrl: 'https://new', sourceName: '新源', reason: '已停用' }],
  })
  assert.equal(parsed.skipped, 0)
  assert.deepEqual(parsed.skippedSources.map((item) => item.bookSourceUrl), ['https://new'])
})

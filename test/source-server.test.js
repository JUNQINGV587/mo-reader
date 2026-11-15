import assert from 'node:assert/strict'
import test from 'node:test'

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const map = new Map()
  const table = {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = { sources: table }
  return { service, map }
}

const A = { bookSourceUrl: 'https://a.example.com', bookSourceName: '甲源' }
const B = { bookSourceUrl: 'https://b.example.com', bookSourceName: '乙源' }

test('书源导入：批量、去重、字段校验与更新计数', async () => {
  const { service, map } = await makeService()

  const result = await service.importSources({
    payload: JSON.stringify([A, B, { bookSourceName: '无地址' }]),
  })
  assert.equal(result.total, 3)
  assert.equal(result.added, 2)
  assert.equal(result.updated, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(map.size, 2)

  const again = await service.importSources({ payload: JSON.stringify([A, B]) })
  assert.equal(again.added, 0)
  assert.equal(again.updated, 2)

  await assert.rejects(() => service.importSources({ payload: 'not json' }))
})

test('书源列表按名称排序，保存与删除生效', async () => {
  const { service, map } = await makeService()
  await service.importSources({ payload: JSON.stringify([B, A]) })

  const list = await service.listSources()
  assert.deepEqual(
    list.sources.map((source) => source.bookSourceName),
    ['甲源', '乙源'],
  )

  const saved = await service.saveSource({
    source: { ...A, bookSourceName: '甲源改' },
  })
  assert.equal(saved.source.id, A.bookSourceUrl)
  assert.equal(map.get(A.bookSourceUrl).bookSourceName, '甲源改')

  const deleted = await service.deleteSources({ urls: [A.bookSourceUrl, 'https://none.example.com'] })
  assert.equal(deleted.deleted, 1)
  assert.equal(map.size, 1)
})

test('搜索：无书源/禁用书源返回空，未知书源报错', async () => {
  const { service } = await makeService()
  const empty = await service.searchBooks({ key: '三体' })
  assert.deepEqual(empty, { books: [], errors: [] })

  await service.importSources({ payload: JSON.stringify([{ ...A, enabled: false }]) })
  const disabled = await service.searchBooks({ key: '三体' })
  assert.deepEqual(disabled, { books: [], errors: [] })

  await assert.rejects(() => service.getBookInfo({ sourceUrl: 'https://missing.example.com', bookUrl: 'https://a.example.com/b/1' }), /书源不存在/)
})

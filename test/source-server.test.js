import assert from 'node:assert/strict'
import test from 'node:test'

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
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

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  const books = fakeTable()
  const readRecords = fakeTable()
  let settingsValue = { theme: 'system', fontSize: 24, lineSpacing: 0.5 }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = { sources, books, readRecords, settings }
  return { service, map: sources.map, books: books.map, readRecords: readRecords.map }
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
  assert.match(saved.source.id, /^src-[0-9a-f]{24}$/)
  assert.equal(saved.source.bookSourceUrl, A.bookSourceUrl)
  const savedList = await service.listSources()
  assert.equal(savedList.sources.find((item) => item.bookSourceUrl === A.bookSourceUrl)?.bookSourceName, '甲源改')

  const deleted = await service.deleteSources({ urls: [A.bookSourceUrl, 'https://none.example.com'] })
  assert.equal(deleted.deleted, 1)
  assert.equal(map.size, 1)
})

test('书源批量启停：按存储 key 更新，删除兼容 URL', async () => {
  const { service } = await makeService()
  await service.importSources({ payload: JSON.stringify([A, B]) })
  const list = await service.listSources()
  const ids = list.sources.map((source) => source.id)
  assert.equal(ids.length, 2)

  const disabled = await service.setSourcesEnabled({ ids, enabled: false })
  assert.equal(disabled.updated, 2)
  const after = await service.listSources()
  assert.equal(after.sources.filter((source) => source.enabled === false).length, 2)

  const enabled = await service.setSourcesEnabled({ ids: [ids[0]], enabled: true })
  assert.equal(enabled.updated, 1)

  const byUrl = await service.deleteSources({ urls: [A.bookSourceUrl] })
  assert.equal(byUrl.deleted, 1)
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


test('书架：加入、排序、进度与删除', async () => {
  const { service, books, readRecords } = await makeService()
  const book = {
    origin: 'https://a.example.com',
    originName: '甲源',
    bookUrl: 'https://a.example.com/book/1',
    name: '三体',
    author: '刘慈欣',
    tocUrl: 'https://a.example.com/toc/1',
  }

  const added = await service.addBook({ book })
  assert.equal(added.book.name, '三体')
  assert.match(added.book.id, /^[0-9a-f]{40}$/)
  assert.equal(books.size, 1)

  const again = await service.addBook({ book: { ...book, name: '三体（新版）' } })
  assert.equal(again.book.id, added.book.id)
  assert.equal(books.get(added.book.id).name, '三体（新版）')

  await service.saveProgress({
    bookId: added.book.id,
    chapterIndex: 3,
    chapterTitle: '第三章',
    chapterUrl: 'https://a.example.com/chapter/3',
    position: 1200,
  })
  const progress = await service.getProgress({ bookId: added.book.id })
  assert.equal(progress.progress.chapterIndex, 3)
  assert.equal(progress.progress.chapterTitle, '第三章')
  assert.ok(readRecords.get(added.book.id).updatedAt)
  assert.equal(books.get(added.book.id).lastReadAt, readRecords.get(added.book.id).updatedAt)

  const list = await service.listBooks()
  assert.equal(list.books.length, 1)
  assert.equal(list.books[0].name, '三体（新版）')

  const removed = await service.removeBooks({ ids: [added.book.id] })
  assert.equal(removed.deleted, 1)
  assert.equal(books.size, 0)
  assert.equal(readRecords.size, 0)
})

test('设置：读取默认值与合并保存', async () => {
  const { service } = await makeService()
  const initial = await service.getSettings()
  assert.equal(initial.settings.fontSize, 24)

  const saved = await service.saveSettings({ settings: { fontSize: 28 } })
  assert.equal(saved.settings.fontSize, 28)
  assert.equal(saved.settings.theme, 'system')

  const again = await service.getSettings()
  assert.equal(again.settings.fontSize, 28)
})

import test from 'node:test'
import assert from 'node:assert/strict'

async function loadShelfPagination() {
  let captured
  const previousWindow = globalThis.window
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    __ModuleLoader__: { load(config) { captured = config } },
  }
  globalThis.__MO_READER_TEST__ = true
  const require = (id) => {
    if (id === 'react') return {
      createElement: (...args) => ({ args }),
      useEffect() {}, useLayoutEffect() {},
      useMemo(fn) { return fn() },
      useRef(value) { return { current: value } },
      useState(value) { return [value, () => {}] },
    }
    if (id === 'zod') return { z: { json: () => ({}) } }
    throw new Error(`unexpected require: ${id}`)
  }
  try {
    await import(`../client.js?shelf-pagination-test=${Date.now()}`)
    assert.ok(captured, 'client.js should register a module')
    const hooks = captured.factory(require).__test
    assert.ok(hooks?.shelfPagination, 'test hook exposes shelf pagination')
    return hooks.shelfPagination
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__MO_READER_TEST__
  }
}

const books = (count) => Array.from({ length: count }, (_, index) => ({
  id: `book-${index + 1}`,
  name: `书 ${index + 1}`,
  updatedAt: index + 1,
}))

test('桌面按 wall 宽度限制为 3–8 列，并按可用高度限制为 1–3 行', async () => {
  const pagination = await loadShelfPagination()
  assert.equal(pagination.geometry({ width: 300, height: 600 }).columns, 3)
  assert.equal(pagination.geometry({ width: 580, height: 600 }).columns, 4)
  assert.equal(pagination.geometry({ width: 725, height: 600 }).columns, 5)
  assert.equal(pagination.geometry({ width: 870, height: 600 }).columns, 6)
  assert.equal(pagination.geometry({ width: 1015, height: 600 }).columns, 7)
  assert.equal(pagination.geometry({ width: 1160, height: 600 }).columns, 8)
  assert.equal(pagination.geometry({ width: 2000, height: 600 }).columns, 8)
  assert.equal(pagination.geometry({ width: 1236, height: 890, count: 13 }).columns, 7)
  const short = pagination.geometry({ width: 600, height: 250 })
  assert.equal(short.rows, 1)
  assert.ok(short.rowHeight <= 198, `矮窗口的行高越界：${short.rowHeight}`)
  assert.equal(pagination.geometry({ width: 600, height: 600 }).rows, 2)
  assert.equal(pagination.geometry({ width: 600, height: 1200 }).rows, 3)
})

test('手机 3 列，2–3 行随高度；空列表仍有一个可渲染空页', async () => {
  const pagination = await loadShelfPagination()
  const mobile = pagination.geometry({ width: 350, height: 400, mobile: true })
  assert.deepEqual([mobile.columns, mobile.rows, mobile.capacity], [3, 2, 6])
  const roomy = pagination.geometry({ width: 390, height: 540, mobile: true })
  assert.deepEqual([roomy.columns, roomy.rows, roomy.capacity], [3, 3, 9])
  const empty = pagination.paginate([], 4, mobile)
  assert.equal(empty.page, 0)
  assert.equal(empty.pageCount, 1)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.anchorId, null)
})

test('分页覆盖全部书、尾页与页码钳制，不截断数据集', async () => {
  const pagination = await loadShelfPagination()
  const geometry = { columns: 4, rows: 3, capacity: 12 }
  const all = books(140)
  const first = pagination.paginate(all, 0, geometry)
  const last = pagination.paginate(all, 99, geometry)
  assert.equal(first.pageCount, 12)
  assert.equal(first.items.length, 12)
  assert.equal(first.anchorId, 'book-1')
  assert.equal(last.page, 11)
  assert.equal(last.items.length, 8)
  assert.equal(last.items.at(-1).id, 'book-140')
  assert.equal(pagination.paginate(all, -5, geometry).page, 0)
})

test('筛选、搜索、文件夹和排序共用同一份完整结果集', async () => {
  const pagination = await loadShelfPagination()
  const input = [
    { id: 'a', name: 'Alpha', folderId: 'f1', lastRead: { chapterId: 'c', percent: 20 }, updatedAt: 1, createdAt: 2 },
    { id: 'b', name: 'Beta', folderId: 'f1', unreadCount: 3, updatedAt: 4, createdAt: 4 },
    { id: 'c', name: 'Alpine', folderId: 'f2', downloadStatus: 'completed', updatedAt: 3, createdAt: 3 },
    { id: 'd', name: 'Delta', folderId: 'f1', download: { status: 'completed' }, updatedAt: 2, createdAt: 1 },
    { id: 'root', name: 'Root', updatedAt: 5, createdAt: 5 },
  ]
  assert.deepEqual(pagination.selectBooks(input).map((book) => book.id), ['root'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f1', filter: 'reading' }).map((book) => book.id), ['a'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f1', filter: 'updates' }).map((book) => book.id), ['b'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f2', filter: 'downloaded' }).map((book) => book.id), ['c'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f1', filter: 'downloaded' }).map((book) => book.id), ['d'])
  assert.deepEqual(pagination.selectBooks(input, { query: 'alp', folder: 'f1' }).map((book) => book.id), ['a'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f1', sortBy: 'name' }).map((book) => book.id), ['a', 'b', 'd'])
  assert.deepEqual(pagination.selectBooks(input, { folder: 'f1', sortBy: 'added' }).map((book) => book.id), ['b', 'a', 'd'])
  assert.deepEqual(pagination.sortBooks([
    { id: 'old', lastReadAt: '2025-01-01T00:00:00.000Z' },
    { id: 'new', lastReadAt: '2026-01-01T00:00:00.000Z' },
  ], 'recent').map((book) => book.id), ['new', 'old'])
})

test('操作结果键只在搜索/筛选/排序/文件夹语义变化时改变', async () => {
  const pagination = await loadShelfPagination()
  const base = { query: 'foo', filter: 'all', sortBy: 'recent', folder: null }
  assert.equal(pagination.resultKey(base), pagination.resultKey({ ...base }))
  for (const patch of [{ query: 'bar' }, { filter: 'updates' }, { sortBy: 'name' }, { folder: 'f1' }]) {
    assert.notEqual(pagination.resultKey(base), pagination.resultKey({ ...base, ...patch }))
  }
})

test('resize 与 polling 都按稳定书籍 ID 找回 anchor，连续变化不累积漂移', async () => {
  const pagination = await loadShelfPagination()
  const all = books(80)
  const original = pagination.paginate(all, 3, { capacity: 20 })
  assert.equal(original.anchorId, 'book-61')
  const narrowPage = pagination.anchorPage(all, original.anchorId, { capacity: 12 }, original.page)
  assert.equal(narrowPage, 5)
  const widePage = pagination.anchorPage(all, original.anchorId, { capacity: 30 }, narrowPage)
  assert.equal(widePage, 2)
  assert.ok(pagination.paginate(all, widePage, { capacity: 30 }).items.some((book) => book.id === original.anchorId))

  const refreshed = [{ id: 'new', name: '新書' }, ...all]
  assert.equal(pagination.anchorPage(refreshed, original.anchorId, { capacity: 30 }, widePage), 2)
  assert.equal(pagination.anchorPage(refreshed, 'missing', { capacity: 30 }, 99), 2)
})

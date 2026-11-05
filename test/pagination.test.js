import test from 'node:test'
import assert from 'node:assert/strict'

async function loadPagination() {
  let captured
  const fakeWindow = {
    matchMedia: () => ({ matches: false }),
    __ModuleLoader__: { load(config) { captured = config } },
  }
  const require = (id) => {
    if (id === 'react') {
      return {
        createElement: (...args) => ({ args }),
        useEffect() {},
        useMemo(fn) { return fn() },
        useRef(value) { return { current: value } },
        useState(value) { return [value, () => {}] },
      }
    }
    if (id === 'zod') return { z: { json: () => ({}) } }
    throw new Error(`unexpected require: ${id}`)
  }
  const previousWindow = globalThis.window
  globalThis.window = fakeWindow
  globalThis.__MO_READER_TEST__ = true
  let plugin
  try {
    await import(`../client.js?pagination-test=${Date.now()}`)
    assert.ok(captured, 'client.js should register a module')
    plugin = captured.factory(require)
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__MO_READER_TEST__
  }
  assert.ok(plugin.__test?.pagination, 'test hook exposes pagination math')
  return plugin.__test.pagination
}

test('column and page counts keep the last column from becoming an empty page', async () => {
  const math = await loadPagination()
  assert.equal(math.totalColumns(600, 280, 20), 2)
  assert.equal(math.totalColumns(900, 280, 20), 3)
  assert.equal(math.totalColumns(100, 280, 20), 1)
  assert.equal(math.pageCount(1, 1), 1)
  assert.equal(math.pageCount(6, 1), 6)
  assert.equal(math.pageCount(6, 2), 5)
  assert.equal(math.pageCount(2, 2), 1)
})

test('percent and page conversions round-trip and clamp at both ends', async () => {
  const math = await loadPagination()
  assert.equal(math.pageForPercent(0, 6), 0)
  assert.equal(math.pageForPercent(60, 6), 3)
  assert.equal(math.pageForPercent(100, 6), 5)
  assert.equal(math.pageForPercent(-10, 6), 0)
  assert.equal(math.pageForPercent(200, 6), 5)
  assert.equal(math.pageForPercent(50, 1), 0)
  assert.equal(math.percentForPage(0, 6), 0)
  assert.equal(math.percentForPage(3, 6), 60)
  assert.equal(math.percentForPage(5, 6), 100)
  assert.equal(math.percentForPage(99, 6), 100)
  assert.equal(math.percentForPage(2, 1), 0)
  for (let page = 0; page < 6; page += 1) {
    assert.equal(math.pageForPercent(math.percentForPage(page, 6), 6), page)
  }
})

test('character anchors translate back to the same column after resize', async () => {
  const math = await loadPagination()
  const base = { pageIndex: 0, pageStep: 300, layoutLeft: 0, step: 300, pages: 6 }
  assert.equal(math.columnForAnchor({ ...base, anchorLeft: 0 }), 0)
  assert.equal(math.columnForAnchor({ ...base, anchorLeft: 300 }), 1)
  assert.equal(math.columnForAnchor({ ...base, anchorLeft: 9999 }), 5)
  assert.equal(math.columnForAnchor({ ...base, pageIndex: 2, anchorLeft: 0 }), 2)
  assert.equal(math.columnForAnchor({ ...base, anchorLeft: -300 }), 0)
})

test('a two-column spread maps its second visible column to the next page', async () => {
  const math = await loadPagination()
  const pages = math.pageCount(math.totalColumns(1800, 280, 20), 2)
  assert.equal(pages, 5)
  assert.equal(math.columnForAnchor({ anchorLeft: 0, pageIndex: 1, pageStep: 300, layoutLeft: 0, step: 300, pages }), 1)
  assert.equal(math.columnForAnchor({ anchorLeft: 300, pageIndex: 1, pageStep: 300, layoutLeft: 0, step: 300, pages }), 2)
})

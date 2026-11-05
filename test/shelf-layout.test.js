import test from 'node:test'
import assert from 'node:assert/strict'

async function loadShelfTestHooks() {
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
    await import(`../client.js?shelf-layout-test=${Date.now()}`)
    assert.ok(captured, 'client.js should register a module')
    plugin = captured.factory(require)
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__MO_READER_TEST__
  }
  assert.ok(plugin.__test?.shelfLayout, 'test hook exposes shelf layout')
  return plugin.__test
}

async function loadShelfLayout() {
  return (await loadShelfTestHooks()).shelfLayout
}

test('shelf layout exposes a flat grid and the last-read book', async () => {
  const layout = await loadShelfLayout()

  const empty = layout([])
  assert.equal(empty.books.length, 0)
  assert.equal(empty.count, 0)
  assert.equal(empty.lastRead, null)
  assert.equal(empty.faces, 1)

  const one = layout([{ name: '书' }])
  assert.equal(one.books.length, 1)
  assert.equal(one.count, 1)
  assert.equal(one.lastRead.name, '书')

  const many = Array.from({ length: 48 }, (_, index) => ({ name: `书${index + 1}` }))
  const full = layout(many)
  assert.equal(full.books.length, 48)
  assert.equal(full.count, 48)
  assert.equal(full.books[0].name, '书1')
  assert.equal(full.lastRead.name, '书1')
})

test('shelf layout picks the most recent readable book and caps at 48', async () => {
  const layout = await loadShelfLayout()

  const picked = layout([
    { name: '甲' },
    { name: '乙', lastRead: { chapterId: 'c1', percent: 42 } },
    { name: '丙' },
  ])
  assert.equal(picked.lastRead.name, '乙')

  const capped = layout(Array.from({ length: 50 }, (_, index) => ({ name: `书${index + 1}` })))
  assert.equal(capped.count, 48)
  assert.equal(capped.books.at(-1).name, '书48')
})

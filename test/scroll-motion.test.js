import test from 'node:test'
import assert from 'node:assert/strict'

async function loadScrollMotion() {
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
    await import(`../client.js?scroll-motion-test=${Date.now()}`)
    assert.ok(captured, 'client.js should register a module')
    plugin = captured.factory(require)
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__MO_READER_TEST__
  }
  assert.ok(plugin.__test?.scrollMotion, 'test hook exposes scroll motion math')
  return plugin.__test.scrollMotion
}

test('scroll progress clamps at both ends', async () => {
  const motion = await loadScrollMotion()
  assert.equal(motion.progress(-1), 0)
  assert.equal(motion.progress(0), 0)
  assert.equal(motion.progress(0.5), 0.5)
  assert.equal(motion.progress(2), 1)
  assert.equal(motion.progress('0.25'), 0.25)
  assert.equal(motion.progress('nope'), 0)
})

test('axis thickness moves from the bottom to the top as progress grows', async () => {
  const motion = await loadScrollMotion()
  const start = motion.axis(0, 900)
  assert.equal(start.visible, true)
  assert.equal(start.min, 5)
  assert.equal(start.max, 44)
  assert.equal(start.top, 5)
  assert.equal(start.bottom, 44)
  const middle = motion.axis(0.5, 900)
  assert.equal(middle.top, 24.5)
  assert.equal(middle.bottom, 24.5)
  const end = motion.axis(1, 900)
  assert.equal(end.top, 44)
  assert.equal(end.bottom, 5)
})

test('axis maximum shrinks on short viewports and hides on short chapters', async () => {
  const motion = await loadScrollMotion()
  const compact = motion.axis(0, 400)
  assert.equal(compact.max, 24)
  assert.equal(compact.top, 5)
  assert.equal(compact.bottom, 24)
  const short = motion.axis(0.4, 900, { short: true })
  assert.equal(short.visible, false)
  assert.equal(short.top, 0)
  assert.equal(short.bottom, 0)
})

test('reduced motion pins both axes to the minimum', async () => {
  const motion = await loadScrollMotion()
  const still = motion.axis(0.8, 900, { still: true })
  assert.equal(still.visible, true)
  assert.equal(still.top, 5)
  assert.equal(still.bottom, 5)
})

test('smoothing approaches the target and velocity keeps its sign', async () => {
  const motion = await loadScrollMotion()
  let current = 0
  for (let index = 0; index < 120; index += 1) {
    current = motion.smooth(current, 1, 16, 7)
  }
  assert.ok(current > 0.99 && current <= 1)
  assert.equal(motion.smooth(0.4, 0.4, 16, 7), 0.4)
  assert.ok(motion.velocity(0, 0.1, 16) > 0)
  assert.ok(motion.velocity(0.1, 0, 16) < 0)
  assert.equal(motion.velocity(0.2, 0.2, 16), 0)
})

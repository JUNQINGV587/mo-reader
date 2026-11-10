import test from 'node:test'
import assert from 'node:assert/strict'

async function loadSettings() {
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
    await import(`../client.js?settings-test=${Date.now()}`)
    assert.ok(captured, 'client.js should register a module')
    plugin = captured.factory(require)
  } finally {
    globalThis.window = previousWindow
    delete globalThis.__MO_READER_TEST__
  }
  assert.ok(plugin.__test?.Settings, 'test hook exposes the Settings component')
  return plugin.__test.Settings
}

test('settings returns every panel and keeps enhanced stats inside reading stats', async () => {
  const Settings = await loadSettings()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  let tree
  try {
    tree = Settings({
      settings: { replacements: [] },
      onSettings() {},
      onLocal() {},
      onExport() {},
      onImport() {},
      onExportNotes() {},
      onUploadFont() {},
      busy: false,
    })
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }

  assert.equal(tree.args[0], 'div')
  assert.equal(tree.args[1].className, 'mr-settings')
  const children = tree.args.slice(2)
  assert.equal(children.length, 14, 'page header plus all thirteen panels remain in the returned tree')
  const headings = children.slice(1).map((panel) => panel.args[2].args[2])
  assert.deepEqual(headings, [
    '动画', '默认排版', '替换净化', '本地书籍', '备份恢复', '分期说明',
    '阅读统计', '笔记导出', '夜间定时', '听书定时', '阅读目标', '自定义字体', '快捷键',
  ])

  const stats = children[7]
  assert.deepEqual(stats.args.slice(3).map((child) => child.args[1].className), [
    'mr-stats-grid', 'mr-heatmap', 'mr-yearly-stats',
    'mr-duration-dist', 'mr-time-dist', 'mr-trend-chart',
  ])
})

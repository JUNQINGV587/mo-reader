import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, normalizeSettings } from '../lib/settings.js'

test('desktop reading measure defaults to 960 while preserving explicit choices', () => {
  assert.equal(DEFAULT_SETTINGS.measureWidth, 960)
  assert.equal(DEFAULT_SETTINGS.mediaQuotaBytes, 50 * 1024 ** 3)
  assert.equal(normalizeSettings({ mediaQuotaBytes: 2 * 1024 ** 3 }).mediaQuotaBytes, 2 * 1024 ** 3)
  assert.throws(() => normalizeSettings({ mediaQuotaBytes: 1 }), /mediaQuotaBytes/)
  assert.throws(() => normalizeSettings({ mediaQuotaBytes: 2 * 1024 ** 3 + 0.5 }), /mediaQuotaBytes/)
  assert.equal(normalizeSettings().measureWidth, 960)
  assert.equal(normalizeSettings({ measureWidth: 800 }).measureWidth, 800)
})

test('settings writes drop retired builtin bookkeeping keys', () => {
  const current = { ...DEFAULT_SETTINGS, builtinSourcesAt: '2026-01-01T00:00:00.000Z', builtinSourcesVersion: 2 }
  const value = normalizeSettings({ fontSize: 20 }, current)
  assert.equal(value.fontSize, 20)
  assert.equal('builtinSourcesAt' in value, false)
  assert.equal('builtinSourcesVersion' in value, false)
  assert.equal('builtinSourcesAt' in normalizeSettings({}, DEFAULT_SETTINGS), false)
})

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
  return plugin.__test
}

test('settings returns every non-stats panel', async () => {
  const { Settings } = await loadSettings()
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
  assert.equal(tree.args[1].className, 'mr-screen mr-settings mr-settings-screen')
  const children = tree.args.slice(2)
  assert.equal(children.length, 2, 'screen heading plus the settings grid')
  const grid = children[1]
  assert.equal(grid.args[1].className, 'mr-settings-grid')
  const panels = grid.args.slice(2)
  assert.equal(panels.length, 13, 'stats is no longer inside settings; media cache quota is')
  const headings = panels.map((panel) => panel.args[2].args[2])
  assert.ok(!headings.includes('阅读统计'), 'settings still contains reading stats')
  assert.deepEqual(headings, [
    '动画', '默认排版', '替换净化', '媒体缓存', '本地书籍', '备份恢复', '支持范围',
    '笔记导出', '夜间定时', '听书定时', '阅读目标', '自定义字体', '快捷键',
  ])
})

test('stats is a standalone screen beside settings', async () => {
  const { Stats } = await loadSettings()
  const previousStorage = globalThis.localStorage
  globalThis.localStorage = { getItem: () => null }
  let tree
  try {
    tree = Stats()
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage
    else globalThis.localStorage = previousStorage
  }

  assert.equal(tree.args[0], 'div')
  assert.equal(tree.args[1].className, 'mr-screen mr-stats-screen')
  const children = tree.args.slice(2)
  assert.equal(children.length, 2, 'stats heading plus the stats layout')
  const layout = children[1]
  assert.equal(layout.args[1].className, 'mr-stats-layout')
  const section = layout.args[2]
  assert.equal(section.args[1].className, 'mr-panel mr-panel--wide')
  assert.equal(section.args[2].args[2], '概览')
  assert.deepEqual(section.args.slice(3).map((child) => child.args[1].className), [
    'mr-stats-grid', 'mr-heatmap', 'mr-yearly-stats',
    'mr-duration-dist', 'mr-time-dist', 'mr-trend-chart',
  ])
})

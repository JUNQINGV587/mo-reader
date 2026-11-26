import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 阅读设置底座（#124）：默认值、校验、全局与每书覆盖合并、预设补丁。
 * 只测纯模块的对外行为，不碰存储与界面。
 */
const {
  defaultReaderSettings,
  normalizeReaderSettings,
  normalizeBookOverrides,
  mergeReaderSettings,
  diffReaderSettings,
  presetSettingsPatch,
  hasBookOverrides,
  READER_SETTING_GROUPS,
  READER_PRESETS,
} = await import('../dist/core/reader/settings.js')

test('默认阅读设置与规格一致', () => {
  const settings = defaultReaderSettings()
  assert.equal(settings.fontId, '')
  assert.equal(settings.fontSize, 24)
  assert.equal(settings.letterSpacing, 0)
  assert.equal(settings.lineSpacing, 1.8)
  assert.equal(settings.paragraphSpacing, 6)
  assert.equal(settings.indent, 2)
  assert.equal(settings.bold, false)
  assert.equal(settings.titleMode, 0)
  assert.equal(settings.titleSize, 4)
  assert.equal(settings.align, 'left')
  assert.equal(settings.compressPunctuation, true)
  assert.equal(settings.kinsoku, true)
  assert.equal(settings.theme, 'light')
  assert.deepEqual(settings.padding, { left: 22, top: 5, right: 22, bottom: 4 })
  assert.equal(settings.headerMode, 1)
  assert.equal(settings.footerMode, 6)
  assert.equal(settings.showHeaderLine, true)
  assert.equal(settings.showFooterLine, true)
  assert.equal(settings.dualColumn, false)
  assert.equal(settings.inkMode, false)
  assert.equal(settings.pageAnimation, 'cover')
  assert.equal(settings.tapZones.length, 9)
  assert.deepEqual(settings.menuItems, ['prev', 'settings', 'toc', 'next'])
  assert.equal(settings.autoPageSeconds, 10)
  assert.equal(settings.ttsVoice, '')
  assert.equal(settings.ttsRate, 1)
  assert.equal(settings.ttsContinuous, true)
  assert.deepEqual(settings.replaceRules, [])
})

test('默认值是独立副本，改一份不影响另一份', () => {
  const first = defaultReaderSettings()
  first.tapZones[4] = 1
  first.padding.left = 40
  first.replaceRules.push({ id: 'r1', pattern: 'a', replacement: 'b', regex: false, enabled: true })
  const second = defaultReaderSettings()
  assert.equal(second.tapZones[4], 0)
  assert.equal(second.padding.left, 22)
  assert.equal(second.replaceRules.length, 0)
})

test('设置分组覆盖排版、页面、操作、朗读、替换', () => {
  assert.deepEqual(
    READER_SETTING_GROUPS.map((group) => group.label),
    ['排版', '页面', '操作', '朗读', '替换'],
  )
  const fields = READER_SETTING_GROUPS.flatMap((group) => group.fields)
  assert.ok(fields.includes('fontSize'))
  assert.ok(fields.includes('pageAnimation'))
  assert.ok(fields.includes('tapZones'))
  assert.ok(fields.includes('ttsRate'))
  assert.ok(fields.includes('replaceRules'))
})
test('旧记录缺字段时补齐默认值，旧值原样保留', () => {
  const settings = normalizeReaderSettings({
    fontSize: 22,
    lineSpacing: 1.9,
    theme: 'sepia',
    headerMode: 3,
    padding: { left: 18, top: 2, right: 20, bottom: 6 },
  })
  const defaults = defaultReaderSettings()
  assert.equal(settings.fontSize, 22)
  assert.equal(settings.lineSpacing, 1.9)
  assert.equal(settings.theme, 'sepia')
  assert.equal(settings.headerMode, 3)
  assert.deepEqual(settings.padding, { left: 18, top: 2, right: 20, bottom: 6 })
  assert.equal(settings.letterSpacing, defaults.letterSpacing)
  assert.equal(settings.titleMode, defaults.titleMode)
  assert.equal(settings.ttsRate, defaults.ttsRate)
  assert.deepEqual(settings.tapZones, defaults.tapZones)
})

test('数字越界钳到边界，缩进只取 0 或 2 字', () => {
  const settings = normalizeReaderSettings({
    fontSize: 999,
    letterSpacing: 12,
    lineSpacing: 0.1,
    paragraphSpacing: 99,
    indent: 5,
    titleMode: 9,
    titleSize: 99,
    headerMode: 20,
    autoPageSeconds: 0,
    ttsRate: 9,
    padding: { left: 0, top: 99, right: 99, bottom: -5 },
  })
  assert.equal(settings.fontSize, 48)
  assert.equal(settings.letterSpacing, 4)
  assert.equal(settings.lineSpacing, 1.2)
  assert.equal(settings.paragraphSpacing, 24)
  assert.equal(settings.indent, 2)
  assert.equal(settings.titleMode, 3)
  assert.equal(settings.titleSize, 8)
  assert.equal(settings.headerMode, 11)
  assert.equal(settings.autoPageSeconds, 1)
  assert.equal(settings.ttsRate, 2)
  assert.deepEqual(settings.padding, { left: 8, top: 32, right: 48, bottom: 0 })

  const small = normalizeReaderSettings({ fontSize: -30, lineSpacing: 9, autoPageSeconds: 600, ttsRate: 0, indent: 0 })
  assert.equal(small.fontSize, 12)
  assert.equal(small.lineSpacing, 2.6)
  assert.equal(small.autoPageSeconds, 60)
  assert.equal(small.ttsRate, 0.5)
  assert.equal(small.indent, 0)
})

test('未知枚举回落默认，主题仍校验存在', () => {
  const settings = normalizeReaderSettings({ align: 'center', pageAnimation: 'flip', theme: 'nope' })
  assert.equal(settings.align, 'left')
  assert.equal(settings.pageAnimation, 'cover')
  assert.equal(settings.theme, 'light')

  const custom = { id: 'theme-abc12345', name: '夜蓝', bg: '#000', text: '#fff', muted: '#888', line: '#333', createdAt: '2026-01-01' }
  const withCustom = normalizeReaderSettings({ theme: 'theme-abc12345', customThemes: [custom] })
  assert.equal(withCustom.theme, 'theme-abc12345')
  assert.equal(withCustom.customThemes.length, 1)
})

test('非法类型不抛错，逐项回落且不丢其他设置', () => {
  const settings = normalizeReaderSettings({
    fontSize: 'abc',
    bold: 'yes',
    showHeaderLine: 0,
    tapZones: 'x',
    menuItems: {},
    replaceRules: 5,
    padding: null,
    headerMode: 4,
  })
  const defaults = defaultReaderSettings()
  assert.equal(settings.fontSize, defaults.fontSize)
  assert.equal(settings.bold, defaults.bold)
  assert.equal(settings.showHeaderLine, defaults.showHeaderLine)
  assert.deepEqual(settings.tapZones, defaults.tapZones)
  assert.deepEqual(settings.menuItems, defaults.menuItems)
  assert.deepEqual(settings.replaceRules, [])
  assert.deepEqual(settings.padding, defaults.padding)
  assert.equal(settings.headerMode, 4)
})

test('tapZones 不是 9 项回落默认，越界项钳制', () => {
  assert.deepEqual(normalizeReaderSettings({ tapZones: [2, 2, 1] }).tapZones, defaultReaderSettings().tapZones)
  const clamped = normalizeReaderSettings({ tapZones: [99, -9, 3, 7, 0, 1, 2, 13, -1] }).tapZones
  assert.deepEqual(clamped, [13, -1, 3, 7, 0, 1, 2, 13, -1])
})

test('menuItems 只保留已知项，全未知时回落默认', () => {
  assert.deepEqual(normalizeReaderSettings({ menuItems: ['toc', 'nope', 'toc', 'prev'] }).menuItems, ['toc', 'prev'])
  assert.deepEqual(normalizeReaderSettings({ menuItems: ['nope'] }).menuItems, defaultReaderSettings().menuItems)
  assert.deepEqual(normalizeReaderSettings({ menuItems: [] }).menuItems, defaultReaderSettings().menuItems)
})

test('未知字段原样保留', () => {
  const settings = normalizeReaderSettings({ fontSize: 26, futureFlag: { a: 1 } })
  assert.equal(settings.fontSize, 26)
  assert.deepEqual(settings.futureFlag, { a: 1 })
})

test('替换规则保留合法项并补齐缺省字段', () => {
  const settings = normalizeReaderSettings({
    replaceRules: [{ id: 'r1', pattern: '甲', replacement: '乙' }, { pattern: '没有 id' }, 'bad'],
  })
  assert.deepEqual(settings.replaceRules, [{ id: 'r1', pattern: '甲', replacement: '乙', regex: false, enabled: true }])
  assert.deepEqual(normalizeReaderSettings({ replaceRules: 'x' }).replaceRules, [])
})
test('本书只覆盖改过的字段，其他继承全局', () => {
  const global = normalizeReaderSettings({ fontSize: 24, lineSpacing: 1.8, theme: 'dark', paragraphSpacing: 6 })
  const merged = mergeReaderSettings(global, { fontSize: 30 })
  assert.equal(merged.fontSize, 30)
  assert.equal(merged.lineSpacing, 1.8)
  assert.equal(merged.paragraphSpacing, 6)
  assert.equal(merged.theme, 'dark')
})

test('本书覆盖的边距与全局深合并', () => {
  const merged = mergeReaderSettings(
    { fontSize: 24, padding: { left: 22, top: 5, right: 22, bottom: 4 } },
    { padding: { left: 30 } },
  )
  assert.deepEqual(merged.padding, { left: 30, top: 5, right: 22, bottom: 4 })
})

test('本书覆盖不落全局专属字段，主题按全局主题表校验', () => {
  const custom = { id: 'theme-abc12345', name: '夜蓝', bg: '#000', text: '#fff', muted: '#888', line: '#333', createdAt: '2026-01-01' }
  const global = normalizeReaderSettings({ theme: 'light', customThemes: [custom] })
  const overrides = normalizeBookOverrides({
    id: 'b1', bookId: 'b1', updatedAt: 't', createdAt: 't',
    theme: 'theme-abc12345', customThemes: [custom], mediaQuotaBytes: 123, fontSize: 26, futureFlag: 1,
  })
  assert.deepEqual(overrides, { theme: 'theme-abc12345', fontSize: 26, futureFlag: 1 })
  const merged = mergeReaderSettings(global, overrides)
  assert.equal(merged.theme, 'theme-abc12345')
  assert.equal(merged.customThemes.length, 1)
  assert.equal(merged.mediaQuotaBytes, 0)
  assert.equal(merged.fontSize, 26)
  assert.equal(merged.futureFlag, 1)

  const invalid = mergeReaderSettings({ theme: 'dark' }, { theme: 'theme-missing' })
  assert.equal(invalid.theme, 'dark')
})

test('diff 只返回变化字段，padding 需要整块更新', () => {
  const before = defaultReaderSettings()
  assert.deepEqual(diffReaderSettings(before, before), {})
  const changed = diffReaderSettings(before, { ...before, fontSize: 30 })
  assert.deepEqual(changed, { fontSize: 30 })
  const padding = diffReaderSettings(before, { ...before, padding: { ...before.padding, left: 30 } })
  assert.deepEqual(padding, { padding: { left: 30, top: 5, right: 22, bottom: 4 } })
})

test('hasBookOverrides 判断是否存在覆盖', () => {
  assert.equal(hasBookOverrides(undefined), false)
  assert.equal(hasBookOverrides({ id: 'b1', bookId: 'b1', updatedAt: 't' }), false)
  assert.equal(hasBookOverrides({ id: 'b1', fontSize: 30 }), true)
})

test('6 套预设只写排版与页面字段，不改操作、朗读、替换', () => {
  assert.equal(READER_PRESETS.length, 6)
  for (const preset of READER_PRESETS) {
    const patch = presetSettingsPatch(preset)
    assert.deepEqual(Object.keys(patch).sort(), ['fontSize', 'indent', 'lineSpacing', 'padding', 'paragraphSpacing'])
    assert.equal(patch.fontSize, preset.fontSize)
    assert.deepEqual(patch.padding, preset.padding)
    assert.notEqual(patch.padding, preset.padding, '补丁里的边距应是独立副本')
  }
  const before = defaultReaderSettings()
  const applied = diffReaderSettings(before, { ...before, ...presetSettingsPatch(READER_PRESETS[4]) })
  assert.ok('fontSize' in applied, '预设字号应写入')
})
test('恢复本节默认不含自定义主题（页面分区也不清空主题资产）', async () => {
  const { defaultGroupSettings } = await import('../dist/core/reader/settings.js')
  const page = defaultGroupSettings('page')
  assert.equal('customThemes' in page, false)
  assert.equal(page.theme, 'light')
  const speak = defaultGroupSettings('speak')
  assert.deepEqual(Object.keys(speak).sort(), ['ttsContinuous', 'ttsRate', 'ttsVoice'])
})

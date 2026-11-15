import assert from 'node:assert/strict'
import test from 'node:test'
const {
  READER_PRESETS,
  TAP_ACTIONS,
  TAP_ZONE_NAMES,
  DEFAULT_TAP_ZONES,
  TIP_MODES,
  tipText,
  tapZoneIndex,
  tapActionLabel,
  MENU_ITEMS,
} = await import('../dist/core/reader/reader-config.js')

test('6 套排版预设，数值在可用范围', () => {
  assert.equal(READER_PRESETS.length, 6)
  assert.equal(READER_PRESETS[0].name, '微信读书')
  for (const preset of READER_PRESETS) {
    assert.ok(preset.fontSize >= 14 && preset.fontSize <= 34, preset.key)
    assert.ok(preset.lineSpacing >= 1.2 && preset.lineSpacing <= 2.6, preset.key)
    assert.ok(preset.indent === 0 || preset.indent === 2)
    assert.ok(preset.padding.left > 0 && preset.padding.right > 0)
  }
})

test('九宫格：9 个区域、默认中间为菜单、13 个动作', () => {
  assert.equal(DEFAULT_TAP_ZONES.length, 9)
  assert.equal(TAP_ZONE_NAMES.length, 9)
  assert.equal(DEFAULT_TAP_ZONES[4], 0)
  const codes = TAP_ACTIONS.map((action) => action.code)
  assert.ok(codes.includes(-1))
  for (let code = 0; code <= 13; code += 1) assert.ok(codes.includes(code), String(code))
  assert.equal(tapActionLabel(3), '下一章')
})

test('点击坐标换算九宫格', () => {
  assert.equal(tapZoneIndex(0.1, 0.1), 0)
  assert.equal(tapZoneIndex(0.5, 0.5), 4)
  assert.equal(tapZoneIndex(0.9, 0.9), 8)
  assert.equal(tapZoneIndex(0.5, 0.9), 7)
  assert.equal(tapZoneIndex(0.9, 0.5), 5)
})

test('页眉页脚 12 种模式与文本', () => {
  assert.equal(TIP_MODES.length, 12)
  assert.equal(TIP_MODES[0].label, '无')
  const ctx = { bookName: '完美世界', chapterTitle: '第1章', page: 2, totalPages: 5, bookPercent: 33.3, time: '08:30' }
  assert.equal(tipText(0, ctx), '')
  assert.equal(tipText(1, ctx), '第1章')
  assert.equal(tipText(4, ctx), '2')
  assert.equal(tipText(6, ctx), '2/5')
  assert.equal(tipText(7, ctx), '完美世界')
  assert.equal(tipText(5, ctx), '33%')
  assert.equal(tipText(3, ctx), '—')
})

test('底栏菜单 4 项', () => {
  assert.deepEqual(MENU_ITEMS.map((item) => item.key), ['prev', 'settings', 'toc', 'next'])
})

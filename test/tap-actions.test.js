import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 九宫格动作（#126）：隐藏正文编辑/替换开关/全文搜索/同步进度，旧配置回退为无动作。
 * 朗读三项（上段/下段/暂停）留给朗读切片，这里只保证不被隐藏。
 */
const {
  TAP_ACTIONS,
  HIDDEN_TAP_ACTION_CODES,
  visibleTapActions,
  isHiddenTapAction,
  sanitizeTapZones,
} = await import('../dist/core/reader/reader-config.js')

test('隐藏的动作就是 8/9/11/12', () => {
  assert.deepEqual([...HIDDEN_TAP_ACTION_CODES].sort((a, b) => a - b), [8, 9, 11, 12])
  const labels = HIDDEN_TAP_ACTION_CODES.map((code) => TAP_ACTIONS.find((item) => item.code === code)?.label)
  assert.deepEqual(labels, ['正文编辑', '替换开关', '全文搜索', '同步进度'])
})

test('选择器只列未隐藏的动作', () => {
  const codes = visibleTapActions().map((action) => action.code)
  assert.deepEqual(codes, [-1, 0, 1, 2, 3, 4, 5, 6, 7, 10, 13])
  for (const code of [5, 6, 13]) {
    assert.ok(codes.includes(code), `朗读动作 ${code} 不应被隐藏`)
    assert.equal(TAP_ACTIONS.find((action) => action.code === code)?.available, true, `朗读动作 ${code} 应可用`)
  }
  for (const code of HIDDEN_TAP_ACTION_CODES) assert.equal(isHiddenTapAction(code), true)
  assert.equal(isHiddenTapAction(1), false)
})

test('旧配置落到隐藏动作时回退为无动作', () => {
  const result = sanitizeTapZones([8, 2, 9, 2, 0, 11, 2, 12, 2])
  assert.deepEqual(result.zones, [-1, 2, -1, 2, 0, -1, 2, -1, 2])
  assert.deepEqual(result.resetZones, [0, 2, 5, 7])
  assert.equal(result.changed, true)
})

test('合法配置原样返回，不提示', () => {
  const zones = [2, 2, 1, 2, 0, 1, 2, 1, 2]
  const result = sanitizeTapZones(zones)
  assert.deepEqual(result.zones, zones)
  assert.deepEqual(result.resetZones, [])
  assert.equal(result.changed, false)
})

test('坏配置回落到默认九宫格', () => {
  const result = sanitizeTapZones([1, 2])
  assert.deepEqual(result.zones, [2, 2, 1, 2, 0, 1, 2, 1, 2])
  assert.equal(result.changed, false)
  const stray = sanitizeTapZones([99, -9, 1, 2, 0, 1, 2, 1, 2])
  assert.deepEqual(stray.zones, [-1, -1, 1, 2, 0, 1, 2, 1, 2])
})
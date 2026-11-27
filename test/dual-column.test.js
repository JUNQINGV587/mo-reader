import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 双栏可用宽度（#123）：界面开关与排版共用同一个门槛。
 * 前置：npm run build:server（测试 import 的是 dist）。
 */
const {
  DUAL_COLUMN_MIN_WIDTH,
  dualColumnFitsContent,
  dualColumnAvailability,
} = await import('../dist/core/reader/paginate.js')

test('双栏门槛是 480px 可用宽度', () => {
  assert.equal(DUAL_COLUMN_MIN_WIDTH, 480)
  assert.equal(dualColumnFitsContent(480), true)
  assert.equal(dualColumnFitsContent(479.9), false)
})

test('按视口宽度减左右留白判断双栏', () => {
  assert.equal(dualColumnAvailability(480, { left: 0, right: 0 }), true)
  assert.equal(dualColumnAvailability(479.9, { left: 0, right: 0 }), false)
  assert.equal(dualColumnAvailability(524, { left: 22, right: 22 }), true)
  assert.equal(dualColumnAvailability(523, { left: 22, right: 22 }), false)
  assert.equal(dualColumnAvailability(600, { left: 30, right: 40 }), true)
  assert.equal(dualColumnAvailability(540, { left: 30, right: 40 }), false)
})

test('留白不是有限数字时按 0 计算', () => {
  assert.equal(dualColumnAvailability(480, { left: Number.NaN, right: Number.POSITIVE_INFINITY }), true)
})

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 阅读页手势判定（#152）：滑动翻页 / 快速轻扫 / 滚动模式纵向过渡 / 长按选词。
 * 只测纯函数：阈值边界、方向、两种手势模式、四种输出。
 */
const {
  LONG_PRESS_MS,
  LONG_PRESS_TOLERANCE,
  SWIPE_DISTANCE,
  SWIPE_MIN_DISTANCE,
  SWIPE_SPEED,
  gestureModeFor,
  resolveReaderGesture,
} = await import('../dist/core/reader/swipe-gesture.js')

/** 慢速滑动：600ms 内走完 60px，速度 0.1px/ms，只按位移判定。 */
const SLOW = 600

const page = (dx, dy, durationMs = SLOW) =>
  resolveReaderGesture({ dx, dy, durationMs, mode: 'page' })
const scroll = (dx, dy, durationMs = SLOW) =>
  resolveReaderGesture({ dx, dy, durationMs, mode: 'scroll' })

test('阈值常量与票面一致', () => {
  assert.equal(LONG_PRESS_MS, 500)
  assert.equal(LONG_PRESS_TOLERANCE, 10)
  assert.equal(SWIPE_DISTANCE, 60)
  assert.equal(SWIPE_MIN_DISTANCE, 20)
  assert.equal(SWIPE_SPEED, 0.5)
})

test('四种翻页形态映射到两种手势模式', () => {
  assert.equal(gestureModeFor('scroll'), 'scroll')
  for (const kind of ['none', 'cover', 'slide', 'simulate']) {
    assert.equal(gestureModeFor(kind), 'page', `${kind} 应按分页处理`)
  }
})

test('翻页模式：水平位移到 60px 才翻页', () => {
  assert.equal(page(-59, 0), 'none')
  assert.equal(page(-60, 0), 'next')
  assert.equal(page(59, 0), 'none')
  assert.equal(page(60, 0), 'prev')
})

test('翻页模式：快速轻扫不足 60px 也翻页，反向回上一页', () => {
  // 30px / 60ms = 0.5px/ms，正好压线
  assert.equal(page(-30, 0, 60), 'next')
  // 30px / 80ms = 0.375px/ms，低于速度阈值、又不足 60px
  assert.equal(page(-30, 0, 80), 'none')
  assert.equal(page(30, 0, 60), 'prev')
  // 速度够快但主轴位移不足 20px：防误触不翻页
  assert.equal(page(-19, 0, 5), 'none')
  assert.equal(page(-20, 0, 40), 'next')
})

test('翻页模式：纵向与对角线不误翻页', () => {
  assert.equal(page(0, -120), 'none')
  assert.equal(page(5, 120), 'none')
  assert.equal(page(80, 120), 'none')
  assert.equal(page(50, 60), 'none')
  assert.equal(page(120, 80), 'prev')
})

test('滚动模式：纵向滑动走 scroll 纵向过渡', () => {
  assert.equal(scroll(0, -59), 'none')
  assert.equal(scroll(0, -60), 'next')
  assert.equal(scroll(0, 60), 'prev')
  assert.equal(scroll(-5, -100), 'next')
})

test('滚动模式：水平滑动与纵向轻扫都不触发水平翻页', () => {
  assert.equal(scroll(-120, 0), 'none')
  assert.equal(scroll(120, 0), 'none')
  assert.equal(scroll(-100, 10, 30), 'none')
  // 纵向快速轻扫同样生效
  assert.equal(scroll(0, -30, 60), 'next')
  assert.equal(scroll(0, -30, 80), 'none')
  assert.equal(scroll(0, 19, 5), 'none')
})

test('长按边界：按住 ≥500ms 且位移 <10px', () => {
  assert.equal(page(0, 0, 499), 'none')
  assert.equal(page(0, 0, 500), 'longpress')
  assert.equal(scroll(0, 0, 500), 'longpress')
  // 位移 9.22px 仍在容差内
  assert.equal(page(6, 7, 800), 'longpress')
  // 位移正好 10px 不再算长按
  assert.equal(page(10, 0, 800), 'none')
  assert.equal(scroll(0, -59, 800), 'none')
})

test('长按后移动超过 10px 视为滑动或取消', () => {
  assert.equal(page(11, 0, 800), 'none')
  assert.equal(page(0, 11, 800), 'none')
  assert.equal(page(-80, 0, 800), 'next')
  assert.equal(scroll(0, -80, 800), 'next')
})

test('四种输出都能出现', () => {
  const results = new Set([
    page(0, 0, 100),
    page(-70, 0, 300),
    page(70, 0, 300),
    page(0, 0, 600),
  ])
  assert.deepEqual([...results].sort(), ['longpress', 'next', 'none', 'prev'])
})

test('异常输入不误判', () => {
  assert.equal(resolveReaderGesture({ dx: NaN, dy: 0, durationMs: 100, mode: 'page' }), 'none')
  assert.equal(resolveReaderGesture({ dx: -100, dy: 0, durationMs: -5, mode: 'page' }), 'next')
  assert.equal(resolveReaderGesture({ dx: 0, dy: 0, durationMs: NaN, mode: 'scroll' }), 'none')
})

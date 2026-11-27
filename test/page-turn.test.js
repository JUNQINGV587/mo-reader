import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 翻页形态（#126）：覆盖 / 平移 / 仿真 / 滚动 / 无动画。
 * 只测纯模型：时长、减少动态效果、五种形态的帧数据与方向。
 */
const {
  PAGE_TURN_MS,
  resolvePageTurn,
  pageTurnFrame,
  turnDurationMs,
} = await import('../dist/core/reader/page-turn.js')

const SIZE = { width: 400, height: 600 }

test('动画时长落在 260–320ms', () => {
  assert.ok(PAGE_TURN_MS >= 260, `时长 ${PAGE_TURN_MS} 小于 260`)
  assert.ok(PAGE_TURN_MS <= 320, `时长 ${PAGE_TURN_MS} 大于 320`)
  assert.equal(turnDurationMs('cover'), PAGE_TURN_MS)
  assert.equal(turnDurationMs('slide'), PAGE_TURN_MS)
  assert.equal(turnDurationMs('simulate'), PAGE_TURN_MS)
  assert.equal(turnDurationMs('scroll'), PAGE_TURN_MS)
  assert.equal(turnDurationMs('none'), 0)
})

test('系统减少动态效果与墨水屏一律无动画', () => {
  for (const kind of ['cover', 'slide', 'simulate', 'scroll']) {
    assert.equal(resolvePageTurn(kind, { reducedMotion: true }), 'none')
    assert.equal(resolvePageTurn(kind, { inkMode: true }), 'none')
    assert.equal(resolvePageTurn(kind, { reducedMotion: true, inkMode: true }), 'none')
  }
  assert.equal(resolvePageTurn('cover'), 'cover')
  assert.equal(resolvePageTurn('none', { reducedMotion: true }), 'none')
})

test('五种翻页的形态互不相同', () => {
  const kinds = ['cover', 'slide', 'simulate', 'scroll', 'none']
  const signatures = kinds.map((kind) => {
    const frame = pageTurnFrame(kind, 1, 0.5, SIZE)
    return JSON.stringify({ from: frame.from, to: frame.to, curl: frame.curl })
  })
  assert.equal(new Set(signatures).size, kinds.length, `形态重复：${signatures.join(' | ')}`)
})

test('覆盖：新页从右滑入，旧页不动', () => {
  const begin = pageTurnFrame('cover', 1, 0, SIZE)
  assert.deepEqual(begin.from, { x: 0, y: 0 })
  assert.equal(begin.to.x, SIZE.width)
  assert.equal(begin.to.y, 0)
  const end = pageTurnFrame('cover', 1, 1, SIZE)
  assert.equal(end.to.x, 0)
})

test('平移：旧页左移、新页同速右进', () => {
  const middle = pageTurnFrame('slide', 1, 0.5, SIZE)
  assert.ok(middle.from.x < 0, '旧页应向左移')
  assert.ok(middle.to.x > 0, '新页应还在右侧')
  assert.equal(middle.from.y, 0)
  assert.equal(middle.to.y, 0)
})

test('滚动：两页沿纵向移动', () => {
  const frame = pageTurnFrame('scroll', 1, 0.5, SIZE)
  assert.ok(frame.from.y < 0, '旧页应向上移')
  assert.ok(frame.to.y > 0, '新页应从下方向上')
  assert.equal(frame.from.x, 0)
  assert.equal(frame.to.x, 0)
})

test('仿真：带 Canvas 卷页折线，不是纯位移', () => {
  const frame = pageTurnFrame('simulate', 1, 0.5, SIZE)
  assert.ok(frame.curl, '仿真需要给出卷页参数')
  assert.ok(frame.curl.foldX > 0 && frame.curl.foldX < SIZE.width)
  assert.ok(frame.curl.shadowWidth > 0)
  assert.equal(pageTurnFrame('cover', 1, 0.5, SIZE).curl, null)
  const early = pageTurnFrame('simulate', 1, 0.1, SIZE)
  const late = pageTurnFrame('simulate', 1, 0.9, SIZE)
  assert.ok(early.curl.foldX > late.curl.foldX, '折线应随进度向左推进')
})

test('无动画：不产生位移，时长为 0', () => {
  assert.equal(turnDurationMs('none'), 0)
  for (const progress of [0, 0.5, 1]) {
    const frame = pageTurnFrame('none', 1, progress, SIZE)
    assert.deepEqual(frame.from, { x: 0, y: 0 })
    assert.deepEqual(frame.to, { x: 0, y: 0 })
    assert.equal(frame.curl, null)
  }
})

test('反方向逐项镜像', () => {
  const mirror = (value) => (value === 0 ? 0 : -value)
  for (const kind of ['cover', 'slide', 'scroll']) {
    const forward = pageTurnFrame(kind, 1, 0.5, SIZE)
    const backward = pageTurnFrame(kind, -1, 0.5, SIZE)
    assert.equal(backward.from.x, mirror(forward.from.x))
    assert.equal(backward.from.y, mirror(forward.from.y))
    assert.equal(backward.to.x, mirror(forward.to.x))
    assert.equal(backward.to.y, mirror(forward.to.y))
  }
})

test('进度越界钳制、缓动单调', () => {
  const below = pageTurnFrame('cover', 1, -1, SIZE)
  assert.equal(below.progress, 0)
  assert.equal(below.to.x, SIZE.width)
  const above = pageTurnFrame('cover', 1, 2, SIZE)
  assert.equal(above.progress, 1)
  assert.equal(above.to.x, 0)
  const quarter = pageTurnFrame('cover', 1, 0.25, SIZE).to.x
  const half = pageTurnFrame('cover', 1, 0.5, SIZE).to.x
  assert.ok(quarter > half, '缓动后位移应单调减少')
})
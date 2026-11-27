import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 翻页动画调度（#126）：同一时间只有一个动画；新翻页打断旧的；
 * 切后台/尺寸变化/关闭时取消；时长钳在 260–320ms。
 */
const { TurnAnimator, TURN_MIN_MS, TURN_MAX_MS } = await import('../dist/core/reader/turn-animator.js')

const makeClock = (start = 0) => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
  }
}

const makeAnimator = (clock) => {
  const updates = []
  const completes = []
  const cancels = []
  const animator = new TurnAnimator({
    now: clock.now,
    onUpdate: (state) => updates.push(state),
    onComplete: (state) => completes.push(state),
    onCancel: (reason) => cancels.push(reason),
  })
  return { animator, updates, completes, cancels }
}

const SIZE = { width: 300, height: 600 }

test('整段动画按时长完成，只回调一次完成', () => {
  const clock = makeClock()
  const { animator, updates, completes } = makeAnimator(clock)
  animator.begin('cover', 1, SIZE)
  assert.equal(TURN_MIN_MS, 260)
  assert.equal(TURN_MAX_MS, 320)
  assert.equal(animator.animating, true)
  assert.equal(animator.durationMs, 280)
  clock.advance(140)
  animator.tick()
  assert.equal(updates.length, 1)
  assert.ok(Math.abs(updates[0].progress - 0.5) < 0.001)
  assert.equal(updates[0].frame.to.x, Math.round((1 - updates[0].eased) * SIZE.width))
  clock.advance(140)
  animator.tick()
  assert.equal(animator.animating, false)
  assert.equal(completes.length, 1)
  assert.equal(completes[0].progress, 1)
  animator.tick()
  assert.equal(updates.length, 2, '完成后不再出帧')
})

test('时长钳在 260–320ms', () => {
  const clock = makeClock()
  const { animator } = makeAnimator(clock)
  animator.begin('cover', 1, { ...SIZE, durationMs: 80 })
  assert.equal(animator.durationMs, 260)
  animator.begin('cover', 1, { ...SIZE, durationMs: 900 })
  assert.equal(animator.durationMs, 320)
})

test('新翻页打断旧动画并画目标页', () => {
  const clock = makeClock()
  const { animator, cancels } = makeAnimator(clock)
  animator.begin('cover', 1, SIZE)
  clock.advance(100)
  animator.tick()
  animator.begin('slide', -1, SIZE)
  assert.deepEqual(cancels, ['interrupt'])
  assert.equal(animator.animating, true)
  assert.equal(animator.current.kind, 'slide')
  assert.equal(animator.current.direction, -1)
  assert.equal(animator.current.progress, 0)
  assert.equal(animator.current.target.x, -SIZE.width)
})

test('切后台/尺寸变化/关闭取消动画', () => {
  for (const reason of ['hidden', 'resize', 'close']) {
    const clock = makeClock()
    const { animator, cancels, updates } = makeAnimator(clock)
    animator.begin('simulate', 1, SIZE)
    clock.advance(100)
    animator.cancel(reason)
    assert.equal(animator.animating, false)
    assert.deepEqual(cancels, [reason])
    animator.tick()
    assert.equal(updates.length, 0)
  }
})

test('无动画形态立即完成，不占用动画', () => {
  const clock = makeClock()
  const { animator, completes } = makeAnimator(clock)
  animator.begin('none', 1, SIZE)
  assert.equal(animator.animating, false)
  assert.equal(animator.durationMs, 0)
  assert.equal(completes.length, 1)
})
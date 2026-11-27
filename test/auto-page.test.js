import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 自动翻页控制器（#126）：注入时钟的纯逻辑，不碰真实定时器。
 * 覆盖间隔边界、暂停原因、重置时机、章末续章与全书末尾。
 */
const { AutoPageController, AUTO_PAGE_BOOK_END_MESSAGE } = await import('../dist/core/reader/auto-page.js')

const makeClock = (start = 0) => {
  let now = start
  return {
    now: () => now,
    advance: (ms) => {
      now += ms
    },
    set: (value) => {
      now = value
    },
  }
}

const setup = ({ page = 0, pages = 5, hasNextChapter = true, seconds = 10 } = {}) => {
  const clock = makeClock(1000)
  const controller = new AutoPageController({ now: clock.now })
  controller.setSeconds(seconds)
  controller.setPosition({ page, pages, hasNextChapter })
  return { clock, controller }
}

test('间隔默认 10 秒，钳在 1~60', () => {
  const controller = new AutoPageController({ now: () => 0 })
  assert.equal(controller.seconds, 10)
  controller.setSeconds(0)
  assert.equal(controller.seconds, 1)
  controller.setSeconds(1)
  assert.equal(controller.seconds, 1)
  controller.setSeconds(60)
  assert.equal(controller.seconds, 60)
  controller.setSeconds(61)
  assert.equal(controller.seconds, 60)
  controller.setSeconds(Number.NaN)
  assert.equal(controller.seconds, 60)
  controller.setSeconds(10.6)
  assert.equal(controller.seconds, 11)
})

test('开始后满 10 秒才翻一页，翻完重新计时', () => {
  const { clock, controller } = setup()
  controller.start()
  assert.equal(controller.status, 'running')
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(9999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.deepEqual(controller.tick(), { kind: 'turn', page: 1 })
  assert.equal(controller.position.page, 1)
  clock.advance(9999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.deepEqual(controller.tick(), { kind: 'turn', page: 2 })
})

test('暂停原因分别生效，原因清空才恢复并重置计时', () => {
  const { clock, controller } = setup()
  controller.start()
  clock.advance(4000)
  controller.addPauseReason('menu')
  assert.equal(controller.status, 'paused')
  clock.advance(60000)
  assert.equal(controller.tick().kind, 'idle')
  controller.addPauseReason('toc')
  controller.removePauseReason('menu')
  assert.equal(controller.status, 'paused', '还有目录原因时不能恢复')
  controller.removePauseReason('toc')
  assert.equal(controller.status, 'running')
  clock.advance(9999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.deepEqual(controller.tick(), { kind: 'turn', page: 1 })
})

test('手动翻页与改速度都重置计时', () => {
  const { clock, controller } = setup()
  controller.start()
  clock.advance(7000)
  controller.notifyTurn()
  clock.advance(9999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.equal(controller.tick().kind, 'turn')
  clock.advance(6000)
  controller.setSeconds(3)
  clock.advance(2999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.equal(controller.tick().kind, 'turn')
})

test('章末先请求下一章，加载成功从新章首页继续', () => {
  const { clock, controller } = setup({ page: 2, pages: 3 })
  controller.start()
  clock.advance(10000)
  assert.deepEqual(controller.tick(), { kind: 'load-chapter' })
  assert.equal(controller.status, 'paused')
  controller.loadedChapter({ pages: 4 })
  assert.equal(controller.status, 'running')
  assert.equal(controller.position.page, 0)
  clock.advance(9999)
  assert.equal(controller.tick().kind, 'wait')
  clock.advance(1)
  assert.deepEqual(controller.tick(), { kind: 'turn', page: 1 })
})

test('章末加载失败暂停并提示，继续后重试', () => {
  const { clock, controller } = setup({ page: 2, pages: 3 })
  controller.start()
  clock.advance(10000)
  assert.equal(controller.tick().kind, 'load-chapter')
  controller.failedChapter('下一章加载失败')
  assert.equal(controller.status, 'paused')
  assert.match(controller.notice, /加载失败/)
  assert.equal(controller.tick().kind, 'idle')
  controller.resume()
  assert.equal(controller.status, 'running')
  clock.advance(10000)
  assert.deepEqual(controller.tick(), { kind: 'load-chapter' })
})

test('全书末尾停止并提示', () => {
  const { clock, controller } = setup({ page: 2, pages: 3, hasNextChapter: false })
  controller.start()
  clock.advance(10000)
  assert.deepEqual(controller.tick(), { kind: 'book-end', message: AUTO_PAGE_BOOK_END_MESSAGE })
  assert.equal(AUTO_PAGE_BOOK_END_MESSAGE, '已到全书末尾')
  assert.equal(controller.status, 'idle')
  assert.equal(controller.notice, '已到全书末尾')
  assert.equal(controller.tick().kind, 'idle')
})

test('状态条文案带当前间隔，停止后清空', () => {
  const { controller } = setup({ seconds: 10 })
  controller.start()
  assert.equal(controller.label, '自动翻页 · 10 秒')
  controller.setSeconds(60)
  assert.equal(controller.label, '自动翻页 · 60 秒')
  controller.stop()
  assert.equal(controller.status, 'idle')
  assert.equal(controller.label, '')
})

test('朗读可挂起自动翻页，原因清空后由宿主决定是否恢复', () => {
  const { clock, controller } = setup()
  controller.start()
  clock.advance(5000)
  controller.addPauseReason('tts')
  assert.equal(controller.status, 'paused')
  clock.advance(60000)
  assert.equal(controller.tick().kind, 'idle')
  controller.removePauseReason('tts')
  assert.equal(controller.status, 'running')
  clock.advance(10000)
  assert.deepEqual(controller.tick(), { kind: 'turn', page: 1 })
})

test('新建实例是空闲态，不跨刷新继承运行状态', () => {
  const first = new AutoPageController({ now: () => 0 })
  first.start()
  assert.equal(first.status, 'running')
  const second = new AutoPageController({ now: () => 0 })
  assert.equal(second.status, 'idle')
  assert.equal(second.seconds, 10)
})
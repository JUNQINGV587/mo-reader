import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 常亮控制器（#126）：运行期申请 Wake Lock，可见时重申请，停止/离开释放；
 * 拒绝或 API 不存在只提示一次，不阻塞翻页。
 */
const { KeepAwake, WAKE_LOCK_UNAVAILABLE_MESSAGE } = await import('../dist/core/reader/wake-lock.js')

const makeSentinel = () => {
  const sentinel = {
    released: false,
    releaseCount: 0,
    async release() {
      sentinel.released = true
      sentinel.releaseCount += 1
    },
  }
  return sentinel
}

const makeFakeLock = () => {
  const state = { requests: 0, sentinels: [], fail: null }
  return {
    state,
    request: async () => {
      state.requests += 1
      if (state.fail) throw state.fail
      const sentinel = makeSentinel()
      state.sentinels.push(sentinel)
      return sentinel
    },
  }
}

test('运行期申请一次，重复申请复用同一个', async () => {
  const lock = makeFakeLock()
  const notices = []
  const keep = new KeepAwake({ request: lock.request, onNotice: (message) => notices.push(message) })
  await keep.acquire()
  assert.equal(keep.active, true)
  assert.equal(lock.state.requests, 1)
  await keep.acquire()
  assert.equal(lock.state.requests, 1)
  assert.deepEqual(notices, [])
})

test('页面隐藏再可见时重新申请', async () => {
  const lock = makeFakeLock()
  const keep = new KeepAwake({ request: lock.request })
  await keep.acquire()
  await keep.visibilityChanged(false)
  assert.equal(keep.active, false)
  await keep.visibilityChanged(true)
  assert.equal(lock.state.requests, 2)
  assert.equal(keep.active, true)
})

test('释放后不再重申请', async () => {
  const lock = makeFakeLock()
  const keep = new KeepAwake({ request: lock.request })
  await keep.acquire()
  const sentinel = lock.state.sentinels[0]
  await keep.release()
  assert.equal(keep.active, false)
  assert.equal(sentinel.releaseCount, 1)
  await keep.visibilityChanged(true)
  assert.equal(lock.state.requests, 1)
})

test('系统拒绝时提示一次，不抛错也不阻塞', async () => {
  const lock = makeFakeLock()
  lock.state.fail = new Error('NotAllowedError')
  const notices = []
  const keep = new KeepAwake({ request: lock.request, onNotice: (message) => notices.push(message) })
  await keep.acquire()
  assert.equal(keep.active, false)
  assert.deepEqual(notices, [WAKE_LOCK_UNAVAILABLE_MESSAGE])
  assert.equal(WAKE_LOCK_UNAVAILABLE_MESSAGE, '无法保持常亮')
  await keep.acquire()
  assert.deepEqual(notices, [WAKE_LOCK_UNAVAILABLE_MESSAGE])
})

test('API 不存在时同样只提示一次', async () => {
  const notices = []
  const keep = new KeepAwake({
    request: async () => {
      throw new TypeError('navigator.wakeLock is undefined')
    },
    onNotice: (message) => notices.push(message),
  })
  await keep.acquire()
  await keep.acquire()
  assert.deepEqual(notices, [WAKE_LOCK_UNAVAILABLE_MESSAGE])
  assert.equal(keep.active, false)
})

test('系统自行释放后再可见仍会重新申请', async () => {
  const lock = makeFakeLock()
  const keep = new KeepAwake({ request: lock.request })
  await keep.acquire()
  lock.state.sentinels[0].released = true
  await keep.visibilityChanged(false)
  await keep.visibilityChanged(true)
  assert.equal(lock.state.requests, 2)
  assert.equal(keep.active, true)
})
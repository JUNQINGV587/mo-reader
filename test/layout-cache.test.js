import { test } from 'node:test'
import assert from 'node:assert/strict'

const load = () => import('../dist/core/reader/layout-cache.js')

test('排版缓存：键由内容、设置、视口共同决定', async () => {
  const { layoutCacheKey } = await load()
  const base = { text: '第一章正文', settings: { fontSize: 22, lineSpacing: 1.9 }, viewport: { width: 390, height: 844 } }
  const key = layoutCacheKey(base)
  assert.equal(layoutCacheKey({ ...base, settings: { lineSpacing: 1.9, fontSize: 22 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, text: '第二章正文' }), key)
  assert.notEqual(layoutCacheKey({ ...base, settings: { fontSize: 24, lineSpacing: 1.9 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, viewport: { width: 391, height: 844 } }), key)
})

test('排版缓存：LRU 淘汰最久未用的排版结果', async () => {
  const { LayoutCache } = await load()
  const cache = new LayoutCache(2)
  cache.set('a', 1)
  cache.set('b', 2)
  assert.equal(cache.get('a'), 1)
  cache.set('c', 3)
  assert.equal(cache.get('a'), 1)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('c'), 3)
  cache.clear()
  assert.equal(cache.size, 0)
})

test('排版缓存：旧排版任务可以取消，启动前取消不会执行', async () => {
  const { createLayoutJob, LayoutCancelledError } = await load()
  let ran = false
  const cancelled = createLayoutJob(() => {
    ran = true
    return 'done'
  })
  cancelled.cancel()
  await assert.rejects(cancelled.promise, (error) => error instanceof LayoutCancelledError)
  assert.equal(ran, false)

  const normal = createLayoutJob(() => 'ok')
  assert.equal(await normal.promise, 'ok')
})

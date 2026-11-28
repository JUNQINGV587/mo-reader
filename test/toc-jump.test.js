import assert from 'node:assert/strict'
import test from 'node:test'

import { TOC_PAGE_SIZE, parseChapterJump, tocPageForIndex } from '../dist/core/reader/toc-page.js'

test('200 章一页：边界页与万章页码', () => {
  assert.equal(TOC_PAGE_SIZE, 200)
  assert.equal(tocPageForIndex(0), 1)
  assert.equal(tocPageForIndex(199), 1)
  assert.equal(tocPageForIndex(200), 2)
  assert.equal(tocPageForIndex(9999), 50)
  assert.equal(tocPageForIndex(-1), 1)
  assert.equal(tocPageForIndex(Number.NaN), 1)
})

test('章节号跳页：首尾与中间章节', () => {
  assert.deepEqual(parseChapterJump('1', 10000), { ok: true, index: 0, page: 1 })
  assert.deepEqual(parseChapterJump('200', 10000), { ok: true, index: 199, page: 1 })
  assert.deepEqual(parseChapterJump('201', 10000), { ok: true, index: 200, page: 2 })
  assert.deepEqual(parseChapterJump('10000', 10000), { ok: true, index: 9999, page: 50 })
})

test('章节号跳页：越界、非数字与空值给出可读提示', () => {
  assert.deepEqual(parseChapterJump('0', 10000), { ok: false, message: '章节号需在 1–10000 之间' })
  assert.deepEqual(parseChapterJump('10001', 10000), { ok: false, message: '章节号需在 1–10000 之间' })
  assert.deepEqual(parseChapterJump('1.5', 10000), { ok: false, message: '请输入整数章节号' })
  assert.deepEqual(parseChapterJump('abc', 10000), { ok: false, message: '请输入整数章节号' })
  assert.deepEqual(parseChapterJump('', 10000), { ok: false, message: '请输入章节号' })
})

test('目录为空或过滤后为空时入口不可用', () => {
  assert.deepEqual(parseChapterJump('1', 0), { ok: false, message: '目录还没有加载完成' })
  assert.deepEqual(parseChapterJump('1', -3), { ok: false, message: '目录还没有加载完成' })
})

test('过滤后按过滤结果计算页码，不按全量章节错位', () => {
  assert.deepEqual(parseChapterJump('1', 3), { ok: true, index: 0, page: 1 })
  assert.deepEqual(parseChapterJump('3', 3), { ok: true, index: 2, page: 1 })
  assert.deepEqual(parseChapterJump('4', 3), { ok: false, message: '章节号需在 1–3 之间' })
  const manyFiltered = Array.from({ length: 450 }, (_, i) => i + 1)
  assert.deepEqual(parseChapterJump('401', manyFiltered.length), { ok: true, index: 400, page: 3 })
})

test('万章定位只做一次整除，不遍历章节', () => {
  const started = performance.now()
  for (let i = 0; i < 10000; i += 1) tocPageForIndex(i)
  assert.ok(performance.now() - started < 100, '10000 次页码计算应在 100ms 内')
})

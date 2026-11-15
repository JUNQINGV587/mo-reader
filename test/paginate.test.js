import assert from 'node:assert/strict'
import test from 'node:test'

test('分页：按字宽折行、按行高切页', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('一二三四五六七八九十', {
    width: 148, // 148 - 48 = 100 → 每行 10 字（measure 每字 10）
    height: 120, // 120 - 36 - 28 = 56 → 每页 2 行
    indent: false,
    fontSize: 10,
    lineHeight: 28,
    measure: (value) => value.length * 10,
  })
  assert.equal(result.linesPerPage, 2)
  assert.deepEqual(result.pages[0], ['一二三四五六七八九十'])
})

test('分页：空行与多页', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('甲\n\n乙丙丁戊己庚辛', {
    width: 131, // 131-48=83 → 8 字/行
    height: 100, // 100-36-28=36 → 1 行/页
    indent: false,
    fontSize: 10,
    lineHeight: 28,
    measure: (value) => value.length * 10,
  })
  assert.equal(result.linesPerPage, 1)
  assert.ok(result.pages.length >= 3)
})

test('分页：段首缩进两个全角空格', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('春天来了', {
    width: 240,
    height: 200,
    fontSize: 10,
    lineHeight: 28,
    measure: (value) => value.length * 10,
  })
  assert.equal(result.lines[0], '　　春天来了')
})

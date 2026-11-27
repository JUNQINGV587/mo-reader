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


const LAYOUT_BASE = {
  width: 100,
  height: 200,
  padding: 0,
  headerHeight: 0,
  footerHeight: 0,
  fontSize: 10,
  lineHeight: 28,
  indent: false,
  measure: (value) => value.length * 10,
}

test('排版：双栏先左后右、等宽、栏距 24px', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('一'.repeat(200), {
    ...LAYOUT_BASE,
    width: 500,
    height: 120,
    lineHeight: 20,
    dualColumn: true,
  })
  assert.equal(result.columnCount, 2)
  assert.equal(result.dualColumnDisabledReason, null)
  const page = result.layout[0]
  assert.equal(page.columns.length, 2)
  const left = page.columns[0]
  const right = page.columns[1]
  assert.equal(left.x, 0)
  assert.equal(right.x, left.width + 24)
  assert.equal(left.width, right.width)
  assert.equal(left.width, 238)
  assert.equal(left.lines.length, 6)
  assert.ok(right.lines.length > 0)
  assert.equal(right.lines[0].start, left.lines[left.lines.length - 1].end)
  assert.equal(page.start, 0)
  assert.equal(page.end, 200)
})

test('排版：可用宽度不足 480px 时禁用双栏并说明原因', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const narrow = paginate('一'.repeat(40), {
    ...LAYOUT_BASE,
    width: 479,
    lineHeight: 20,
    dualColumn: true,
  })
  assert.equal(narrow.columnCount, 1)
  assert.equal(narrow.dualColumnDisabledReason, 'narrow')

  const wide = paginate('一'.repeat(40), {
    ...LAYOUT_BASE,
    width: 480,
    lineHeight: 20,
    dualColumn: true,
  })
  assert.equal(wide.columnCount, 2)
  assert.equal(wide.dualColumnDisabledReason, null)

  const scrolling = paginate('一'.repeat(40), {
    ...LAYOUT_BASE,
    width: 700,
    lineHeight: 20,
    dualColumn: true,
    scrollMode: true,
  })
  assert.equal(scrolling.columnCount, 1)
  assert.equal(scrolling.dualColumnDisabledReason, 'scroll')
})

test('排版：每行记录原文起止偏移，不重叠不断裂', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('甲乙丙丁\n戊己庚辛', {
    ...LAYOUT_BASE,
    width: 40,
    lineHeight: 20,
  })
  const lines = result.layout[0].columns[0].lines
  assert.deepEqual(lines.map((line) => line.text), ['甲乙丙丁', '戊己庚辛'])
  assert.equal(lines[0].start, 0)
  assert.equal(lines[0].end, 4)
  assert.equal(lines[1].start, 5)
  assert.equal(lines[1].end, 9)
  assert.equal(resultsText(result), '甲乙丙丁戊己庚辛')
  assert.equal(result.layout[0].start, 0)
  assert.equal(result.layout[0].end, 9)
})

function resultsText(result) {
  return result.layout
    .flatMap((page) => page.columns.flatMap((column) => column.lines))
    .filter((line) => line.text !== '')
    .map((line) => line.text)
    .join('')
}

test('排版：标题只出现一次，支持左中右与隐藏', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const make = (titleMode, title = '第一章', text = '正文正文正文') =>
    paginate(text, { ...LAYOUT_BASE, title, titleMode })
  for (const [mode, align] of [[0, 'left'], [1, 'center'], [3, 'right']]) {
    const result = make(mode)
    assert.equal(result.titleAlign, align)
    assert.equal(result.layout[0].titleLines.length, 1)
    assert.equal(result.layout[0].titleLines[0].text, '第一章')
    assert.equal(result.lines.filter((line) => line === '第一章').length, 1)
  }
  const hidden = make(2)
  assert.equal(hidden.titleAlign, null)
  assert.equal(hidden.layout[0].titleLines.length, 0)
  assert.equal(hidden.lines.filter((line) => line === '第一章').length, 0)

  const duplicated = make(0, '第一章', '第一章\n正文')
  assert.equal(duplicated.lines.filter((line) => line === '第一章').length, 1)
})

test('排版：标题过长折行且整块处理，不单独留在页底', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const wrapped = paginate('正文', {
    ...LAYOUT_BASE,
    title: '一二三四五六七八九十甲乙',
    titleMode: 0,
  })
  assert.deepEqual(
    wrapped.layout[0].titleLines.map((line) => line.text),
    ['一二三四五六七八九十', '甲乙'],
  )

  const block = paginate('正文正文正文', {
    ...LAYOUT_BASE,
    height: 56,
    title: '一二三四五六七八九十甲乙',
    titleMode: 0,
  })
  assert.equal(block.layout[0].titleLines.length, 2)
  assert.equal(block.layout[0].columns[0].lines.length, 0)
  assert.ok(block.layout[1].columns[0].lines.length > 0)
  assert.equal(block.pages.length, 2)
  assert.ok(block.pages.every((page) => page.length > 0))

  const pageBottom = paginate('正文'.repeat(10), {
    ...LAYOUT_BASE,
    height: 56,
    title: '第一章',
    titleMode: 0,
  })
  assert.equal(pageBottom.layout[0].titleLines.length, 1)
  assert.equal(pageBottom.layout[0].columns[0].lines.length, 1)
  const firstPageLast = pageBottom.layout[0].columns[0].lines.at(-1)
  assert.equal(firstPageLast.title, false)
  assert.equal(firstPageLast.text, '正文正文正文正文正文')
})

test('排版：避头尾，行首不出现收尾标点、行尾不出现起首标点', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const closing = paginate('一二三四五。六七八九十', {
    ...LAYOUT_BASE,
    width: 50,
    lineHeight: 20,
    kinsoku: true,
  })
  assert.ok(closing.lines.every((line) => !line.startsWith('。')))

  const withoutKinsoku = paginate('一二三四五。六七八九十', {
    ...LAYOUT_BASE,
    width: 50,
    lineHeight: 20,
  })
  assert.ok(withoutKinsoku.lines.some((line) => line.startsWith('。')))

  const opening = paginate('一二三四（五六七八', {
    ...LAYOUT_BASE,
    width: 40,
    lineHeight: 20,
    kinsoku: true,
  })
  assert.ok(opening.lines.every((line) => !line.endsWith('（')))
})

test('排版：两端对齐只作用于非末行，最多补 0.5em，补不过来退回左对齐', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const justified = paginate('一'.repeat(12), {
    ...LAYOUT_BASE,
    width: 100,
    lineHeight: 20,
    align: 'justify',
    measure: (value) => value.length * 9.5,
  })
  const first = justified.layout[0].columns[0].lines[0]
  assert.equal(first.text, '一'.repeat(10))
  assert.ok(Math.abs(first.justifyPx - 5 / 9) < 0.01)
  const last = justified.layout[0].columns[0].lines[1]
  assert.equal(last.text, '一一')
  assert.equal(last.justifyPx, 0)

  const capped = paginate('一二（三，四', {
    ...LAYOUT_BASE,
    width: 30,
    lineHeight: 20,
    align: 'justify',
    kinsoku: true,
  })
  const shortLine = capped.layout[0].columns[0].lines[0]
  assert.equal(shortLine.text, '一二')
  assert.equal(shortLine.justifyPx, 0)
})

test('排版：标点压缩不丢字，只让行更紧', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const text = '，。，。，。'
  const plain = paginate(text, { ...LAYOUT_BASE, width: 40, lineHeight: 20 })
  const compressed = paginate(text, {
    ...LAYOUT_BASE,
    width: 40,
    lineHeight: 20,
    compressPunctuation: true,
  })
  assert.equal(plain.lines.join(''), text)
  assert.equal(compressed.lines.join(''), text)
  assert.ok(plain.lines.length > compressed.lines.length)
  assert.equal(compressed.lines.length, 1)
})

test('排版：按字符偏移找回位置，重排后不跳回第一页', async () => {
  const { paginate, pageIndexForOffset } = await import('../dist/core/reader/paginate.js')
  const text = '一'.repeat(120)
  const base = { ...LAYOUT_BASE, width: 100, lineHeight: 20, height: 60 }
  const normal = paginate(text, base)
  assert.equal(normal.pages.length, 4)
  assert.equal(pageIndexForOffset(normal.layout, 0), 0)
  assert.equal(pageIndexForOffset(normal.layout, 35), 1)
  assert.equal(pageIndexForOffset(normal.layout, 95), 3)
  assert.equal(pageIndexForOffset(normal.layout, 999), 3)

  const narrow = paginate(text, { ...base, width: 50 })
  const page = pageIndexForOffset(narrow.layout, 95)
  const target = narrow.layout[page]
  assert.ok(target.start <= 95 && 95 < target.end)
})

test('排版：段距与文末换行不产生空白页', async () => {
  const { paginate } = await import('../dist/core/reader/paginate.js')
  const result = paginate('一'.repeat(30) + '\n', {
    ...LAYOUT_BASE,
    width: 100,
    height: 40,
    lineHeight: 20,
    paragraphSpacing: 8,
  })
  assert.ok(result.pages.every((page) => page.length > 0))
  assert.ok(result.pages.every((page) => page.join('') !== ''))
  assert.equal(result.pages.length, 2)
})


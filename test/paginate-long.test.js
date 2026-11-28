import assert from 'node:assert/strict'
import test from 'node:test'

const load = () => import('../dist/core/reader/paginate.js')
const loadCache = () => import('../dist/core/reader/layout-cache.js')

const CHARS = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐'

/** 固定种子生成约 20000 字、带自然段与标点的正文，避免测试受随机数影响。 */
function longText(target = 20000) {
  let seed = 7
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const paragraphs = []
  let length = 0
  while (length < target) {
    const size = 18 + Math.floor(random() * 60)
    let paragraph = ''
    for (let index = 0; index < size; index += 1) {
      paragraph += CHARS[Math.floor(random() * CHARS.length)]
    }
    if (paragraph.length % 7 === 0) paragraph += '，'
    paragraphs.push(paragraph)
    length += paragraph.length
  }
  return paragraphs.join('\n').slice(0, target)
}

const SETTINGS = {
  fontSize: 20,
  lineHeight: 1.7,
  paragraphSpacing: 8,
  indent: true,
  padding: { left: 24, right: 24, top: 12, bottom: 12 },
  letterSpacing: 0,
  bold: false,
  title: '第1章 超长章节',
  titleMode: 0,
  titleSize: 4,
  align: 'justify',
  compressPunctuation: true,
  kinsoku: true,
  dualColumn: false,
  animation: 'cover',
}

const VIEWPORT = { width: 326, height: 596 }

const measure = (value) => {
  let width = 0
  for (const char of value) width += /[\u3000-\u9fff]/.test(char) ? 20 : 10
  return width
}

function options(settings = SETTINGS, viewport = VIEWPORT) {
  return {
    width: viewport.width,
    height: viewport.height,
    fontSize: settings.fontSize,
    lineHeight: settings.fontSize * settings.lineHeight,
    padding: 0,
    headerHeight: 0,
    footerHeight: 0,
    indent: settings.indent,
    paragraphSpacing: settings.paragraphSpacing,
    letterSpacing: settings.letterSpacing,
    title: settings.title,
    titleMode: settings.titleMode,
    titleSize: settings.titleSize,
    align: settings.align,
    compressPunctuation: settings.compressPunctuation,
    kinsoku: settings.kinsoku,
    dualColumn: settings.dualColumn,
    scrollMode: settings.animation === 'scroll',
    measure,
  }
}

function layoutSignature(result) {
  return result.layout.map((page) => ({
    title: page.titleLines.map((line) => line.text),
    columns: page.columns.map((column) => column.lines.map((line) => [line.text, line.start, line.end])),
  }))
}

test('超长章节：20000 字单章分页覆盖全文且结果稳定', async () => {
  const { paginate } = await load()
  const text = longText()
  const first = paginate(text, options())
  assert.ok(first.pages.length > 50, '应有足够页数')
  assert.equal(first.layout.length, first.pages.length)
  assert.equal(first.text, text)
  const lastLine = first.layout.at(-1).columns.flatMap((column) => column.lines).filter((line) => line.text !== '').at(-1)
  assert.ok(lastLine.end > 19900, '最后一页应接近全文末尾')
  assert.ok(first.layout.every((page) => page.start >= 0 && page.end >= page.start))

  const second = paginate(text, options())
  assert.deepEqual(layoutSignature(second), layoutSignature(first), '相同输入应得到相同分页')
})

test('超长章节：缓存命中后连续翻 20 页不重复测量', async () => {
  const { paginate, pageIndexForOffset } = await load()
  const { LayoutCache, layoutCacheKey } = await loadCache()
  const text = longText()
  let measureCalls = 0
  const countingOptions = {
    ...options(),
    measure: (value) => {
      measureCalls += 1
      return measure(value)
    },
  }
  const key = layoutCacheKey({ text, settings: SETTINGS, viewport: VIEWPORT })
  const cache = new LayoutCache(6)
  const first = paginate(text, countingOptions)
  cache.set(key, first)
  const callsAfterLayout = measureCalls
  assert.ok(callsAfterLayout > 0, '首次排版必须测量字形')

  for (let turn = 0; turn < 20; turn += 1) {
    const cached = cache.get(key)
    assert.equal(cached, first, '翻页应复用同一份排版结果')
    const page = cached.layout[turn % cached.layout.length]
    assert.ok(page.columns.length > 0)
    pageIndexForOffset(cached.layout, page.start)
  }
  assert.equal(measureCalls, callsAfterLayout, '翻页不应再次调用测量函数')
  assert.equal(cache.size, 1)
})

test('超长章节：缓存键随字号、行距、视口与段落设置变化', async () => {
  const { LayoutCache, layoutCacheKey } = await loadCache()
  const text = longText(1200)
  const base = { text, settings: SETTINGS, viewport: VIEWPORT }
  const key = layoutCacheKey(base)
  assert.equal(
    layoutCacheKey({ text, settings: { ...SETTINGS }, viewport: { ...VIEWPORT } }),
    key,
    '对象键序与引用不应影响缓存键',
  )
  assert.notEqual(layoutCacheKey({ ...base, settings: { ...SETTINGS, fontSize: 22 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, settings: { ...SETTINGS, lineHeight: 1.9 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, settings: { ...SETTINGS, paragraphSpacing: 0 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, settings: { ...SETTINGS, letterSpacing: 2 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, viewport: { ...VIEWPORT, width: 327 } }), key)
  assert.notEqual(layoutCacheKey({ ...base, viewport: { ...VIEWPORT, height: 597 } }), key)

  const cache = new LayoutCache(2)
  cache.set(key, 'old')
  assert.equal(cache.get(layoutCacheKey({ ...base, viewport: { ...VIEWPORT, width: 327 } })), undefined)
})

test('超长章节：空章、单段、超长单段与窄窗口都不丢内容', async () => {
  const { paginate } = await load()
  const empty = paginate('', options())
  assert.equal(empty.pages.length, 1)
  assert.equal(empty.text, '')

  const single = paginate('一二三四五', options())
  assert.equal(single.layout.length, 1)
  assert.equal(single.layout[0].columns[0].lines[0].text, '　　一二三四五')

  const longParagraph = '一'.repeat(20000)
  const oneParagraph = paginate(longParagraph, options())
  assert.ok(oneParagraph.pages.length > 50)
  const covered = oneParagraph.layout
    .flatMap((page) => page.columns.flatMap((column) => column.lines))
    .filter((line) => !line.title && line.text !== '')
    .map((line) => line.text.replace(/^　　/, '').replace(/\s/g, ''))
    .join('')
  assert.equal(covered, longParagraph)

  const narrow = paginate(longText(2000), options(SETTINGS, { width: 160, height: 300 }))
  assert.ok(narrow.pages.length > 0)
  assert.ok(narrow.layout.every((page) => page.columns.every((column) => column.lines.every((line) => line.end <= 2000))))
})

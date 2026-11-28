#!/usr/bin/env node
// M7 一次性性能记录：node scripts/perf-m7.mjs
// 只测纯函数与数据整理，不启动浏览器、不接入 npm test；宿主首屏/目录/翻页的浏览器数字见 #157 评论。
import { paginate } from '../dist/core/reader/paginate.js'
import { LayoutCache, layoutCacheKey } from '../dist/core/reader/layout-cache.js'
import { tocPageForIndex, TOC_PAGE_SIZE } from '../dist/core/reader/toc-page.js'

const CHARS = '天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜海咸河淡鳞潜羽翔龙师火帝鸟官人皇始制文字乃服衣裳推位让国有虞陶唐'

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

function measure(value) {
  let width = 0
  for (const char of value) width += /[\u3000-\u9fff]/.test(char) ? 20 : 10
  return width
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
  return {
    min: +sorted[0].toFixed(3),
    median: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    max: +at(1).toFixed(3),
  }
}

function time(run, rounds = 1) {
  const values = []
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now()
    run(index)
    values.push(performance.now() - started)
  }
  return stats(values)
}

const settings = {
  fontSize: 20,
  lineHeight: 1.7,
  paragraphSpacing: 8,
  indent: true,
  letterSpacing: 0,
  title: '第1章 超长章节',
  titleMode: 0,
  titleSize: 4,
  align: 'justify',
  compressPunctuation: true,
  kinsoku: true,
  dualColumn: false,
  animation: 'cover',
}
const viewport = { width: 326, height: 596 }
const options = {
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
  scrollMode: false,
  measure,
}

const text = longText()
let lastResult = null
const firstPagination = time(() => { lastResult = paginate(text, options) }, 1)
const coldPagination = time(() => paginate(text, options), 5)
const cache = new LayoutCache(6)
const key = layoutCacheKey({ text, settings, viewport })
cache.set(key, lastResult)
const pageTurns = time((turn) => {
  const cached = cache.get(key)
  const page = cached.layout[turn % cached.layout.length]
  for (const column of page.columns) for (const line of column.lines) void line.end
}, 20)

const chapters = Array.from({ length: 10000 }, (_, index) => ({ index, title: '第' + (index + 1) + '章 测试章节' + index }))
const toc = time(() => {
  const page = tocPageForIndex(8999, TOC_PAGE_SIZE)
  const start = (page - 1) * TOC_PAGE_SIZE
  const window = chapters.slice(start, start + TOC_PAGE_SIZE)
  void window.length
}, 2000)

const books = Array.from({ length: 1000 }, (_, index) => ({
  id: 'perf-' + index,
  name: '压测书 ' + index,
  group: index % 10 === 0 ? '测试分组' : '',
  lastReadAt: index % 37 === 0 ? 0 : 1720000000000 + index,
  pinned: index % 97 === 0,
}))
const shelf = time(() => {
  const filtered = books.filter((book) => book.group === '' || book.group === '测试分组')
  filtered.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1
    return right.lastReadAt - left.lastReadAt
  })
  void filtered.length
}, 20)

const report = {
  shelfData1000Ms: shelf,
  toc10000Ms: toc,
  chapter20000: {
    chars: text.length,
    pages: lastResult.pages.length,
    lines: lastResult.lines.length,
    firstMs: firstPagination,
    coldMs: coldPagination,
    pageTurnCachedMs: pageTurns,
  },
}

console.log('M7 一次性性能记录（纯函数/数据层，不接入 npm test）')
console.log('1000 本书架数据整理（分组过滤+置顶+最近阅读排序）：' + shelf.median + ' ms（中位）')
console.log('10000 章目录定位（页码计算+200 条窗口切片）：' + toc.median + ' ms（中位）')
console.log(
  '20000 字章节首次分页：' + firstPagination.median + ' ms；20 次翻页（缓存命中）：' + pageTurns.median + ' ms/次；页数 ' + lastResult.pages.length,
)
console.log('JSON ' + JSON.stringify(report))

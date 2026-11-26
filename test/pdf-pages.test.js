import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chapterForPdfPage,
  isPdfPageChapters,
  pdfPageOfChapterTitle,
} from '../dist/core/pdf-pages.js'

const page = (n) => ({ title: `第 ${n} 页`, url: `local://book/${n}` })

test('pdfPageOfChapterTitle 只认「第 N 页」并取回 1 起的页码', () => {
  assert.equal(pdfPageOfChapterTitle('第 1 页'), 1)
  assert.equal(pdfPageOfChapterTitle('第 120 页'), 120)
  assert.equal(pdfPageOfChapterTitle('  第 7 页  '), 7)
  assert.equal(pdfPageOfChapterTitle('第 007 页'), 7)
})

test('pdfPageOfChapterTitle 拒绝非页码标题与非法值', () => {
  for (const title of ['', '第 0 页', '第0页', '第一页', '第 1 页 序', 'Chapter 1', null, 42]) {
    assert.equal(pdfPageOfChapterTitle(title), null, String(title))
  }
})

test('isPdfPageChapters 识别旧版 PDF 逐页章节', () => {
  assert.equal(isPdfPageChapters([page(1), page(2)]), true)
  assert.equal(isPdfPageChapters([]), false)
  assert.equal(isPdfPageChapters([page(1), { title: '第一章' }]), false)
  assert.equal(isPdfPageChapters([{ title: '第 1 页', isVolume: true }]), false)
})

test('chapterForPdfPage 精确命中当前页', () => {
  const chapters = [page(1), page(2), page(3)]
  assert.equal(chapterForPdfPage(chapters, 2).title, '第 2 页')
})

test('chapterForPdfPage 空文字页跳过时落到此前最近的一页', () => {
  // 第 2、3 页没有文字被跳过，停在第 3 页时显示第 1 页的文本。
  const chapters = [page(1), page(4), page(5)]
  assert.equal(chapterForPdfPage(chapters, 3).title, '第 1 页')
  assert.equal(chapterForPdfPage(chapters, 4).title, '第 4 页')
})

test('chapterForPdfPage 当前页之前没有文字页时取最近的一章', () => {
  const chapters = [page(2), page(3)]
  assert.equal(chapterForPdfPage(chapters, 1).title, '第 2 页')
})

test('chapterForPdfPage 忽略卷标题与页码非法值', () => {
  const chapters = [{ title: '第一卷', isVolume: true }, page(1), { title: '附录' }]
  assert.equal(chapterForPdfPage(chapters, 9).title, '第 1 页')
  assert.equal(chapterForPdfPage(chapters, 0), null)
  assert.equal(chapterForPdfPage([], 3), null)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { importEpub, importTxt, splitTxt } from '../lib/importers.js'

test('TXT import splits common Chinese and English chapter headings', () => {
  const text = '简介\n第一章 开始\n正文一\n第二章 继续\n正文二\nChapter 3 End\nfinal'
  const chapters = splitTxt(text)
  assert.deepEqual(chapters.map(chapter => chapter.title), ['卷首', '第一章 开始', '第二章 继续', 'Chapter 3 End'])
  assert.equal(chapters[1].text, '正文一')
  const imported = importTxt('测试书', text)
  assert.equal(imported.book.format, 'txt')
  assert.equal(imported.book.name, '测试书')
  assert.equal(imported.chapters.length, 4)
  assert.equal(new Set(imported.chapters.map(chapter => chapter.id)).size, 4)
  assert.equal(imported.book.download.status, 'completed')
})

test('TXT without headings remains one chapter', () => {
  assert.deepEqual(splitTxt('只有正文'), [{ title: '正文', text: '只有正文' }])
})

test('EPUB import follows container, OPF manifest and spine order offline', async () => {
  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip')
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
  zip.file('OPS/content.opf', `<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>示例 EPUB</dc:title><dc:creator>作者甲</dc:creator></metadata><manifest><item id="c2" href="text/two.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`)
  zip.file('OPS/text/one.xhtml', '<html><head><title>一</title></head><body><h1>第一章</h1><p>你好 &amp; 你好</p><script>bad()</script></body></html>')
  zip.file('OPS/text/two.xhtml', '<html><body><h2>第二章</h2><p>结束</p></body></html>')
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  const imported = await importEpub('fallback', buffer)
  assert.equal(imported.book.name, '示例 EPUB')
  assert.equal(imported.book.author, '作者甲')
  assert.deepEqual(imported.chapters.map(chapter => chapter.title), ['第一章', '第二章'])
  assert.equal(imported.chapters[0].text, '第一章\n你好 & 你好')
  assert.equal(imported.chapters[0].text.includes('bad()'), false)
  assert.equal(imported.chapters[1].text, '第二章\n结束')
})

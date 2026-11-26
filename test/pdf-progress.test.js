import assert from 'node:assert/strict'
import test from 'node:test'

// 只测进度合并：不碰本地书目录，也不用真实存储。
const { ReaderService } = await import('../dist/server/service.js')

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

function makeService() {
  const books = fakeTable()
  const readRecords = fakeTable()
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources: fakeTable(),
    books,
    readRecords,
    settings: { get: () => ({ theme: 'light' }), set: async () => {} },
  }
  return { service, books, readRecords }
}

function textProgress(chapterIndex, position) {
  return {
    bookId: 'book-pdf-1',
    chapterIndex,
    chapterTitle: `第 ${chapterIndex + 1} 页`,
    chapterUrl: `local://book-pdf-1#${chapterIndex}`,
    position,
  }
}

test('PDF 原版进度与文本进度互不覆盖', async () => {
  const { service, books, readRecords } = makeService()
  await books.put('book-pdf-1', { id: 'book-pdf-1', name: 'PDF 样本', origin: 'local' })

  // 先落文本进度，再落原版进度：文本字段必须保留。
  await service.saveProgress(textProgress(2, 7))
  const pdfSaved = await service.saveProgress({ bookId: 'book-pdf-1', pdfPage: 4, pdfZoom: 135, pdfFitWidth: false })
  assert.equal(pdfSaved.progress.pdfPage, 4)
  assert.equal(pdfSaved.progress.pdfZoom, 135)
  assert.equal(pdfSaved.progress.pdfFitWidth, false)
  assert.equal(pdfSaved.progress.chapterIndex, 2)
  assert.equal(pdfSaved.progress.chapterTitle, '第 3 页')
  assert.equal(pdfSaved.progress.chapterUrl, 'local://book-pdf-1#2')
  assert.equal(pdfSaved.progress.position, 7)

  // 再保存文本进度：PDF 字段必须保留。
  const textSaved = await service.saveProgress(textProgress(5, 0))
  assert.equal(textSaved.progress.chapterIndex, 5)
  assert.equal(textSaved.progress.position, 0)
  assert.equal(textSaved.progress.pdfPage, 4)
  assert.equal(textSaved.progress.pdfZoom, 135)
  assert.equal(textSaved.progress.pdfFitWidth, false)

  // 只改缩放，页码沿用；只改页码，缩放沿用。
  await service.saveProgress({ bookId: 'book-pdf-1', pdfZoom: 200, pdfFitWidth: true })
  const zoomOnly = (await service.getProgress({ bookId: 'book-pdf-1' })).progress
  assert.equal(zoomOnly.pdfPage, 4)
  assert.equal(zoomOnly.pdfZoom, 200)
  assert.equal(zoomOnly.pdfFitWidth, true)
  assert.equal(zoomOnly.chapterIndex, 5)

  await service.saveProgress({ bookId: 'book-pdf-1', pdfPage: 9 })
  const pageOnly = (await service.getProgress({ bookId: 'book-pdf-1' })).progress
  assert.equal(pageOnly.pdfPage, 9)
  assert.equal(pageOnly.pdfZoom, 200)
  assert.equal(pageOnly.pdfFitWidth, true)
  assert.equal(readRecords.map.size, 1)

  // 进度保存要顺手更新书架上的最近阅读时间。
  const book = books.get('book-pdf-1')
  assert.equal(typeof book.lastReadAt, 'string')
  assert.equal(book.lastReadAt, pageOnly.updatedAt)
})

test('先存原版进度再存文本进度，也能读到完整记录', async () => {
  const { service, books } = makeService()
  await books.put('book-pdf-2', { id: 'book-pdf-2', name: 'PDF 样本 2', origin: 'local' })

  const first = await service.saveProgress({ bookId: 'book-pdf-2', pdfPage: 0, pdfZoom: 50, pdfFitWidth: true })
  assert.equal(first.progress.chapterIndex, 0)
  assert.equal(first.progress.position, 0)
  assert.equal(first.progress.pdfZoom, 50)

  await service.saveProgress({
    bookId: 'book-pdf-2',
    chapterIndex: 1,
    chapterTitle: '第 2 页',
    chapterUrl: 'local://book-pdf-2#1',
    position: 3,
  })
  const progress = (await service.getProgress({ bookId: 'book-pdf-2' })).progress
  assert.equal(progress.chapterIndex, 1)
  assert.equal(progress.position, 3)
  assert.equal(progress.pdfPage, 0)
  assert.equal(progress.pdfZoom, 50)
  assert.equal(progress.pdfFitWidth, true)
})

test('PDF 进度参数做钳制与忽略非法值', async () => {
  const { service } = makeService()
  const saved = await service.saveProgress({ bookId: 'book-pdf-3', pdfPage: -3, pdfZoom: 999 })
  assert.equal(saved.progress.pdfPage, undefined)
  assert.equal(saved.progress.pdfZoom, 300)

  const again = await service.saveProgress({ bookId: 'book-pdf-3', pdfPage: 2.9, pdfZoom: 12 })
  assert.equal(again.progress.pdfPage, 2)
  assert.equal(again.progress.pdfZoom, 50)

  const missing = (await service.getProgress({ bookId: 'no-such-book' })).progress
  assert.equal(missing, null)
})

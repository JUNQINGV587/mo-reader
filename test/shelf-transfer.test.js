import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const LOCAL_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-shelf-'))
process.env.MO_READER_LOCAL_ROOT = LOCAL_ROOT
const {
  exportFullShelf,
  exportLegadoShelf,
  parseShelfImport,
  shelfDedupKeys,
} = await import('../dist/core/reader/shelf-transfer.js')
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

async function makeService() {
  const books = fakeTable()
  const readRecords = fakeTable()
  const settings = { get: () => ({ theme: 'light' }), set: async () => undefined }
  const service = Object.create(ReaderService.prototype)
  service.db = { books, readRecords, settings }
  return { service, books, readRecords }
}

test('Legado 数组导入：补全缺失来源、识别仅书目并在一批内去重', () => {
  const parsed = parseShelfImport(
    JSON.stringify([
      { name: '旧书', author: '甲', intro: '简介' },
      { name: '旧书', author: '甲', intro: '重复' },
      { name: '有来源', author: '乙', origin: 'source-a', bookUrl: 'https://a/1' },
    ]),
  )
  assert.equal(parsed.source, 'legado')
  assert.equal(parsed.books.length, 2)
  assert.equal(parsed.duplicates, 1)
  assert.equal(parsed.books[0].origin, 'legado')
  assert.match(parsed.books[0].bookUrl, /^legado:\/\//)
  assert.equal(parsed.books[0].metadataOnly, true)
  assert.equal(parsed.books[1].metadataOnly, false)
})

test('无效 JSON、非数组和缺书名整批拒绝', () => {
  assert.throws(() => parseShelfImport('不是 JSON'), /不是有效 JSON/)
  assert.throws(() => parseShelfImport(JSON.stringify({ hello: 'world' })), /books\.json 数组/)
  assert.throws(
    () => parseShelfImport(JSON.stringify([{ name: '可用' }, { author: '缺书名' }])),
    /书架导入失败，未写入任何书籍.*第 2 本缺少书名/,
  )
  assert.throws(() => parseShelfImport(JSON.stringify([])), /没有书籍/)
})

test('全量版与 Legado 兼容版都能回导，且不包含正文和封面数据', () => {
  const books = [
    {
      id: 'hidden',
      name: '样本',
      author: '墨读',
      origin: 'source-a',
      bookUrl: 'https://a/1',
      group: '测试',
      intro: '简介',
      coverUrl: 'data:image/png;base64,AAAA',
      content: '这段正文不能被导出',
      chapters: [{ title: '不应出现' }],
      progress: {
        chapterIndex: 3,
        chapterTitle: '第三章',
        chapterUrl: 'https://a/3',
        position: 12,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  ]
  const full = exportFullShelf(books)
  assert.equal(full.format, 'mo-reader-books')
  assert.equal(full.books[0].content, undefined)
  assert.equal(full.books[0].chapters, undefined)
  assert.equal(full.books[0].coverUrl, '')
  const fullAgain = parseShelfImport(JSON.stringify(full))
  assert.equal(fullAgain.source, 'mo-reader')
  assert.equal(fullAgain.books[0].progress.chapterIndex, 3)
  assert.equal(fullAgain.books[0].intro, '简介')

  const legado = exportLegadoShelf(books)
  assert.equal(legado[0].durChapterIndex, 3)
  assert.equal(legado[0].durChapterTitle, '第三章')
  const legadoAgain = parseShelfImport(JSON.stringify(legado))
  assert.equal(legadoAgain.source, 'legado')
  assert.equal(legadoAgain.books[0].progress.position, 12)
  assert.deepEqual(shelfDedupKeys(legadoAgain.books[0]), [
    'meta:样本|墨读',
    'url:source-a|https://a/1',
  ])
})

test('导入服务按已有书与批内重复去重，只写书目和进度', async () => {
  const { service, books, readRecords } = await makeService()
  await books.put('existing', {
    id: 'existing',
    name: '已有',
    author: '甲',
    origin: 'source-a',
    bookUrl: 'https://a/existing',
  })
  const payload = JSON.stringify([
    { name: '已有', author: '甲', origin: 'source-a', bookUrl: 'https://a/existing' },
    { name: '新书', author: '乙', origin: 'source-b', bookUrl: 'https://b/1', group: '新分组' },
    { name: '新书', author: '乙', origin: 'source-b', bookUrl: 'https://b/1' },
  ])
  const result = await service.importBooks({ payload })
  assert.equal(result.total, 3)
  assert.equal(result.added, 1)
  assert.equal(result.skipped, 2)
  assert.equal(books.map.size, 2)
  const imported = [...books.map.values()].find((book) => book.name === '新书')
  assert.equal(imported.group, '新分组')
  assert.equal(imported.metadataOnly, false)
  assert.equal(readRecords.map.size, 0)
})

test('全量导出中的进度在导入后恢复，本地缺文件的书标为仅书目', async () => {
  const { service, books, readRecords } = await makeService()
  const payload = JSON.stringify({
    format: 'mo-reader-books',
    version: 1,
    books: [
      {
        name: '本地残本',
        author: '',
        origin: 'local',
        bookUrl: 'local://missing-book',
        progress: {
          chapterIndex: 2,
          chapterTitle: '第二章',
          chapterUrl: 'local://missing-book/2',
          position: 7,
          updatedAt: 1_700_000_000_000,
        },
      },
    ],
  })
  const result = await service.importBooks({ payload })
  assert.equal(result.added, 1)
  assert.equal(result.localMissing, 1)
  const record = [...books.map.values()][0]
  assert.equal(record.id, 'missing-book')
  assert.equal(record.localMissing, true)
  assert.equal(record.metadataOnly, true)
  assert.equal(readRecords.map.size, 1)
  assert.equal(readRecords.map.get('missing-book').chapterIndex, 2)
})

test('校验失败时书架一笔不写', async () => {
  const { service, books } = await makeService()
  await assert.rejects(
    service.importBooks({ payload: JSON.stringify([{ name: '可用' }, { author: '缺书名' }]) }),
    /未写入任何书籍/,
  )
  assert.equal(books.map.size, 0)
})

test.after(async () => {
  await rm(LOCAL_ROOT, { recursive: true, force: true })
})

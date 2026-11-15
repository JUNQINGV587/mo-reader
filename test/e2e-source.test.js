import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

function fakeTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    put: async (key, value) => {
      map.set(key, value)
    },
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

const PAGES = {
  '/search': `<div class="result"><h3><a href="/book/1">三体</a></h3><span class="author">刘慈欣</span></div>`,
  '/book/1': `<div id="info"><h1>三体</h1><a class="author">刘慈欣</a><a class="toc" href="/toc/1">目录</a></div>`,
  '/toc/1': `<ul class="toc"><li><a href="/chapter/1">第1章</a></li><li><a href="/chapter/2">第2章</a></li></ul>`,
  '/chapter/1': `<div id="content"><p>正文第一段</p><p>正文第二段</p></div>`,
}

test('E2E：导入书源 → 搜索 → 详情 → 目录 → 正文', async (t) => {
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const body = PAGES[path]
    if (!body) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`

  const { ReaderService } = await import('../dist/server/service.js')
  const service = Object.create(ReaderService.prototype)
  let settingsValue = { theme: 'system', fontSize: 24, lineSpacing: 0.5 }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  service.db = { sources: fakeTable(), books: fakeTable(), readRecords: fakeTable(), settings }

  const source = {
    bookSourceUrl: origin,
    bookSourceName: '本地测试源',
    searchUrl: '/search?q={{key}}',
    ruleSearch: {
      bookList: 'class.result',
      name: 'h3@a@text',
      bookUrl: 'h3@a@href',
      author: 'class.author@text',
    },
    ruleBookInfo: {
      name: 'h1@text',
      author: 'class.author@text',
      tocUrl: 'class.toc@href',
    },
    ruleToc: {
      chapterList: 'class.toc@tag.li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
    },
    ruleContent: { content: 'id.content@text' },
  }
  const imported = await service.importSources({ payload: JSON.stringify([source]) })
  assert.equal(imported.added, 1)

  const search = await service.searchBooks({ key: '三体' })
  assert.equal(search.errors.length, 0)
  assert.equal(search.books.length, 1)
  const book = search.books[0]
  assert.equal(book.name, '三体')
  assert.equal(book.bookUrl, `${origin}/book/1`)

  const info = await service.getBookInfo({ sourceUrl: origin, bookUrl: book.bookUrl })
  assert.equal(info.info.name, '三体')
  assert.equal(info.info.tocUrl, `${origin}/toc/1`)

  const toc = await service.getToc({ sourceUrl: origin, tocUrl: info.info.tocUrl })
  assert.equal(toc.chapters.length, 2)
  assert.equal(toc.chapters[0].title, '第1章')

  const content = await service.getContent({ sourceUrl: origin, chapterUrl: toc.chapters[0].url })
  assert.ok(content.content.includes('正文第一段'))
  assert.ok(content.content.includes('正文第二段'))
})

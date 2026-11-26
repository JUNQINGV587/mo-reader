import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

const { ReaderService } = await import('../dist/server/service.js')
const { writeCachedChapter } = await import('../dist/server/cache.js')
const { REMOTE_METHODS } = await import('../dist/core/remote-methods.js')

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

function makeService() {
  const service = Object.create(ReaderService.prototype)
  let settingsValue = { theme: 'system', fontSize: 24, lineSpacing: 0.5 }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  service.db = {
    sources: fakeTable(),
    books: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    dictRules: fakeTable(),
    subscriptions: fakeTable(),
    settings,
  }
  return service
}

/** 每个测试独立的缓存 / 本地书目录，避免用例互相污染。 */
async function tempRoots(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mo-search-book-'))
  const prevCache = process.env.MO_READER_CACHE_ROOT
  const prevLocal = process.env.MO_READER_LOCAL_ROOT
  process.env.MO_READER_CACHE_ROOT = path.join(dir, 'cache')
  process.env.MO_READER_LOCAL_ROOT = path.join(dir, 'local')
  t.after(async () => {
    if (prevCache === undefined) delete process.env.MO_READER_CACHE_ROOT
    else process.env.MO_READER_CACHE_ROOT = prevCache
    if (prevLocal === undefined) delete process.env.MO_READER_LOCAL_ROOT
    else process.env.MO_READER_LOCAL_ROOT = prevLocal
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function serve(t, handler) {
  const requests = new Map()
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1)
    handler(request, response, pathname)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, requests }
}

function tocPage(chapters) {
  const items = chapters
    .map((chapter) =>
      chapter.volume
        ? `<li><a>${chapter.title}</a></li>`
        : `<li><a href="${chapter.url}">${chapter.title}</a></li>`,
    )
    .join('')
  return `<ul class="toc">${items}</ul>`
}

function contentPage(inner) {
  return `<div id="content">${inner}</div>`
}

function htmlResponse(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
}

async function registerSource(service, origin, bookSourceType = 0) {
  const source = {
    bookSourceUrl: origin,
    bookSourceName: `测试源-${origin}`,
    bookSourceType,
    enabled: true,
    ruleToc: {
      chapterList: 'class.toc@tag.li',
      chapterName: 'a@text',
      chapterUrl: 'a@href',
    },
    ruleContent: { content: bookSourceType === 2 ? 'class.pic@tag.img' : 'id.content@text' },
  }
  const imported = await service.importSources({ payload: JSON.stringify([source]) })
  assert.equal(imported.added, 1)
  return source
}

async function addBook(service, origin, type = 0) {
  const result = await service.addBook({
    book: {
      name: '测试书',
      author: '作者',
      origin,
      originName: '测试源',
      bookUrl: `${origin}/book/1`,
      tocUrl: `${origin}/toc/1`,
      type,
    },
  })
  return result.book
}

test('REMOTE_METHODS 注册 searchInBook', () => {
  assert.ok(REMOTE_METHODS.includes('searchInBook'))
})

test('书内搜索：跨章按顺序返回命中次数与清理过的片段', async (t) => {
  await tempRoots(t)
  const chapters = [
    { title: '第一卷', volume: true },
    { title: '第1章', url: '/chapter/1' },
    { title: '第2章', url: '/chapter/2' },
    { title: '第3章', url: '/chapter/3' },
  ]
  const pages = {
    '/toc/1': tocPage(chapters),
    '/chapter/1': contentPage('<p>这一章没有要找的人。</p>'),
    '/chapter/2': contentPage(
      '<p>第一段提到三体。</p><p>第二段又提到三体，还有更多上下文用来检查片段是否够长。</p>',
    ),
    '/chapter/3': contentPage('<p>最后一段也提到三体。</p>'),
  }
  const { origin } = await serve(t, (request, response, pathname) => {
    const body = pages[pathname]
    if (!body) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    htmlResponse(response, body)
  })
  const service = makeService()
  await registerSource(service, origin)
  const book = await addBook(service, origin)

  const result = await service.searchInBook({ bookId: book.id, key: '三体' })
  assert.deepEqual(result.results.map((item) => item.chapterIndex), [2, 3])
  assert.equal(result.results[0].chapterTitle, '第2章')
  assert.equal(result.results[0].count, 2)
  assert.equal(result.results[1].count, 1)
  assert.match(result.results[0].snippet, /三体/)
  assert.ok(result.results[0].snippet.includes('第一段'))
  assert.ok(result.results[0].snippet.includes('第二段'))
  assert.ok(!result.results[0].snippet.includes('<'), '片段不能带 HTML')
  assert.ok(!result.results[0].snippet.includes('\n'), '片段应为单行')
  assert.ok(Number.isInteger(result.results[0].pageHint) && result.results[0].pageHint >= 1)
  assert.equal(result.nextIndex, 4)
  assert.equal(result.done, true)
  assert.deepEqual(result.errors, [])
})

test('书内搜索：fromIndex / nextIndex / done 分批推进', async (t) => {
  await tempRoots(t)
  const chapters = Array.from({ length: 5 }, (_, index) => ({
    title: `第${index + 1}章`,
    url: `/chapter/${index + 1}`,
  }))
  const pages = { '/toc/1': tocPage(chapters) }
  for (let index = 0; index < 5; index += 1) {
    pages[`/chapter/${index + 1}`] = contentPage(`<p>第${index + 1}章出现关键词。</p>`)
  }
  const { origin } = await serve(t, (request, response, pathname) => {
    const body = pages[pathname]
    if (!body) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    htmlResponse(response, body)
  })
  const service = makeService()
  await registerSource(service, origin)
  const book = await addBook(service, origin)

  const first = await service.searchInBook({ bookId: book.id, key: '关键词', maxChapters: 2 })
  assert.deepEqual(first.results.map((item) => item.chapterIndex), [0, 1])
  assert.equal(first.nextIndex, 2)
  assert.equal(first.done, false)

  const second = await service.searchInBook({
    bookId: book.id,
    key: '关键词',
    fromIndex: first.nextIndex,
    maxChapters: 2,
  })
  assert.deepEqual(second.results.map((item) => item.chapterIndex), [2, 3])
  assert.equal(second.nextIndex, 4)
  assert.equal(second.done, false)

  const third = await service.searchInBook({
    bookId: book.id,
    key: '关键词',
    fromIndex: second.nextIndex,
    maxChapters: 2,
  })
  assert.deepEqual(third.results.map((item) => item.chapterIndex), [4])
  assert.equal(third.nextIndex, 5)
  assert.equal(third.done, true)

  const beyond = await service.searchInBook({ bookId: book.id, key: '关键词', fromIndex: 99 })
  assert.deepEqual(beyond.results, [])
  assert.equal(beyond.nextIndex, 5)
  assert.equal(beyond.done, true)
})

test('书内搜索：单批最多扫描 200 章', async (t) => {
  await tempRoots(t)
  const total = 205
  const chapters = Array.from({ length: total }, (_, index) => ({
    title: `第${index + 1}章`,
    url: `/chapter/${index + 1}`,
  }))
  const { origin } = await serve(t, (request, response, pathname) => {
    if (pathname === '/toc/1') {
      htmlResponse(response, tocPage(chapters))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const service = makeService()
  await registerSource(service, origin)
  const book = await addBook(service, origin)
  // 全部预缓存，测上限时不必发 200 次网络请求。
  for (const chapter of chapters) {
    await writeCachedChapter(origin, `${origin}${chapter.url}`, `第${chapter.title}章提到上限词。`)
  }

  const first = await service.searchInBook({ bookId: book.id, key: '上限词', maxChapters: 500 })
  assert.equal(first.results.length, 200)
  assert.equal(first.results[0].chapterIndex, 0)
  assert.equal(first.results[199].chapterIndex, 199)
  assert.equal(first.nextIndex, 200)
  assert.equal(first.done, false)

  const rest = await service.searchInBook({
    bookId: book.id,
    key: '上限词',
    fromIndex: first.nextIndex,
    maxChapters: 500,
  })
  assert.equal(rest.results.length, 5)
  assert.equal(rest.results[0].chapterIndex, 200)
  assert.equal(rest.nextIndex, 205)
  assert.equal(rest.done, true)
})

test('书内搜索：缓存优先，未缓存才请求网络', async (t) => {
  await tempRoots(t)
  const chapters = [
    { title: '第1章', url: '/chapter/1' },
    { title: '第2章', url: '/chapter/2' },
  ]
  const { origin, requests } = await serve(t, (request, response, pathname) => {
    if (pathname === '/toc/1') {
      htmlResponse(response, tocPage(chapters))
      return
    }
    if (pathname === '/chapter/1') {
      // 命中缓存时不应走到这里。
      request.destroy()
      return
    }
    if (pathname === '/chapter/2') {
      htmlResponse(response, contentPage('<p>网络里的三体。</p>'))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const service = makeService()
  await registerSource(service, origin)
  const book = await addBook(service, origin)
  await writeCachedChapter(origin, `${origin}/chapter/1`, '<p>缓存里的三体。</p>')

  const result = await service.searchInBook({ bookId: book.id, key: '三体' })
  assert.deepEqual(result.results.map((item) => item.chapterIndex), [0, 1])
  assert.equal(result.results[0].count, 1)
  assert.match(result.results[0].snippet, /缓存/)
  assert.ok(!result.results[0].snippet.includes('<'), '缓存里的 HTML 也要清掉')
  assert.equal(requests.get('/chapter/1'), undefined)
  assert.equal(requests.get('/chapter/2'), 1)
  assert.deepEqual(result.errors, [])
})

test('书内搜索：单章失败只进 errors，不中断其他章节', async (t) => {
  await tempRoots(t)
  const chapters = [
    { title: '第1章', url: '/chapter/1' },
    { title: '第2章', url: '/chapter/2' },
    { title: '第3章', url: '/chapter/3' },
  ]
  const { origin } = await serve(t, (request, response, pathname) => {
    if (pathname === '/toc/1') {
      htmlResponse(response, tocPage(chapters))
      return
    }
    if (pathname === '/chapter/2') {
      request.destroy()
      return
    }
    const index = Number(pathname.split('/').pop())
    if (index === 1 || index === 3) {
      htmlResponse(response, contentPage(`<p>第${index}章出现搜索词。</p>`))
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  const service = makeService()
  await registerSource(service, origin)
  const book = await addBook(service, origin)

  const result = await service.searchInBook({ bookId: book.id, key: '搜索词' })
  assert.deepEqual(result.results.map((item) => item.chapterIndex), [0, 2])
  assert.equal(result.done, true)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].chapterIndex, 1)
  assert.equal(result.errors[0].chapterTitle, '第2章')
  assert.ok(result.errors[0].message)
})

test('书内搜索：漫画 / 音频 / 视频书拒绝搜索', async (t) => {
  await tempRoots(t)
  let requests = 0
  const { origin } = await serve(t, (request) => {
    requests += 1
    request.destroy()
  })
  for (const type of [1, 2, 4]) {
    const service = makeService()
    await registerSource(service, origin, type)
    const book = await addBook(service, origin, type)
    await assert.rejects(
      service.searchInBook({ bookId: book.id, key: '关键词' }),
      /不是文本|文本类型/,
      `bookSourceType=${type} 应拒绝`,
    )
  }
  assert.equal(requests, 0, '类型检查应发生在抓取目录之前')
})

test('书内搜索：书源类型为准，文本书记录也拒绝非文本源', async (t) => {
  await tempRoots(t)
  let requests = 0
  const { origin } = await serve(t, (request) => {
    requests += 1
    request.destroy()
  })
  const service = makeService()
  await registerSource(service, origin, 2)
  const book = await addBook(service, origin, 0)
  await assert.rejects(service.searchInBook({ bookId: book.id, key: '关键词' }), /不是文本|文本类型/)
  assert.equal(requests, 0)
})

test('书内搜索：本地导入书搜索本地章节正文', async (t) => {
  await tempRoots(t)
  const service = makeService()
  const payload = [
    '第一章 起点',
    '这一章没有要找的人。',
    '',
    '第二章 相遇',
    '这一章出现关键词一次。',
    '',
    '第三章 结束',
    '关键词又出现一次。',
    '',
  ].join('\n')
  const imported = await service.importLocalBook({
    fileName: '测试.txt',
    dataBase64: Buffer.from(payload, 'utf8').toString('base64'),
  })

  const result = await service.searchInBook({ bookId: imported.book.id, key: '关键词' })
  assert.deepEqual(result.results.map((item) => item.chapterIndex), [1, 2])
  assert.equal(result.results[0].chapterTitle, '第二章 相遇')
  assert.equal(result.results[0].count, 1)
  assert.equal(result.results[1].count, 1)
  assert.equal(result.done, true)
  assert.deepEqual(result.errors, [])
})

test('书内搜索：缺参数与不存在的书有明确错误', async (t) => {
  await tempRoots(t)
  const service = makeService()
  await assert.rejects(service.searchInBook({ key: '关键词' }), /缺少参数 bookId/)
  await assert.rejects(service.searchInBook({ bookId: 'missing', key: '关键词' }), /书不存在/)
  const book = await addBook(service, 'http://127.0.0.1:1')
  await assert.rejects(service.searchInBook({ bookId: book.id, key: '   ' }), /缺少参数 key/)
})

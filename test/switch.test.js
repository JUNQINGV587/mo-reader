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
      for (const key of keys) map.delete(key)
    },
    map,
  }
}

function searchHtml(items) {
  return `<!doctype html><html><body>${items
    .map(
      (item) => `<div class="result">
        <h3><a href="${item.bookUrl}">${item.name}</a></h3>
        <span class="author">${item.author}</span>
        <span class="kind">${item.kind || '科幻'}</span>
        <span class="last">${item.lastChapter || ''}</span>
        <span class="intro">${item.intro || ''}</span>
        <img class="cover" src="${item.coverUrl || ''}" />
      </div>`,
    )
    .join('')}</body></html>`
}

function detailHtml({ name = '', author = '', intro = '', tocPath = '', latest = '', cover = '' }) {
  return `<!doctype html><html><body>
    <h1>${name}</h1>
    <span class="author">${author}</span>
    <span class="kind">科幻</span>
    <span class="last">${latest}</span>
    <p class="intro">${intro}</p>
    <img class="cover" src="${cover}" />
    <a class="toc" href="${tocPath}">目录</a>
  </body></html>`
}

function tocHtml(titles) {
  return `<!doctype html><html><body><ul class="toc">${titles
    .map((title, index) => `<li><a href="/b/c/${index + 1}">${title}</a></li>`)
    .join('')}</ul></body></html>`
}

const B_TOC = ['第1章 启程', '第2章 出发', '第3章 归途', '第4章 星海']

/**
 * 本地 HTTP 服务：/a 当前来源、/b 候选来源、/c 另一候选来源、/d 已停用来源。
 * 每个来源提供搜索页；/b 另有详情页与目录页，含正常、500、空目录、无书名几种目标。
 */
async function startSwitchServer() {
  const hits = new Map()
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1)
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      response.end(body)
    }

    if (url.pathname === '/a/search') {
      return send(200, searchHtml([{ name: '星海旅人', author: '作者甲', bookUrl: '/a/book/1' }]))
    }
    if (url.pathname === '/d/search') {
      return send(200, searchHtml([{ name: '星海旅人', author: '作者甲', bookUrl: '/d/book/1' }]))
    }
    if (url.pathname === '/b/search') {
      return send(
        200,
        searchHtml([
          { name: '星海旅人', author: '作者甲', bookUrl: '/b/book/1', lastChapter: '第5章 星海' },
          { name: '荒野之歌', author: '作者甲', bookUrl: '/b/book/gone', lastChapter: '第2章 风' },
          { name: '星海旅人', author: '作者乙', bookUrl: '/b/book/other', lastChapter: '第8章 夜' },
        ]),
      )
    }
    if (url.pathname === '/c/search') {
      return send(
        200,
        searchHtml([{ name: '星海旅人（全本）', author: '作者丙', bookUrl: '/c/book/1' }]),
      )
    }

    if (url.pathname === '/b/book/1') {
      return send(
        200,
        detailHtml({
          name: '星海旅人',
          author: '作者甲',
          intro: '在星海之间远航的故事。',
          tocPath: '/b/toc/1',
          latest: '第4章 星海',
          cover: '/img/b.jpg',
        }),
      )
    }
    if (url.pathname === '/b/book/broken') {
      return send(500, '<html><body>boom</body></html>')
    }
    if (url.pathname === '/b/book/empty') {
      return send(
        200,
        detailHtml({
          name: '星海旅人',
          author: '作者甲',
          intro: '空目录',
          tocPath: '/b/toc/empty',
          latest: '',
          cover: '',
        }),
      )
    }
    if (url.pathname === '/b/book/noname') {
      return send(
        200,
        detailHtml({ name: '', author: '作者甲', intro: '', tocPath: '/b/toc/1', latest: '', cover: '' }),
      )
    }

    if (url.pathname === '/b/toc/1') return send(200, tocHtml(B_TOC))
    if (url.pathname === '/b/toc/empty') return send(200, tocHtml([]))

    send(404, '<html><body>not found</body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, hits }
}

async function createService(origin) {
  const { ReaderService } = await import('../dist/server/service.js')
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources: fakeTable(),
    books: fakeTable(),
    chapters: fakeTable(),
    readRecords: fakeTable(),
    bookmarks: fakeTable(),
    notes: fakeTable(),
    settings: { get: () => undefined, set: async () => undefined },
  }

  const ruleSearch = {
    bookList: 'class.result',
    name: 'h3@a@text',
    bookUrl: 'h3@a@href',
    author: 'class.author@text',
    kind: 'class.kind@text',
    lastChapter: 'class.last@text',
    intro: 'class.intro@text',
    coverUrl: 'class.cover@src',
  }
  const ruleBookInfo = {
    name: 'h1@text',
    author: 'class.author@text',
    kind: 'class.kind@text',
    lastChapter: 'class.last@text',
    intro: 'class.intro@text',
    coverUrl: 'class.cover@src',
    tocUrl: 'class.toc@href',
  }
  const ruleToc = { chapterList: 'class.toc@tag.li', chapterName: 'a@text', chapterUrl: 'a@href' }

  const sources = [
    {
      bookSourceUrl: `${origin}/a`,
      bookSourceName: '甲源',
      enabled: true,
      searchUrl: `${origin}/a/search?q={{key}}`,
      ruleSearch,
      ruleBookInfo,
      ruleToc,
    },
    {
      bookSourceUrl: `${origin}/b`,
      bookSourceName: '乙源',
      enabled: true,
      searchUrl: `${origin}/b/search?q={{key}}`,
      ruleSearch,
      ruleBookInfo,
      ruleToc,
    },
    {
      bookSourceUrl: `${origin}/c`,
      bookSourceName: '丙源',
      enabled: true,
      searchUrl: `${origin}/c/search?q={{key}}`,
      ruleSearch,
      ruleBookInfo,
      ruleToc,
    },
    {
      bookSourceUrl: `${origin}/d`,
      bookSourceName: '丁源',
      enabled: false,
      searchUrl: `${origin}/d/search?q={{key}}`,
      ruleSearch,
      ruleBookInfo,
      ruleToc,
    },
  ]
  const imported = await service.importSources({ payload: JSON.stringify(sources) })
  assert.equal(imported.added, sources.length)
  return service
}

function seedBook(service, origin, overrides = {}) {
  const record = {
    id: 'book-1',
    name: '星海旅人',
    author: '作者甲',
    origin: `${origin}/a`,
    originName: '甲源',
    bookUrl: `${origin}/a/book/1`,
    tocUrl: `${origin}/a/toc/1`,
    coverUrl: `${origin}/a/img/old.jpg`,
    intro: '旧简介',
    totalChapterNum: 3,
    latestChapterTitle: '第3章 归途',
    kind: '科幻',
    type: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
    ...overrides,
  }
  return record
}

function seedProgress(service, origin, overrides = {}) {
  return {
    id: 'book-1',
    bookId: 'book-1',
    chapterIndex: 1,
    chapterTitle: '第2章 出发',
    chapterUrl: `${origin}/a/c/2`,
    position: 4,
    updatedAt: '2024-03-01T00:00:00.000Z',
    ...overrides,
  }
}

async function setup(t, overrides = {}) {
  const { server, origin, hits } = await startSwitchServer()
  t.after(() => server.close())
  const service = await createService(origin)
  const book = seedBook(service, origin, overrides.book)
  const progress = seedProgress(service, origin, overrides.progress)
  await service.db.books.put(book.id, book)
  await service.db.readRecords.put(book.id, progress)
  return { service, origin, hits, book, progress }
}

test('findSourceCandidates 只搜已启用且非当前来源的书源，同作者优先并标记可疑书名', async (t) => {
  const { service, origin, hits } = await setup(t)

  const result = await service.findSourceCandidates({ bookId: 'book-1' })

  assert.deepEqual(result.errors, [])
  assert.equal(hits.get('/a/search') ?? 0, 0, '不应搜索当前来源')
  assert.equal(hits.get('/d/search') ?? 0, 0, '不应搜索已停用来源')

  assert.deepEqual(
    result.candidates.map((item) => [item.name, item.author, item.sourceName]),
    [
      ['星海旅人', '作者甲', '乙源'],
      ['荒野之歌', '作者甲', '乙源'],
      ['星海旅人', '作者乙', '乙源'],
      ['星海旅人（全本）', '作者丙', '丙源'],
    ],
  )
  assert.ok(
    result.candidates.every((item) => item.sourceUrl !== `${origin}/a`),
    '当前来源不应出现在候选里',
  )
  assert.deepEqual(
    result.candidates.map((item) => item.sameAuthor),
    [true, true, false, false],
  )
  assert.deepEqual(
    result.candidates.map((item) => item.possiblyNotSameBook),
    [false, true, false, false],
  )
  assert.equal(result.candidates[0].sourceUrl, `${origin}/b`)
  assert.equal(result.candidates[0].bookUrl, `${origin}/b/book/1`)
  assert.equal(result.candidates[0].latestChapter, '第5章 星海')
  assert.equal(result.candidates[0].kind, '科幻')
})

test('findSourceCandidates 拒绝本地书与不存在的书', async (t) => {
  const { service, origin } = await setup(t)
  await service.db.books.put('local-1', {
    id: 'local-1',
    name: '本地小说',
    author: '',
    origin: 'local',
    originName: '本地',
    bookUrl: 'local://local-1/1',
    tocUrl: 'local://local-1/1',
    type: 0,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  })

  await assert.rejects(() => service.findSourceCandidates({ bookId: 'local-1' }), /本地书不支持换源/)
  await assert.rejects(() => service.findSourceCandidates({ bookId: 'nope' }), /书不存在/)
  await assert.rejects(
    () => service.switchBookSource({ bookId: 'local-1', sourceUrl: `${origin}/b`, bookUrl: `${origin}/b/book/1` }),
    /本地书不支持换源/,
  )
})

test('previewSourceCandidate 返回目标信息与目录预览，且不修改原书和进度', async (t) => {
  const { service, origin, hits } = await setup(t)
  const beforeBook = await service.db.books.get('book-1')
  const beforeProgress = await service.db.readRecords.get('book-1')

  const preview = await service.previewSourceCandidate({
    sourceUrl: `${origin}/b`,
    bookUrl: `${origin}/b/book/1`,
  })

  assert.equal(preview.book.name, '星海旅人')
  assert.equal(preview.book.author, '作者甲')
  assert.equal(preview.book.sourceUrl, `${origin}/b`)
  assert.equal(preview.book.sourceName, '乙源')
  assert.equal(preview.book.tocUrl, `${origin}/b/toc/1`)
  assert.equal(preview.book.coverUrl, `${origin}/img/b.jpg`)
  assert.equal(preview.book.intro, '在星海之间远航的故事。')
  assert.equal(preview.chapterCount, 4)
  assert.equal(preview.latestChapter, '第4章 星海')
  assert.deepEqual(
    preview.chapters.map((chapter) => chapter.title),
    B_TOC,
  )
  assert.deepEqual(await service.db.books.get('book-1'), beforeBook)
  assert.deepEqual(await service.db.readRecords.get('book-1'), beforeProgress)
  assert.equal(hits.get('/b/search') ?? 0, 0, '预览不应走搜索接口')

  await assert.rejects(
    () => service.previewSourceCandidate({ sourceUrl: `${origin}/d`, bookUrl: `${origin}/b/book/1` }),
    /书源已停用/,
  )
})

test('switchBookSource 按章节标题保留进度，并更新书目与目录', async (t) => {
  const { service, origin } = await setup(t)
  await service.db.bookmarks.put('bm-1', {
    id: 'bm-1',
    type: 'bookmark',
    bookId: 'book-1',
    chapterIndex: 1,
    chapterTitle: '第2章 出发',
    chapterUrl: `${origin}/a/c/2`,
    page: 2,
    text: '',
    note: '',
    createdAt: '2024-03-01T00:00:00.000Z',
  })
  await service.db.notes.put('note-1', {
    id: 'note-1',
    bookId: 'book-1',
    chapterIndex: 1,
    chapterTitle: '第2章 出发',
    chapterUrl: `${origin}/a/c/2`,
    quote: '远航',
    note: '记一笔',
    createdAt: '2024-03-02T00:00:00.000Z',
  })

  const result = await service.switchBookSource({
    bookId: 'book-1',
    sourceUrl: `${origin}/b`,
    bookUrl: `${origin}/b/book/1`,
  })

  assert.equal(result.book.id, 'book-1')
  assert.equal(result.book.origin, `${origin}/b`)
  assert.equal(result.book.originName, '乙源')
  assert.equal(result.book.bookUrl, `${origin}/b/book/1`)
  assert.equal(result.book.tocUrl, `${origin}/b/toc/1`)
  assert.equal(result.book.coverUrl, `${origin}/img/b.jpg`)
  assert.equal(result.book.intro, '在星海之间远航的故事。')
  assert.equal(result.book.totalChapterNum, 4)
  assert.equal(result.book.latestChapterTitle, '第4章 星海')
  assert.equal(result.book.createdAt, '2024-01-01T00:00:00.000Z')
  assert.equal(result.chapters.length, 4)
  assert.deepEqual(
    result.chapters.map((chapter) => chapter.title),
    B_TOC,
  )

  assert.equal(result.progress.chapterIndex, 1)
  assert.equal(result.progress.chapterTitle, '第2章 出发')
  assert.equal(result.progress.chapterUrl, `${origin}/b/c/2`)
  assert.equal(result.progress.position, 4)

  assert.deepEqual(await service.db.books.get('book-1'), result.book)
  assert.deepEqual(await service.db.readRecords.get('book-1'), result.progress)
  const progress = await service.getProgress({ bookId: 'book-1' })
  assert.deepEqual(progress.progress, result.progress)

  const bookmarks = await service.listBookmarks({ bookId: 'book-1' })
  assert.equal(bookmarks.bookmarks.length, 1)
  assert.equal(bookmarks.bookmarks[0].id, 'bm-1')
  const notes = await service.listNotes({ bookId: 'book-1' })
  assert.equal(notes.notes.length, 1)
  assert.equal(notes.notes[0].id, 'note-1')

  const shelf = await service.listBooks()
  assert.equal(shelf.books.length, 1)
  assert.equal(shelf.books[0].id, 'book-1')
  assert.equal(shelf.books[0].progress.chapterTitle, '第2章 出发')

  const toc = await service.getToc({
    sourceUrl: result.book.origin,
    tocUrl: result.book.tocUrl,
  })
  assert.deepEqual(
    toc.chapters.map((chapter) => chapter.title),
    B_TOC,
  )
})

test('switchBookSource 标题失配按索引夹取，并把越界页号归零', async (t) => {
  const { service, origin } = await setup(t, {
    progress: {
      chapterIndex: 9,
      chapterTitle: '第9章 失落的章节',
      position: 7,
    },
  })

  const result = await service.switchBookSource({
    bookId: 'book-1',
    sourceUrl: `${origin}/b`,
    bookUrl: `${origin}/b/book/1`,
  })

  assert.equal(result.progress.chapterIndex, 3)
  assert.equal(result.progress.chapterTitle, '第4章 星海')
  assert.equal(result.progress.chapterUrl, `${origin}/b/c/4`)
  assert.equal(result.progress.position, 0)
})

test('switchBookSource 详情或目录校验失败时不写入任何数据', async (t) => {
  const { service, origin, hits } = await setup(t)
  const beforeBook = await service.db.books.get('book-1')
  const beforeProgress = await service.db.readRecords.get('book-1')

  await assert.rejects(
    () =>
      service.switchBookSource({
        bookId: 'book-1',
        sourceUrl: `${origin}/b`,
        bookUrl: `${origin}/b/book/broken`,
      }),
    /HTTP 500/,
  )
  assert.deepEqual(await service.db.books.get('book-1'), beforeBook)
  assert.deepEqual(await service.db.readRecords.get('book-1'), beforeProgress)
  assert.equal(hits.get('/b/toc/broken') ?? 0, 0, '详情失败后不应抓目录')

  await assert.rejects(
    () =>
      service.switchBookSource({
        bookId: 'book-1',
        sourceUrl: `${origin}/b`,
        bookUrl: `${origin}/b/book/empty`,
      }),
    /目录/,
  )
  assert.deepEqual(await service.db.books.get('book-1'), beforeBook)
  assert.deepEqual(await service.db.readRecords.get('book-1'), beforeProgress)

  await assert.rejects(
    () =>
      service.switchBookSource({
        bookId: 'book-1',
        sourceUrl: `${origin}/b`,
        bookUrl: `${origin}/b/book/noname`,
      }),
    /书名/,
  )
  assert.deepEqual(await service.db.books.get('book-1'), beforeBook)
  assert.deepEqual(await service.db.readRecords.get('book-1'), beforeProgress)

  await assert.rejects(
    () =>
      service.switchBookSource({
        bookId: 'book-1',
        sourceUrl: `${origin}/d`,
        bookUrl: `${origin}/b/book/1`,
      }),
    /书源已停用/,
  )
  assert.deepEqual(await service.db.books.get('book-1'), beforeBook)
  assert.deepEqual(await service.db.readRecords.get('book-1'), beforeProgress)
})

test('书名与作者的规范化比较', async () => {
  const { bookNamesRelated, sameAuthorName } = await import('../dist/core/source/switch.js')

  assert.equal(bookNamesRelated('星海旅人', '星海旅人'), true)
  assert.equal(bookNamesRelated('星海旅人', '星海旅人（全本）'), true)
  assert.equal(bookNamesRelated('星海 旅人', '星海旅人'), true)
  assert.equal(bookNamesRelated('《星海旅人》', '星海旅人'), true)
  assert.equal(bookNamesRelated('星海旅人', '荒野之歌'), false)
  assert.equal(bookNamesRelated('', '星海旅人'), false)
  assert.equal(bookNamesRelated('星海旅人', '   '), false)

  assert.equal(sameAuthorName('作者 甲', '作者甲'), true)
  assert.equal(sameAuthorName('作者甲', '作者乙'), false)
  assert.equal(sameAuthorName('', ''), false)
  assert.equal(sameAuthorName('   ', '作者甲'), false)
})

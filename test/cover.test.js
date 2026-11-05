import test from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers.js'

const COVER_BYTES = 2 * 1024 * 1024

function coverBook(coverUrl = 'https://example.com/cover.png') {
  return {
    id: 'book-cover',
    sourceId: 'local',
    bookUrl: 'local:book-cover',
    name: '封面书',
    local: true,
    coverUrl,
  }
}

async function putBook(service, db, book = coverBook()) {
  await db.books.put(book.id, book)
  return book
}

function stubResponse(contentType, buffer) {
  return { headers: { 'content-type': contentType }, buffer }
}

test('fetchCover uses the injected fetcher with the 2 MiB cap and caches by URL', async () => {
  const calls = []
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async (url, options) => {
      calls.push({ url, options })
      return stubResponse('image/png; charset=binary', Buffer.from([1, 2, 3]))
    },
  })
  const book = await putBook(service, db)

  const first = await service.fetchCover({ bookId: book.id })
  assert.equal(first.cached, false)
  assert.match(first.dataUrl, /^data:image\/png;base64,/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, book.coverUrl)
  assert.equal(calls[0].options.maxBytes, COVER_BYTES)

  const second = await service.fetchCover({ bookId: book.id })
  assert.equal(second.cached, true)
  assert.equal(second.dataUrl, first.dataUrl)
  assert.equal(calls.length, 1, 'the second call must come from the cover cache')
})

test('fetchCover rejects non-image content types', async () => {
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => stubResponse('text/html', Buffer.from('<html>')),
  })
  const book = await putBook(service, db)
  await assert.rejects(() => service.fetchCover({ bookId: book.id }), error => error.code === 'reader/parse-error')
})

test('fetchCover rejects a body over the 2 MiB cap even without content-length', async () => {
  const { service, db } = await serviceFixture({}, {
    fetchRemote: async () => stubResponse('image/png', Buffer.alloc(COVER_BYTES + 1)),
  })
  const book = await putBook(service, db)
  await assert.rejects(() => service.fetchCover({ bookId: book.id }), error => error.code === 'reader/too-large')
})

test('the default fetcher blocks private cover URLs before any network call', async () => {
  const { service, db } = await serviceFixture()
  const book = await putBook(service, db, coverBook('https://127.0.0.1/cover.png'))
  await assert.rejects(() => service.fetchCover({ bookId: book.id }), error => error.code === 'reader/ssrf-blocked')
})

test('fetchCover reports a missing cover URL as not-found', async () => {
  const { service, db } = await serviceFixture()
  const book = await putBook(service, db, { ...coverBook(), coverUrl: undefined })
  await assert.rejects(() => service.fetchCover({ bookId: book.id }), error => error.code === 'reader/not-found')
})

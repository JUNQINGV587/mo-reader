import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MediaStore } from '../lib/media-store.js'
import { mediaResponse, proxyResponse } from '../lib/media-http.js'
import { serviceFixture } from './helpers.js'

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mo-reader-media-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

async function readyStore(t, options = {}) {
  const root = await tempRoot(t)
  const store = new MediaStore({ root, now: () => options.now?.() ?? 1, ...options })
  await store.init()
  return { root, store }
}

test('media index persists and serves byte ranges', async (t) => {
  const { root, store } = await readyStore(t)
  const record = await store.put({
    bookId: 'book-1', chapterId: 'chapter-1', sourceId: 'source-1', title: '第一集',
    contentType: 'video/mp4', data: Buffer.from('0123456789'),
  })
  assert.equal(record.status, 'ready')
  assert.equal(store.stats().usedBytes, 10)

  const request = (range) => new Request(`http://reader.local/api/reader/media?id=${record.id}`, { headers: range ? { range } : {} })
  const range = await mediaResponse(store, request('bytes=2-5'))
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10')
  assert.equal(range.headers.get('content-length'), '4')
  assert.equal(await range.text(), '2345')

  const whole = await mediaResponse(store, new Request(`http://reader.local/api/reader/media?id=${record.id}`))
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('content-type'), 'video/mp4')
  assert.equal(await whole.text(), '0123456789')

  const head = await mediaResponse(store, new Request(`http://reader.local/api/reader/media?id=${record.id}`, { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '10')
  assert.equal(await head.text(), '')

  const invalid = await mediaResponse(store, request('bytes=50-60'))
  assert.equal(invalid.status, 416)
  assert.equal(invalid.headers.get('content-range'), 'bytes */10')
  const multi = await mediaResponse(store, request('bytes=0-1,4-5'))
  assert.equal(multi.status, 416)

  const unknown = await mediaResponse(store, new Request('http://reader.local/api/reader/media?id=deadbeefdeadbeefdeadbeef'))
  assert.equal(unknown.status, 404)
  const traversal = await mediaResponse(store, new Request('http://reader.local/api/reader/media?id=../../etc/passwd'))
  assert.equal(traversal.status, 400)
  const external = await mediaResponse(store, new Request('http://reader.local/api/reader/media?url=https://example.com/x.mp4'))
  assert.equal(external.status, 400)

  const reopened = await new MediaStore({ root }).init()
  assert.equal(reopened.record(record.id).size, 10)
  assert.equal(reopened.stats().mediaCount, 1)
})

test('media files reject symlink escapes', async (t) => {
  const { store } = await readyStore(t)
  const record = await store.put({ bookId: 'b', chapterId: 'c', contentType: 'video/mp4', data: Buffer.from('abc') })
  const link = path.join(store.filesDir, `${record.id}.bin`)
  await fs.unlink(link)
  await fs.symlink('/etc/passwd', link)
  const response = await mediaResponse(store, new Request(`http://reader.local/api/reader/media?id=${record.id}`))
  assert.ok([400, 403, 404].includes(response.status))
})

test('quota evicts oldest whole work and preserves retained items', async (t) => {
  let clock = 1
  const { store } = await readyStore(t, { quotaBytes: 40, now: () => clock++ })
  const a1 = await store.put({ bookId: 'book-a', chapterId: 'a1', contentType: 'video/mp4', data: Buffer.alloc(15) })
  const a2 = await store.put({ bookId: 'book-a', chapterId: 'a2', contentType: 'video/mp4', data: Buffer.alloc(10) })
  const b1 = await store.put({ bookId: 'book-b', chapterId: 'b1', contentType: 'video/mp4', data: Buffer.alloc(10) })
  await store.setRetained(b1.id, true)
  await store.put({ bookId: 'book-c', chapterId: 'c1', contentType: 'video/mp4', data: Buffer.alloc(12) })
  assert.equal(store.records.has(a1.id), false)
  assert.equal(store.records.has(a2.id), false)
  assert.equal(store.records.has(b1.id), true)

  await assert.rejects(
    store.put({ bookId: 'book-d', chapterId: 'd1', contentType: 'video/mp4', data: Buffer.alloc(40) }),
    error => error.code === 'reader/media-quota',
  )
  assert.equal(store.records.has(b1.id), true)
})

test('in-flight and retained books are never evicted', async (t) => {
  let clock = 1
  const { store } = await readyStore(t, { quotaBytes: 30, now: () => clock++ })
  const old = await store.put({ bookId: 'old', chapterId: 'old', contentType: 'video/mp4', data: Buffer.alloc(10) })
  const downloading = await store.reserve({ bookId: 'downloading', chapterId: 'd', contentType: 'video/mp4', size: 10 })
  await store.setRetained(old.id, true)
  await assert.rejects(store.put({ bookId: 'new', chapterId: 'n', contentType: 'video/mp4', data: Buffer.alloc(20) }), error => error.code === 'reader/media-quota')
  assert.equal(store.records.has(old.id), true)
  assert.equal(store.records.has(downloading.id), true)
})

test('aborting a reservation releases quota', async (t) => {
  const { store } = await readyStore(t, { quotaBytes: 20 })
  const reservation = await store.reserve({ bookId: 'a', chapterId: 'c', contentType: 'video/mp4', size: 20 })
  await assert.rejects(store.reserve({ bookId: 'b', chapterId: 'c', contentType: 'video/mp4', size: 1 }), error => error.code === 'reader/media-quota')
  assert.equal(await store.abort(reservation.id), true)
  const next = await store.reserve({ bookId: 'b', chapterId: 'c', contentType: 'video/mp4', size: 20 })
  await store.abort(next.id)
})

test('proxy forwards range and source headers without exposing a URL parameter', async (t) => {
  const { service } = await serviceFixture()
  const source = { id: 'source-video', name: '视频源', bookSourceUrl: 'https://source.example', allowHttp: false, enabled: true, contentType: 'video', rules: {} }
  const book = { id: 'book-video', sourceId: source.id, contentType: 'video', name: '视频书' }
  const chapter = { id: 'chapter-video', bookId: book.id, index: 0, title: '第一集', contentType: 'video', mediaUrl: 'https://media.example/video.mp4', headers: { Referer: 'https://source.example/watch' } }
  await service.db.sources.put(source.id, source)
  await service.db.books.put(book.id, book)
  await service.db.chapters.put(chapter.id, chapter)
  let captured
  service.fetchRemote = async (url, options) => {
    captured = { url, options }
    return { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '2', 'content-range': 'bytes 0-1/10' }, buffer: Buffer.from('ok') }
  }
  const response = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?bookId=book-video&chapterId=chapter-video', { headers: { range: 'bytes=0-1' } }))
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 0-1/10')
  assert.equal(captured.url, chapter.mediaUrl)
  assert.equal(captured.options.headers.Referer, 'https://source.example/watch')
  assert.equal(captured.options.headers.range, 'bytes=0-1')
  const direct = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?url=https://evil.example/x.mp4'))
  assert.equal(direct.status, 400)
})

test('service exposes media stats, list and retention', async (t) => {
  const root = await tempRoot(t)
  const store = await new MediaStore({ root }).init()
  const record = await store.put({ bookId: 'book-service', chapterId: 'chapter-service', contentType: 'audio/mpeg', data: Buffer.from('abc') })
  const { service } = await serviceFixture({}, { mediaStore: store })
  const stats = await service.mediaCacheStats()
  assert.equal(stats.mediaCount, 1)
  assert.equal(stats.usedBytes, 3)
  const list = await service.listMediaCache({ bookId: 'book-service' })
  assert.equal(list.length, 1)
  assert.equal(list[0].url, `/api/reader/media?id=${record.id}`)
  const retained = await service.setMediaRetained({ id: record.id, retained: true })
  assert.equal(retained.retained, true)
  assert.equal((await service.removeMediaCache({ id: record.id })).removed, true)
  assert.equal((await service.mediaCacheStats()).mediaCount, 0)
})

test('init rejects a symlinked media directory and clears orphan files', async (t) => {
  const root = await tempRoot(t)
  const outside = path.join(root, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'secret.bin'), 'secret')
  await fs.symlink(outside, path.join(root, 'files'))
  await assert.rejects(
    new MediaStore({ root }).init(),
    error => error.code === 'reader/media-forbidden',
  )
})

test('reopening clears files that are not in the index', async (t) => {
  const { root, store } = await readyStore(t)
  await store.put({ bookId: 'b', chapterId: 'c', contentType: 'video/mp4', data: Buffer.from('abc') })
  await fs.writeFile(path.join(store.filesDir, 'orphan.bin'), 'orphan')
  const reopened = await new MediaStore({ root }).init()
  assert.deepEqual(await fs.readdir(reopened.filesDir), [`${reopened.list()[0].id}.bin`])
})

test('replacing a ready cache cannot orphan the old file', async (t) => {
  const { store } = await readyStore(t)
  const record = await store.put({ bookId: 'b', chapterId: 'c', contentType: 'video/mp4', data: Buffer.from('old') })
  const reservation = await store.reserve({ bookId: 'b', chapterId: 'c', sourceId: undefined, contentType: 'video/mp4', size: 3 })
  await store.abort(reservation.id)
  assert.deepEqual(await fs.readdir(store.filesDir), [])
  assert.equal(store.records.has(record.id), false)
})

test('untrusted cache and proxy content types cannot execute as HTML', async (t) => {
  const { store } = await readyStore(t)
  const record = await store.put({ bookId: 'b', chapterId: 'c', contentType: 'text/html', data: Buffer.from('<script>alert(1)</script>') })
  const response = await mediaResponse(store, new Request(`http://reader.local/api/reader/media?id=${record.id}`))
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('content-disposition'), 'attachment')

  const { service } = await serviceFixture()
  const source = { id: 's', name: '视频源', bookSourceUrl: 'https://source.example', allowHttp: false, enabled: true, contentType: 'video', rules: {} }
  const book = { id: 'b', sourceId: 's', contentType: 'video', name: '视频书' }
  const chapter = { id: 'c', bookId: 'b', index: 0, title: '第一集', contentType: 'video', mediaUrl: 'https://media.example/x.mp4', headers: {} }
  await service.db.sources.put(source.id, source)
  await service.db.books.put(book.id, book)
  await service.db.chapters.put(chapter.id, chapter)
  service.fetchRemote = async () => ({ status: 200, headers: { 'content-type': 'text/html' }, buffer: Buffer.from('<html>') })
  const proxied = await proxyResponse(service, new Request('http://reader.local/api/reader/proxy?bookId=b&chapterId=c'))
  assert.equal(proxied.status, 415)
})

test('removing a book clears its cached media', async (t) => {
  const root = await tempRoot(t)
  const store = await new MediaStore({ root }).init()
  const record = await store.put({ bookId: 'book-media', chapterId: 'c', contentType: 'audio/mpeg', data: Buffer.from('abc') })
  const { service, db } = await serviceFixture({}, { mediaStore: store })
  await db.books.put('book-media', { id: 'book-media', name: '书', local: true, chapters: [] })
  await service.removeBook({ bookId: 'book-media' })
  assert.equal(store.records.has(record.id), false)
  assert.equal(store.stats().mediaCount, 0)
})

test('removing a book can preserve retained records', async (t) => {
  const { store } = await readyStore(t)
  const retained = await store.put({ bookId: 'book-a', chapterId: 'keep', contentType: 'video/mp4', data: Buffer.from('keep') })
  const temporary = await store.put({ bookId: 'book-a', chapterId: 'drop', contentType: 'video/mp4', data: Buffer.from('drop') })
  await store.setRetained(retained.id, true)
  await store.removeBook('book-a', { includeRetained: false })
  assert.equal(store.records.has(retained.id), true)
  assert.equal(store.records.has(temporary.id), false)
})

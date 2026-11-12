import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv } from 'node:crypto'
import { MediaStore } from '../lib/media-store.js'
import { downloadMediaChapter } from '../lib/media-download.js'
import { serviceFixture } from './helpers.js'
import { jobView } from '../lib/jobs.js'

const key = Buffer.alloc(16, 7)
const iv = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

function encrypt(data) {
  const cipher = createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

async function tempStore(quotaBytes = 1024 * 1024) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-hls-'))
  const store = new MediaStore({ root, quotaBytes })
  await store.init()
  return { root, store }
}

function fixture({ failSegment = false } = {}) {
  const cipher0 = encrypt(Buffer.from('segment-zero-data'))
  const cipher1 = encrypt(Buffer.from('segment-one-data'))
  const calls = []
  const fetchRemote = async (url) => {
    calls.push(url)
    if (url.endsWith('master.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n'), text: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n' }
    if (url.endsWith('low.m3u8')) throw new Error('must select highest variant')
    if (url.endsWith('high.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00112233445566778899aabbccddeeff\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n'), text: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00112233445566778899aabbccddeeff\n#EXTINF:1.0,\nseg0.ts\n#EXTINF:1.0,\nseg1.ts\n#EXT-X-ENDLIST\n' }
    if (url.endsWith('key.bin')) return { url, headers: {}, buffer: key }
    if (url.endsWith('seg0.ts')) return { url, headers: {}, buffer: cipher0 }
    if (url.endsWith('seg1.ts')) {
      if (failSegment) throw new Error('segment failed')
      return { url, headers: {}, buffer: cipher1 }
    }
    throw new Error(`unexpected ${url}`)
  }
  return { fetchRemote, calls }
}

const book = { id: 'book1', sourceId: 'src1', bookUrl: 'https://media.example/book', contentType: 'video' }
const chapter = { id: 'ch1', bookId: 'book1', title: '第一集', url: 'https://media.example/ch1' }

test('HLS downloads highest variant, decrypts segments and publishes a local playlist', async () => {
  const { store } = await tempStore()
  const { fetchRemote, calls } = fixture()
  const offline = await downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/master.m3u8', headers: { referer: 'https://media.example', 'x-secret': 'no-store' } },
  })
  assert.equal(offline.kind, 'hls')
  assert.equal(offline.segments.length, 2)
  assert.equal(calls.some(url => url.endsWith('low.m3u8')), false)
  const playlist = store.record(offline.playlistId)
  const segment0 = store.record(offline.segments[0])
  assert.equal(playlist.status, 'ready')
  assert.equal(playlist.contentType, 'application/vnd.apple.mpegurl')
  assert.equal(segment0.size, Buffer.byteLength('segment-zero-data'))
  const indexText = await fs.readFile(path.join(store.root, 'index.json'), 'utf8')
  assert.equal(indexText.includes('no-store'), false)
  assert.equal(indexText.includes(key.toString('base64')), false)
  const reopened = new MediaStore({ root: store.root })
  await reopened.init()
  assert.equal(reopened.record(offline.playlistId).status, 'ready')
  assert.equal(reopened.record(offline.segments[1]).status, 'ready')
})

test('paused HLS download keeps completed segments and resumes without refetching them', async () => {
  const { store } = await tempStore()
  const { fetchRemote, calls } = fixture()
  let running = true
  let checks = 0
  const first = await downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/master.m3u8', headers: {} },
    isRunning: async () => { checks += 1; if (checks > 1) running = false; return running },
  })
  assert.equal(first.paused, true)
  assert.equal(store.list({ bookId: book.id }).find(record => record.asset?.startsWith('segment-') && record.asset.endsWith('-00000')).status, 'ready')
  assert.equal(store.findAsset({ sourceId: book.sourceId, bookId: book.id, chapterId: chapter.id, asset: 'playlist' }), null)
  const before = calls.filter(url => url.endsWith('seg0.ts')).length
  const second = await downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/master.m3u8', headers: {} },
  })
  assert.equal(second.paused, undefined)
  assert.equal(calls.filter(url => url.endsWith('seg0.ts')).length, before)
  assert.equal(store.record(second.playlistId).status, 'ready')
})

test('comic downloads images in order and a missing image fails without a published chapter', async () => {
  const { store } = await tempStore()
  const calls = []
  const fetchRemote = async url => {
    calls.push(url)
    if (url.endsWith('missing.jpg')) throw new Error('missing')
    return { url, headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from(url) }
  }
  const offline = await downloadMediaChapter({
    store, book: { ...book, contentType: 'comic' }, chapter, fetchRemote,
    payload: { images: ['https://img.example/2.jpg', 'https://img.example/1.jpg'], headers: {} },
  })
  assert.equal(offline.kind, 'comic')
  assert.deepEqual(calls, ['https://img.example/2.jpg', 'https://img.example/1.jpg'])
  assert.deepEqual(offline.images.map(id => store.record(id).asset), ['image-00000', 'image-00001'])
  await assert.rejects(() => downloadMediaChapter({
    store, book: { ...book, contentType: 'comic' }, chapter: { ...chapter, id: 'ch2' }, fetchRemote,
    payload: { images: ['https://img.example/1.jpg', 'https://img.example/missing.jpg'], headers: {} },
  }), /missing/)
  assert.equal(store.findAsset({ sourceId: book.sourceId, bookId: book.id, chapterId: 'ch2', asset: 'playlist' }), null)
})

test('service download caches offline HLS and reports retry when a chapter fails', async () => {
  const { store } = await tempStore()
  const { fetchRemote } = fixture()
  const chapters = [
    { id: 'c1', title: '第一集', url: 'https://media.example/ch1' },
    { id: 'c2', title: '第二集', url: 'https://media.example/ch2' },
  ]
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => chapters.map(ch => ({ ...ch })),
    content: async (_source, _book, ch) => ({ contentType: 'video', mediaUrl: `https://media.example/${ch.id}.m3u8`, headers: { referer: 'https://media.example' } }),
  }
  // Only c1 is HLS; c2 fails before a payload can be returned.
  let c2Broken = true
  const contentCalls = []
  engine.content = async (_source, _book, ch) => {
    contentCalls.push(ch.id)
    if (ch.id === 'c2' && c2Broken) throw new Error('no stream')
    return { contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: {} }
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  const source = {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  }
  await db.sources.put(source.id, source)
  const added = await service.addBook({ sourceId: source.id, bookUrl: 'https://media.example/book' })
  const [job, duplicate] = await Promise.all([service.download({ bookId: added.id }), service.download({ bookId: added.id })])
  assert.equal(duplicate.id, job.id)
  assert.equal(service.runningJobs.size, 1)
  await service.runningJobs.get(job.id)
  const stored = db.jobs.get(job.id)
  assert.equal(stored.status, 'completed')
  assert.equal(jobView(stored).state, 'retry')
  assert.deepEqual(stored.failedChapters, ['c2'])
  assert.match(stored.failedReasons.c2, /no stream/)
  assert.equal((await service.state()).books[0].download.status, 'partial')
  assert.equal((await service.state()).books[0].download.auto, false)
  assert.ok(db.chapters.get('c1').offline.playlistId)
  assert.equal(db.chapters.get('c1').headers, undefined)
  assert.equal(db.chapters.get('c2').offline, undefined)
  const chapterView = await service.chapter({ bookId: added.id, chapterId: 'c1' })
  assert.equal(chapterView.downloaded, true)
  assert.equal(chapterView.offline.playlistId, db.chapters.get('c1').offline.playlistId)
  assert.equal((await service.state()).books[0].download.done, 1)
  const backup = await service.exportBackup()
  assert.equal(backup.includes('offline'), false)
  assert.equal(backup.includes('playlistId'), false)
  c2Broken = false
  contentCalls.length = 0
  const retry = await service.download({ bookId: added.id })
  await service.runningJobs.get(retry.id)
  assert.equal(db.jobs.get(retry.id).status, 'completed')
  assert.equal(jobView(db.jobs.get(retry.id)).state, 'ready')
  assert.deepEqual(contentCalls, ['c2'])
  assert.equal((await service.state()).books[0].download.status, 'completed')
})

test('direct audio/video downloads one decryptable file asset', async () => {
  const { store } = await tempStore()
  const fetchRemote = async url => ({ url, headers: { 'content-type': 'video/mp4' }, buffer: Buffer.from('video-bytes') })
  const offline = await downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/movie.mp4', headers: { referer: 'https://media.example' } },
  })
  assert.equal(offline.kind, 'file')
  assert.equal(store.record(offline.mediaId).contentType, 'video/mp4')
  assert.equal(store.record(offline.mediaId).size, Buffer.byteLength('video-bytes'))
  assert.equal(JSON.stringify(store.list()).includes('referer'), false)
})

test('quota exhaustion fails without publishing a playlist', async () => {
  const { store } = await tempStore(20)
  const { fetchRemote } = fixture()
  await assert.rejects(() => downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/master.m3u8', headers: {} },
  }), error => error.code === 'reader/media-quota')
  assert.equal(store.findAsset({ sourceId: book.sourceId, bookId: book.id, chapterId: chapter.id, asset: 'playlist' }), null)
})

test('pausing a service job keeps completed HLS segments and resumes without refetching them', async () => {
  const { store } = await tempStore()
  const hls = fixture()
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => [{ id: 'c1', title: '第一集', url: 'https://media.example/ch1' }],
    content: async () => ({ contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: {} }),
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote: hls.fetchRemote, mediaStore: store })
  await db.sources.put('src1', {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  let paused = false
  service.fetchRemote = async (url, options) => {
    const response = await hls.fetchRemote(url, options)
    if (!paused && url.endsWith('seg1.ts')) {
      paused = true
      await service.pauseJob({ bookId: added.id })
    }
    return response
  }
  const job = await service.download({ bookId: added.id })
  await service.runningJobs.get(job.id)
  assert.equal(db.jobs.get(job.id).status, 'paused')
  assert.equal(db.chapters.get('c1').offline, undefined)
  assert.equal((await service.download({ bookId: added.id })).id, job.id)
  const before = hls.calls.filter(url => url.endsWith('seg0.ts')).length
  await service.resumeJob({ bookId: added.id })
  await service.runningJobs.get(job.id)
  assert.equal(db.jobs.get(job.id).status, 'completed')
  assert.ok(db.chapters.get('c1').offline.playlistId)
  assert.equal(hls.calls.filter(url => url.endsWith('seg0.ts')).length, before)
  assert.equal(jobView(db.jobs.get(job.id)).state, 'ready')
})

test('a failed chapter leaves no half-visible media records for that chapter', async () => {
  const { store } = await tempStore()
  const { fetchRemote } = fixture({ failSegment: true })
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => [{ id: 'c1', title: '第一集', url: 'https://media.example/ch1' }],
    content: async () => ({ contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: {} }),
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  await db.sources.put('src1', {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  const job = await service.download({ bookId: added.id })
  await service.runningJobs.get(job.id)
  assert.equal(jobView(db.jobs.get(job.id)).state, 'retry')
  assert.equal(db.chapters.get('c1').offline, undefined)
  assert.equal(store.findAsset({ sourceId: 'src1', bookId: added.id, chapterId: 'c1', asset: 'playlist' }), null)
  assert.equal(store.list({ bookId: added.id }).some(record => record.status === 'downloading'), false)
})

test('HLS falls back to the next variant when the highest playlist is unavailable', async () => {
  const { store } = await tempStore()
  const fetchRemote = async url => {
    if (url.endsWith('master.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n') }
    if (url.endsWith('high.m3u8')) throw new Error('high unavailable')
    if (url.endsWith('low.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXTINF:1,\nlow.ts\n#EXT-X-ENDLIST\n') }
    if (url.endsWith('low.ts')) return { url, headers: {}, buffer: Buffer.from('low-segment') }
    throw new Error(`unexpected ${url}`)
  }
  const offline = await downloadMediaChapter({ store, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/master.m3u8', headers: {} } })
  assert.equal(offline.kind, 'hls')
  assert.equal(offline.segments.length, 1)
})

test('HLS rejects non-identity key formats and master session keys', async () => {
  const { store } = await tempStore()
  const keyFormats = async url => {
    if (url.endsWith('media.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n') }
    throw new Error(`unexpected ${url}`)
  }
  await assert.rejects(() => downloadMediaChapter({ store, book, chapter, fetchRemote: keyFormats, payload: { mediaUrl: 'https://media.example/media.m3u8', headers: {} } }), /密钥格式/)
  const sessionKey = async url => ({ url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://key"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nmedia.m3u8\n') })
  await assert.rejects(() => downloadMediaChapter({ store, book, chapter, fetchRemote: sessionKey, payload: { mediaUrl: 'https://media.example/master.m3u8', headers: {} } }), /DRM/)
})

test('quota exhaustion fails the media job instead of leaving it in retry', async () => {
  const { store } = await tempStore(20)
  const { fetchRemote } = fixture()
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => [{ id: 'c1', title: '第一集', url: 'https://media.example/ch1' }],
    content: async () => ({ contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: {} }),
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  await db.sources.put('src1', {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  const job = await service.download({ bookId: added.id })
  await service.runningJobs.get(job.id)
  assert.equal(db.jobs.get(job.id).status, 'failed')
  assert.equal((await service.state()).books[0].download.status, 'failed')
  assert.equal(store.findAsset({ sourceId: 'src1', bookId: added.id, chapterId: 'c1', asset: 'playlist' }), null)
  assert.equal(store.list({ bookId: added.id }).some(record => record.status === 'downloading'), false)
})

test('direct media rejects a response whose byte count does not match its declared length', async () => {
  const { store } = await tempStore()
  const fetchRemote = async url => ({ url, headers: { 'content-type': 'video/mp4', 'content-length': '99' }, buffer: Buffer.from('short') })
  await assert.rejects(() => downloadMediaChapter({ store, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/movie.mp4', headers: {} } }), /长度/)
})

test('a download can target selected chapters only', async () => {
  const { store } = await tempStore()
  const { fetchRemote } = fixture()
  const calls = []
  const chapters = [
    { id: 'c1', title: '第一集', url: 'https://media.example/ch1' },
    { id: 'c2', title: '第二集', url: 'https://media.example/ch2' },
  ]
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => chapters.map(chapter => ({ ...chapter })),
    content: async (_source, _book, chapter) => {
      calls.push(chapter.id)
      return { contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: {} }
    },
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  await db.sources.put('src1', {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  await service.toc({ bookId: added.id })
  const job = await service.download({ bookId: added.id, chapterIds: ['c2'] })
  await service.runningJobs.get(job.id)
  assert.deepEqual(calls, ['c2'])
  assert.equal(db.chapters.get('c1').offline, undefined)
  assert.ok(db.chapters.get('c2').offline.playlistId)
  assert.equal(db.jobs.get(job.id).total, 1)
})

test('direct media downloads over ranged requests and resumes an existing partial file', async () => {
  const { root, store } = await tempStore()
  const body = Buffer.from('abcdef')
  const reservation = await store.reserveFile({
    bookId: book.id, chapterId: chapter.id, sourceId: book.sourceId,
    asset: 'media', title: chapter.title, contentType: 'video/mp4', size: body.length,
  })
  await fs.appendFile(reservation.path, body.subarray(0, 4))
  const reopened = new MediaStore({ root, quotaBytes: 1024 * 1024 })
  await reopened.init()
  assert.equal(reopened.list({ bookId: book.id })[0].status, 'downloading')
  const ranges = []
  const fetchRemote = async (url, options) => {
    const header = options.headers.Range
    ranges.push(header)
    const match = /^bytes=(\d+)-(\d+)$/.exec(header)
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    return {
      url,
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${body.length}` },
      buffer: body.subarray(start, end + 1),
    }
  }
  const offline = await downloadMediaChapter({ store: reopened, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/movie.mp4', headers: {} } })
  assert.equal(offline.kind, 'file')
  assert.deepEqual(ranges, ['bytes=0-0', 'bytes=4-5'])
  const record = reopened.list({ bookId: book.id }).find(item => item.id === offline.mediaId)
  const file = await reopened.filePath(record)
  assert.equal(await fs.readFile(file.path, 'utf8'), 'abcdef')
})

test('a direct media download pauses inside the partial file', async () => {
  const { store } = await tempStore()
  const body = Buffer.from('abcdefgh')
  let calls = 0
  const fetchRemote = async (url, options) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    calls += 1
    return { url, status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${body.length}` }, buffer: body.subarray(start, end + 1) }
  }
  const offline = await downloadMediaChapter({
    store, book, chapter, fetchRemote,
    payload: { mediaUrl: 'https://media.example/movie.mp4', headers: {} },
    isRunning: async () => calls < 2,
  })
  assert.deepEqual(offline, { paused: true })
})

test('quota failure removes previously cached chapters so no half work stays visible', async () => {
  const { store } = await tempStore(25)
  const sizes = { 'small.mp4': 10, 'large.mp4': 100 }
  const fetchRemote = async (url, options) => {
    const total = sizes[url.split('/').pop()]
    if (!total) throw new Error(`unexpected ${url}`)
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.headers.Range)
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), total - 1)
    return { url, status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${total}` }, buffer: Buffer.alloc(end - start + 1, 1) }
  }
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => [
      { id: 'c1', title: '第一集', url: 'https://media.example/ch1' },
      { id: 'c2', title: '第二集', url: 'https://media.example/ch2' },
    ],
    content: async (_source, _book, chapter) => ({ contentType: 'video', mediaUrl: `https://media.example/${chapter.id === 'c1' ? 'small.mp4' : 'large.mp4'}`, headers: {} }),
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  await db.sources.put('src1', {
    id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', allowHttp: false,
    rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } },
  })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  const job = await service.download({ bookId: added.id })
  await service.runningJobs.get(job.id)
  assert.equal(db.jobs.get(job.id).status, 'failed')
  assert.equal(db.chapters.get('c1').offline, undefined)
  assert.deepEqual(store.list({ bookId: added.id }), [])
  assert.equal((await service.state()).books[0].download.status, 'failed')
})

test('media downloads forward allowHttp to every HTTP request', async () => {
  const { store } = await tempStore()
  const seen = []
  const fetchRemote = async (url, options) => {
    seen.push(options.allowHttp)
    if (url.endsWith('master.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXTINF:1,\nseg.ts\n#EXT-X-ENDLIST\n') }
    return { url, headers: { 'content-type': 'video/mp2t' }, buffer: Buffer.from('data') }
  }
  const offline = await downloadMediaChapter({
    store, book, chapter, fetchRemote, allowHttp: true,
    payload: { mediaUrl: 'http://media.example/master.m3u8', headers: {} },
  })
  assert.equal(offline.kind, 'hls')
  assert.equal(seen.every(value => value === true), true)
})

test('HLS resume keys segments by the selected rendition, not the master URL', async () => {
  const { store } = await tempStore()
  const calls = []
  let highWorks = false
  const fetchRemote = async url => {
    calls.push(url)
    if (url.endsWith('master.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=900\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100\nlow.m3u8\n') }
    if (url.endsWith('high.m3u8')) {
      if (!highWorks) throw new Error('high unavailable')
      return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXTINF:1,\nhigh.ts\n#EXT-X-ENDLIST\n') }
    }
    if (url.endsWith('low.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXTINF:1,\nlow.ts\n#EXT-X-ENDLIST\n') }
    return { url, headers: { 'content-type': 'video/mp2t' }, buffer: Buffer.from(url) }
  }
  const payload = { mediaUrl: 'https://media.example/master.m3u8', headers: {} }
  await downloadMediaChapter({ store, book, chapter, fetchRemote, payload })
  highWorks = true
  calls.length = 0
  await downloadMediaChapter({ store, book, chapter, fetchRemote, payload })
  assert.ok(calls.some(url => url.endsWith('high.ts')))
})

test('HLS fMP4 init segments are stored and referenced by the local playlist', async () => {
  const { store } = await tempStore()
  const fetchRemote = async url => {
    if (url.endsWith('media.m3u8')) return { url, headers: {}, buffer: Buffer.from('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nseg.m4s\n#EXT-X-ENDLIST\n') }
    if (url.endsWith('init.mp4')) return { url, headers: { 'content-type': 'video/mp4' }, buffer: Buffer.from('init') }
    if (url.endsWith('seg.m4s')) return { url, headers: { 'content-type': 'video/iso.segment' }, buffer: Buffer.from('segment') }
    throw new Error(`unexpected ${url}`)
  }
  const offline = await downloadMediaChapter({ store, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/media.m3u8', headers: {} } })
  assert.ok(offline.initId)
  const playlist = await fs.readFile((await store.filePath(store.record(offline.playlistId))).path)
  assert.match(playlist.toString('utf8'), /#EXT-X-MAP:URI="\/api\/reader\/media\?id=/)
  assert.ok(store.has(offline.initId))
})

test('evicted media is no longer reported as downloaded and chapter re-fetches metadata', async () => {
  const { store } = await tempStore()
  const { fetchRemote } = fixture()
  let contentCalls = 0
  const engine = {
    bookInfo: async () => ({ name: '视频书', author: '作者' }),
    toc: async () => [{ id: 'c1', title: '第一集', url: 'https://media.example/ch1' }],
    content: async () => {
      contentCalls += 1
      return { contentType: 'video', mediaUrl: 'https://media.example/master.m3u8', headers: { referer: 'https://media.example' } }
    },
  }
  const { service, db } = await serviceFixture(engine, { fetchRemote, mediaStore: store })
  await db.sources.put('src1', { id: 'src1', name: '视频源', bookSourceUrl: 'https://media.example', contentType: 'video', rules: { toc: { chapterList: 'a', chapterName: 'a', chapterUrl: 'a@href' }, content: { content: 'video' } } })
  const added = await service.addBook({ sourceId: 'src1', bookUrl: 'https://media.example/book' })
  const [first] = await service.toc({ bookId: added.id })
  const job = await service.download({ bookId: added.id, chapterIds: [first.id] })
  await service.runningJobs.get(job.id)
  assert.equal((await service.state()).books[0].download.status, 'completed')
  await store.removeBook(added.id, { includeRetained: false })
  const state = await service.state()
  assert.equal(state.books[0].download.status, 'partial')
  assert.equal(state.books[0].download.done, 0)
  assert.equal((await service.toc({ bookId: added.id, refresh: true }))[0].downloaded, false)
  const chapter = await service.chapter({ bookId: added.id, chapterId: first.id })
  assert.equal(contentCalls, 2)
  assert.equal(chapter.downloaded, false)
  assert.equal(chapter.offline, undefined)
  assert.equal(chapter.mediaUrl, 'https://media.example/master.m3u8')
})

test('a transient direct-download failure preserves the partial file for retry', async () => {
  const { root, store } = await tempStore()
  const body = Buffer.from('abcdef')
  let failed = false
  const ranges = []
  const fetchRemote = async (url, options) => {
    const header = options.headers.Range
    ranges.push(header)
    const match = /^bytes=(\d+)-(\d+)$/.exec(header)
    const start = Number(match[1])
    const end = Math.min(Number(match[2]), body.length - 1)
    if (!failed && start > 0) {
      failed = true
      throw new Error('transient network failure')
    }
    return { url, status: 206, headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${body.length}` }, buffer: body.subarray(start, end + 1) }
  }
  await assert.rejects(downloadMediaChapter({ store, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/movie.mp4', headers: {} } }), /transient network failure/)
  const downloading = store.list({ bookId: book.id }).find(item => item.status === 'downloading')
  assert.ok(downloading)
  assert.equal((await fs.stat(await store.partialPath(downloading.id))).size, 1)
  const reopened = new MediaStore({ root, quotaBytes: 1024 * 1024 })
  await reopened.init()
  const offline = await downloadMediaChapter({ store: reopened, book, chapter, fetchRemote, payload: { mediaUrl: 'https://media.example/movie.mp4', headers: {} } })
  assert.equal(offline.kind, 'file')
  assert.equal(ranges.at(-1), 'bytes=1-5')
  const record = reopened.list({ bookId: book.id }).find(item => item.id === offline.mediaId)
  assert.equal(await fs.readFile((await reopened.filePath(record)).path, 'utf8'), 'abcdef')
})

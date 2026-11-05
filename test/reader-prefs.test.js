import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SETTINGS, normalizeReaderPrefs, normalizeSettings } from '../lib/settings.js'
import { ReaderDomain } from '../lib/storage.js'
import { createBackup, parseBackup } from '../lib/backup.js'
import { memoryDb, serviceFixture } from './helpers.js'

test('settings defaults carry mode/flipStyle and validate both enums', () => {
  assert.equal(DEFAULT_SETTINGS.mode, 'paged')
  assert.equal(DEFAULT_SETTINGS.flipStyle, 'slide')
  assert.equal(normalizeSettings({}).mode, 'paged')
  assert.equal(normalizeSettings({ mode: 'scroll' }).mode, 'scroll')
  assert.equal(normalizeSettings({ flipStyle: 'curl' }).flipStyle, 'curl')
  assert.throws(() => normalizeSettings({ mode: 'book' }), /mode/)
  assert.throws(() => normalizeSettings({ flipStyle: 'spin' }), /flipStyle/)
})

test('readerPrefs only accepts the three per-book keys', () => {
  assert.deepEqual(normalizeReaderPrefs({}), {})
  assert.deepEqual(normalizeReaderPrefs({ mode: 'scroll', flipStyle: 'fade', ambience: 'off' }), { mode: 'scroll', flipStyle: 'fade', ambience: 'off' })
  assert.throws(() => normalizeReaderPrefs({ fontSize: 22 }), /readerPrefs/)
  assert.throws(() => normalizeReaderPrefs({ mode: 'page' }), /readerPrefs\.mode/)
  assert.throws(() => normalizeReaderPrefs({ ambience: 'dim' }), /readerPrefs\.ambience/)
})

test('setBookSettings writes, merges, clears a key and clears all overrides', async () => {
  const { service, db } = await serviceFixture()
  const book = { id: 'book-1', sourceId: 'local', bookUrl: 'local:book-1', name: '书', local: true }
  await db.books.put(book.id, book)

  const first = await service.setBookSettings({ bookId: book.id, mode: 'scroll' })
  assert.deepEqual(first.readerPrefs, { mode: 'scroll' })
  assert.equal(db.books.get(book.id).readerPrefs.mode, 'scroll')

  const merged = await service.setBookSettings({ bookId: book.id, flipStyle: 'curl', ambience: 'paper' })
  assert.deepEqual(merged.readerPrefs, { mode: 'scroll', flipStyle: 'curl', ambience: 'paper' })
  assert.deepEqual((await service.state()).books[0].readerPrefs, { mode: 'scroll', flipStyle: 'curl', ambience: 'paper' })

  const dropped = await service.setBookSettings({ bookId: book.id, mode: null })
  assert.deepEqual(dropped.readerPrefs, { flipStyle: 'curl', ambience: 'paper' })

  const cleared = await service.setBookSettings({ bookId: book.id, clear: true })
  assert.equal(cleared.readerPrefs, null)
  assert.equal('readerPrefs' in db.books.get(book.id), false)
  assert.equal((await service.state()).books[0].readerPrefs, null)

  await assert.rejects(() => service.setBookSettings({ bookId: book.id, fontSize: 22 }), /readerPrefs/)
  await assert.rejects(() => service.setBookSettings({ bookId: 'missing', mode: 'scroll' }), /not found/i)
})

test('backup keeps readerPrefs and still strips credentials', async () => {
  const books = [{
    id: 'book-1', sourceId: 'local', bookUrl: 'local:book-1', name: '书', local: true,
    readerPrefs: { mode: 'scroll', flipStyle: 'fade' }, progress: { chapterId: 'c1', offset: 12, percent: 3 },
    cookie: 'secret', download: { status: 'none' },
  }]
  const backup = createBackup({ sources: [], books, chapters: [], settings: DEFAULT_SETTINGS, notes: [] })
  const raw = JSON.parse(backup)
  assert.deepEqual(raw.books[0].readerPrefs, { mode: 'scroll', flipStyle: 'fade' })
  assert.equal('cookie' in raw.books[0], false)
  const restored = parseBackup(backup)
  assert.deepEqual(restored.books[0].readerPrefs, { mode: 'scroll', flipStyle: 'fade' })
  assert.equal(restored.books[0].progress.offset, 12)
})

const MOTION_KEYS = ['mode', 'flipStyle', 'animations', 'motionQuality', 'ambience', 'shelfMotion', 'reducedMotion']

test('a global record written before the motion keys parses with defaults', () => {
  const legacy = { ...DEFAULT_SETTINGS }
  for (const key of MOTION_KEYS) delete legacy[key]
  const parsed = ReaderDomain.global.schema.parse(legacy)
  assert.equal(parsed.mode, 'paged')
  assert.equal(parsed.flipStyle, 'slide')
  assert.equal(parsed.animations, true)
  assert.equal(parsed.motionQuality, 'auto')
  assert.equal(parsed.ambience, 'full')
  assert.equal(parsed.shelfMotion, true)
  assert.equal(parsed.reducedMotion, 'system')
  assert.throws(() => ReaderDomain.global.schema.parse({ ...DEFAULT_SETTINGS, reducedMotion: 'sometimes' }))
})

test('Settings.init keeps old rows readable when the new keys are missing', () => {
  const db = memoryDb()
  const legacy = { ...DEFAULT_SETTINGS }
  delete legacy.mode
  delete legacy.flipStyle
  assert.equal(normalizeSettings({}, legacy).mode, 'paged')
  assert.equal(normalizeSettings({}, legacy).flipStyle, 'slide')
  assert.ok(db)
})

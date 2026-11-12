import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSource } from '../lib/rules.js'
import { SourceEngine } from '../lib/source-engine.js'
import { serviceFixture, source as baseSource } from './helpers.js'

const sourceBase = {
  bookSourceName: '分类源',
  bookSourceUrl: 'https://example.com',
  ruleSearch: { url: '/search?q={{key}}', bookList: '.book', name: '.name', bookUrl: '.name@href' },
}

test('Legado source types map to book content types and type 3 is rejected', () => {
  for (const [type, expected] of [[0, 'novel'], [1, 'audio'], [2, 'comic'], [4, 'video'], [undefined, 'novel']]) {
    const normalized = normalizeSource({ ...sourceBase, ...(type === undefined ? {} : { bookSourceType: type }) })
    assert.equal(normalized.contentType, expected)
  }
  assert.throws(() => normalizeSource({ ...sourceBase, bookSourceType: 3 }), /类型 3|网络文件|unsupported/)
  assert.throws(() => normalizeSource({ ...sourceBase, bookSourceType: 3, contentType: 'video' }), /类型 3|网络文件|unsupported/)
  assert.throws(() => normalizeSource({ ...sourceBase, bookSourceType: 9 }), /书源类型 9|unsupported/)
})

test('search results carry the source content type', async () => {
  const engine = new SourceEngine({
    fetch: async () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      url: 'https://example.com/search?q=comic',
      text: '<div class="book"><a class="name" href="/comic/1">漫画一</a></div>',
    }),
  })
  const normalized = normalizeSource({ ...sourceBase, bookSourceType: 2 })
  const found = await engine.search(normalized, { query: '漫画' })
  assert.equal(found.items[0].contentType, 'comic')
})

function engineFixture() {
  return {
    async bookInfo(_source, bookUrl) { return { name: '类型作品', author: '作者', bookUrl } },
  }
}

test('books persist and back up their content type while legacy text books become novels', async () => {
  const { service, db } = await serviceFixture(engineFixture())
  const audio = normalizeSource({ ...sourceBase, bookSourceName: '音频源', bookSourceType: 1 })
  await db.sources.put(audio.id, audio)
  const book = await service.addBook({ sourceId: audio.id, bookUrl: 'https://example.com/audio/1' })
  assert.equal(book.contentType, 'audio')
  await db.sources.put('legacy-source', { ...baseSource, id: 'legacy-source', bookSourceName: '旧源', bookSourceUrl: 'https://legacy.example.com', contentType: 'text' })

  const backup = JSON.parse(await service.exportBackup())
  assert.equal(backup.sources.find(item => item.id === audio.id).contentType, 'audio')
  assert.equal(backup.sources.find(item => item.id === 'legacy-source').contentType, 'novel')
  assert.equal(backup.books.find(item => item.id === book.id).contentType, 'audio')

  await db.books.put('legacy-book', {
    id: 'legacy-book',
    sourceId: baseSource.id,
    bookUrl: 'https://example.com/legacy',
    name: '旧书',
    contentType: 'text',
  })
  await db.books.put('legacy-missing', {
    id: 'legacy-missing',
    sourceId: baseSource.id,
    bookUrl: 'https://example.com/legacy-missing',
    name: '缺类型旧书',
  })
  const state = await service.state()
  assert.equal(state.books.find(item => item.id === 'legacy-book').contentType, 'novel')
  assert.equal(state.books.find(item => item.id === 'legacy-missing').contentType, 'novel')
  const legacyBackup = JSON.parse(await service.exportBackup())
  assert.equal(legacyBackup.books.find(item => item.id === 'legacy-book').contentType, 'novel')

  await service.importBackup({ data: backup })
  const restored = await service.state()
  assert.equal(restored.books.find(item => item.id === book.id).contentType, 'audio')
  assert.equal(restored.sources.find(item => item.id === audio.id).contentType, 'audio')
})

import { Context } from '@deepseek-ai/cordis'
import { ReaderService } from '../index.js'
import { DEFAULT_SETTINGS } from '../lib/storage.js'
import { stableId } from '../lib/utils.js'

export function memoryTable(initial = []) {
  const map = new Map(initial.map(value => [value.id, value]))
  return {
    get: key => map.get(key),
    entries: () => map.entries(),
    get size() { return map.size },
    async put(key, value) { map.set(key, structuredClone(value)) },
    async delete(key) { return map.delete(key) },
    async deleteMany(keys) {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
    async update(key, fn) {
      if (!map.has(key)) throw new Error('missing-key')
      const next = fn(map.get(key))
      map.set(key, next)
      return next
    },
  }
}

export function memoryDb() {
  let settings = structuredClone(DEFAULT_SETTINGS)
  return {
    sources: memoryTable(),
    books: memoryTable(),
    chapters: memoryTable(),
    jobs: memoryTable(),
    notes: memoryTable(),
    folders: memoryTable(),
    settings: { get: () => settings, async set(value) { settings = structuredClone(value) } },
    domain: { async close() {} },
  }
}

export async function serviceFixture(engine = {}, options = {}) {
  const ctx = new Context()
  const service = new ReaderService(ctx, { engine, ...options })
  service.db = memoryDb()
  return { ctx, service, db: service.db }
}

export const source = {
  id: stableId('source', 'https://example.com'),
  name: 'Example',
  bookSourceUrl: 'https://example.com',
  allowHttp: false,
  rules: {
    search: { url: '/search?q={{key}}&page={{page}}', bookList: '.book', name: '.name', bookUrl: 'a@href' },
    explore: {},
    bookInfo: { name: 'h1', author: '.author' },
    toc: { chapterList: '.chapter', chapterName: 'a', chapterUrl: 'a@href' },
    content: { content: '#content' },
  },
}

import test from 'node:test'
import assert from 'node:assert/strict'
import { SourceEngine } from '../lib/source-engine.js'
import { mergeSetCookies } from '../lib/cookies.js'
import { serviceFixture } from './helpers.js'

const SITE = 'https://cookie.example'

function page(entries) {
  return '<!doctype html><html><body>' + entries.join('') + '</body></html>'
}

function entry(id, title) {
  return '<div class="entry"><a href="/post/' + id + '" title="' + title + '">' + title + '</a><span class="date">2026-11-1' + id + ' 09:00</span></div>'
}

function rssSource(overrides = {}) {
  return {
    sourceName: 'Cookie 订阅',
    sourceUrl: SITE + '#',
    sortUrl: '新闻::/news/page/{{page}}.html',
    ruleArticles: '.entry',
    ruleTitle: 'a@title',
    ruleLink: 'a@href',
    rulePubDate: '.date@text',
    header: JSON.stringify({ Cookie: 'session=seed', 'User-Agent': 'ModuReader/1.0' }),
    enabledCookieJar: true,
    ...overrides,
  }
}

function fakeEngine({ paths, onChange } = {}) {
  const calls = []
  const engine = new SourceEngine({
    maxTocPages: 1,
    fetch: async (url, config = {}) => {
      calls.push({ url: String(url), cookies: (config.cookies ?? []).map(cookie => cookie.name + '=' + cookie.value) })
      const path = new URL(url).pathname
      const text = paths[path]
      if (text === undefined) throw new Error('unexpected URL ' + url)
      if (config.onCookies && path === '/news/page/1.html') {
        const next = mergeSetCookies(config.cookies ?? [], ['session=fresh; Path=/'], String(url))
        await config.onCookies(next, String(url))
        onChange?.(next)
      }
      return { url: String(url), headers: { 'content-type': 'text/html; charset=utf-8' }, text }
    },
  })
  return { engine, calls }
}

async function imported(overrides, engineOptions) {
  const { engine, calls } = fakeEngine(engineOptions)
  const { service, db } = await serviceFixture(engine)
  const result = await service.importSource({ text: JSON.stringify(rssSource(overrides)) })
  return { service, db, sourceId: result.sourceId, calls }
}

test('import stores a source cookie jar but state does not expose it', async () => {
  const { service, db, sourceId } = await imported()
  const stored = db.sources.get(sourceId)
  assert.deepEqual(stored.cookies.map(cookie => cookie.name + '=' + cookie.value), ['session=seed'])
  assert.equal(stored.headers.cookie, undefined)
  const view = (await service.state()).sources.find(source => source.id === sourceId)
  assert.equal(view.cookieCount, 1)
  assert.equal('cookies' in view, false)
})

test('subscription toc sends the jar and persists Set-Cookie for the next request', async () => {
  const { service, db, sourceId, calls } = await imported({}, {
    paths: { '/news/page/1.html': page([entry(1, '第一篇')]) },
  })
  const added = await service.addSubscriptions({ sourceId, categories: [SITE + '/news/page/{{page}}.html'] })
  let writes = 0
  const put = db.sources.put
  db.sources.put = async (...args) => { writes += 1; return put(...args) }
  await service.toc({ bookId: added.books[0].id })
  assert.deepEqual(calls[0].cookies, ['session=seed'])
  assert.deepEqual(db.sources.get(sourceId).cookies.map(cookie => cookie.value), ['fresh'])
  // 必须真的写回存储；只改内存对象的话重启后 Cookie 会丢。
  assert.equal(writes, 1)

  await service.toc({ bookId: added.books[0].id, refresh: true })
  assert.deepEqual(calls.at(-1).cookies, ['session=fresh'])
})

test('two sources keep separate cookie jars', async () => {
  const other = 'https://other-cookie.example'
  const { engine, calls } = fakeEngine({
    paths: {
      '/news/page/1.html': page([entry(1, '第一篇')]),
      '/other/page/1.html': page([entry(2, '第二篇')]),
    },
  })
  const { service } = await serviceFixture(engine)
  const first = await service.importSource({ text: JSON.stringify(rssSource()) })
  const second = await service.importSource({ text: JSON.stringify(rssSource({
    sourceName: '另一个订阅',
    sourceUrl: other + '#',
    sortUrl: '新闻::/other/page/{{page}}.html',
    header: JSON.stringify({ Cookie: 'other=two' }),
  })) })
  const firstBook = (await service.addSubscriptions({ sourceId: first.sourceId, categories: [SITE + '/news/page/{{page}}.html'] })).books[0]
  const secondBook = (await service.addSubscriptions({ sourceId: second.sourceId, categories: [other + '/other/page/{{page}}.html'] })).books[0]
  await service.toc({ bookId: firstBook.id })
  await service.toc({ bookId: secondBook.id })
  const byHost = Object.fromEntries(calls.map(call => [new URL(call.url).hostname, call.cookies]))
  assert.deepEqual(byHost['cookie.example'], ['session=seed'])
  assert.deepEqual(byHost['other-cookie.example'], ['other=two'])
})

test('service fetchSource carries cookies and writes Set-Cookie back', async () => {
  const requests = []
  const fetchRemote = async (url, options = {}) => {
    requests.push({ url: String(url), cookies: (options.cookies ?? []).map(cookie => cookie.name + '=' + cookie.value) })
    const next = mergeSetCookies(options.cookies ?? [], ['session=from-media; Path=/'], String(url))
    await options.onCookies?.(next, String(url))
    return { url, headers: { 'content-type': 'image/jpeg' }, buffer: Buffer.from('img') }
  }
  const { engine } = fakeEngine({ paths: { '/news/page/1.html': page([entry(1, '第一篇')]) } })
  const { service, db } = await serviceFixture(engine, { fetchRemote })
  const result = await service.importSource({ text: JSON.stringify(rssSource()) })
  await service.fetchSource(result.sourceId, 'https://cookie.example/cover.jpg')
  assert.deepEqual(requests[0].cookies, ['session=seed'])
  assert.deepEqual(db.sources.get(result.sourceId).cookies.map(cookie => cookie.value), ['from-media'])
})

test('backups omit cookie jars and restore starts without cookies', async () => {
  const { service, db } = await imported()
  const backup = await service.exportBackup()
  const text = JSON.stringify(backup)
  assert.equal(text.includes('session=seed'), false)
  assert.equal(text.includes('"cookies"'), false)
  await service.importBackup({ data: backup })
  const source = [...db.sources.entries()][0][1]
  assert.equal(source.cookies, undefined)
  const view = (await service.state()).sources.find(item => item.id === source.id)
  assert.equal(view.cookieCount, 0)
})

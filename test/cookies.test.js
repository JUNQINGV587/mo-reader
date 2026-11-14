import test from 'node:test'
import assert from 'node:assert/strict'
import { cookieHeader, cookiesFromHeader, mergeSetCookies, normalizeCookies } from '../lib/cookies.js'
import { fetchRemote } from '../lib/http.js'

test('cookieHeader only sends host-only cookies to the same host', () => {
  const cookies = [
    { name: 'sid', value: 'abc', domain: 'source.example', path: '/', secure: true, httpOnly: true, expires: null, createdAt: 1 },
    { name: 'other', value: 'nope', domain: 'other.example', path: '/', secure: false, httpOnly: false, expires: null, createdAt: 2 },
  ]
  assert.equal(cookieHeader(cookies, 'https://source.example/chapter/1'), 'sid=abc')
  assert.equal(cookieHeader(cookies, 'https://sub.source.example/chapter/1'), undefined)
  assert.equal(cookieHeader(cookies, 'http://source.example/chapter/1'), undefined)
})

test('cookieHeader respects path and expiry', () => {
  const now = Date.now()
  const cookies = [
    { name: 'root', value: '1', domain: 'source.example', path: '/', secure: false, httpOnly: false, expires: null, createdAt: 1 },
    { name: 'deep', value: '2', domain: 'source.example', path: '/chapter', secure: false, httpOnly: false, expires: null, createdAt: 2 },
    { name: 'gone', value: '3', domain: 'source.example', path: '/', secure: false, httpOnly: false, expires: now - 1000, createdAt: 3 },
  ]
  assert.equal(cookieHeader(cookies, 'https://source.example/chapter/1'), 'deep=2; root=1')
  assert.equal(cookieHeader(cookies, 'https://source.example/other'), 'root=1')
})

test('cookiesFromHeader normalizes a static Cookie header', () => {
  const cookies = cookiesFromHeader('a=1; b="two"; $Path=/x; bad name=3', 'https://source.example/books')
  assert.deepEqual(cookies.map(cookie => [cookie.name, cookie.value]), [['a', '1'], ['b', 'two']])
  assert.equal(cookies[0].domain, 'source.example')
  assert.equal(cookies[0].path, '/')
  assert.equal(cookies[0].secure, true)
})

test('mergeSetCookies stores, replaces and deletes cookies', () => {
  const url = 'https://source.example/books/1'
  let cookies = mergeSetCookies([], ['sid=one; Path=/; HttpOnly; Max-Age=3600'], url)
  assert.equal(cookies.length, 1)
  assert.equal(cookies[0].httpOnly, true)
  assert.ok(cookies[0].expires > Date.now())
  cookies = mergeSetCookies(cookies, ['sid=two; Path=/; Max-Age=3600'], url)
  assert.equal(cookies.length, 1)
  assert.equal(cookies[0].value, 'two')
  cookies = mergeSetCookies(cookies, ['sid=; Path=/; Max-Age=0'], url)
  assert.equal(cookies.length, 0)
})

test('Domain attributes are ignored and scoped paths stay host-only', () => {
  const url = 'https://www.source.example/books/1'
  const cookies = mergeSetCookies([], ['sid=x; Domain=.source.example; Path=/books'], url)
  assert.equal(cookies.length, 1)
  assert.equal(cookies[0].domain, 'www.source.example')
  assert.equal(cookies[0].path, '/books')
  assert.equal(cookieHeader(cookies, 'https://cdn.source.example/books/1'), undefined)
  assert.equal(cookieHeader(cookies, 'https://www.source.example/books/2'), 'sid=x')
  assert.equal(cookieHeader(cookies, 'https://www.source.example/other'), undefined)
})

test('normalizeCookies caps count and drops malformed or expired records', () => {
  const now = Date.now()
  const records = []
  for (let index = 0; index < 205; index += 1) records.push({ name: 'c' + index, value: String(index), domain: 'source.example', path: '/', createdAt: index })
  records.push({ name: 'bad name', value: 'x', domain: 'source.example', path: '/' })
  records.push({ name: 'old', value: 'x', domain: 'source.example', path: '/', expires: now - 1 })
  const cookies = normalizeCookies(records)
  assert.equal(cookies.length, 200)
  assert.equal(cookies[0].name, 'c5')
  assert.equal(cookies.at(-1).name, 'c204')
})

test('fetchRemote sends cookies, captures Set-Cookie and never leaks them off-origin', async () => {
  const requests = []
  let cookies = [{ name: 'seed', value: '1', domain: 'source.example', path: '/', secure: false, httpOnly: false, expires: null, createdAt: 1 }]
  const requestOnce = async (url, options) => {
    requests.push({ url: url.href, cookie: options.headers.cookie })
    if (url.pathname === '/start') {
      return { status: 302, headers: { location: 'https://cdn.example/final', 'set-cookie': ['sid=abc; Path=/; HttpOnly'] }, buffer: Buffer.alloc(0) }
    }
    return { status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': ['late=1; Path=/'] }, buffer: Buffer.from('ok') }
  }
  const result = await fetchRemote('https://source.example/start', {
    cookies,
    resolvePublic: async () => '93.184.216.34',
    requestOnce,
    onCookies: (next) => { cookies = next },
  })
  assert.equal(requests[0].cookie, 'seed=1')
  assert.equal(requests[1].cookie, undefined)
  assert.deepEqual(result.cookies.map(cookie => cookie.name + '=' + cookie.value), ['seed=1', 'sid=abc', 'late=1'])
  assert.equal(cookies.length, 3)
})

test('fetchRemote updates cookies from a non-redirect response', async () => {
  let cookies = []
  const result = await fetchRemote('https://source.example/books', {
    cookies,
    resolvePublic: async () => '93.184.216.34',
    requestOnce: async () => ({ status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'sid=xyz; Path=/; Secure' }, buffer: Buffer.from('ok') }),
    onCookies: (next) => { cookies = next },
  })
  assert.equal(result.text, 'ok')
  assert.equal(cookies[0].name, 'sid')
  assert.equal(cookieHeader(cookies, 'https://source.example/next'), 'sid=xyz')
})

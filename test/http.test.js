import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { fetchRemote } from '../lib/http.js'

test('fetchRemote enforces the allowed origin across redirects', async () => {
  const requests = []
  const requestOnce = async (url) => {
    requests.push(url.href)
    if (url.pathname === '/redirect-off-origin') return { status: 302, headers: { location: 'https://other.example/steal' }, buffer: Buffer.alloc(0) }
    if (url.pathname === '/redirect-same-origin') return { status: 302, headers: { location: '/final' }, buffer: Buffer.alloc(0) }
    return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, buffer: Buffer.from('ok') }
  }
  const options = { allowedOrigin: 'https://source.example', resolvePublic: async () => '93.184.216.34', requestOnce }
  const result = await fetchRemote('https://source.example/redirect-same-origin', options)
  assert.equal(result.text, 'ok')
  const before = requests.length
  await assert.rejects(fetchRemote('https://source.example/redirect-off-origin', options), /origin|not allowed/i)
  assert.equal(requests.length, before + 1)
})

test('fetchRemote decodes gzip responses and caps decompressed size', async () => {
  const payload = Buffer.from(JSON.stringify([{ bookSourceName: '压缩源', bookSourceUrl: 'https://source.example' }]))
  const compressed = zlib.gzipSync(payload)
  const requestOnce = async () => ({ status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, buffer: compressed })
  const options = { resolvePublic: async () => '93.184.216.34', requestOnce, maxBytes: 1024 }
  const result = await fetchRemote('https://source.example/library.json', options)
  assert.deepEqual(JSON.parse(result.text), [{ bookSourceName: '压缩源', bookSourceUrl: 'https://source.example' }])
  await assert.rejects(fetchRemote('https://source.example/library.json', { ...options, maxBytes: 10 }), /too-large|超过/)
})

test('a HEAD probe of a large media file is not rejected by its declared size', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(1024 * 1024 * 1024) })
    response.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const result = await fetchRemote('http://media.example:' + port + '/big.mp4', {
      method: 'HEAD',
      readBody: false,
      allowHttp: true,
      maxBytes: 1024,
      resolvePublic: async () => [{ address: '127.0.0.1', family: 4 }],
    })
    assert.equal(result.status, 200)
    assert.equal(result.buffer.length, 0)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('fetchRemote allows HEAD requests for media probes', async () => {
  let seen
  const requestOnce = async (_url, options) => {
    seen = options
    return { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, buffer: Buffer.alloc(0) }
  }
  const result = await fetchRemote('https://media.example/live.m3u8', {
    method: 'HEAD', headers: { Referer: 'https://source.example/watch' }, resolvePublic: async () => '93.184.216.34', requestOnce,
  })
  assert.equal(seen.method, 'HEAD')
  assert.equal(seen.headers.referer, 'https://source.example/watch')
  assert.equal(result.status, 200)
})

test('fetchRemote turns 401 and 403 into a readable login error', async () => {
  for (const status of [401, 403]) {
    const requestOnce = async () => ({ status, headers: { 'content-type': 'text/plain' }, buffer: Buffer.from('denied') })
    await assert.rejects(
      fetchRemote('https://media.example/protected.m3u8', { resolvePublic: async () => '93.184.216.34', requestOnce }),
      (error) => error.code === 'reader/auth-required' && /需要登录/.test(error.message),
    )
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
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

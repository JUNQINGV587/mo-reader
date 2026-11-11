import test from 'node:test'
import assert from 'node:assert/strict'
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

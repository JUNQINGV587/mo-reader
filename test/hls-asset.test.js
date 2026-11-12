import test from 'node:test'
import assert from 'node:assert/strict'
import { hlsAssetResponse } from '../lib/hls-asset.js'

test('hls player asset is served from the installed package', async () => {
  const response = await hlsAssetResponse(new Request('http://reader.local/api/reader/hls.js'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /javascript/)
  assert.ok(Number(response.headers.get('content-length')) > 100000)
  assert.match(await response.text(), /Hls/)
})

test('hls player asset supports HEAD and rejects writes', async () => {
  const head = await hlsAssetResponse(new Request('http://reader.local/api/reader/hls.js', { method: 'HEAD' }))
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  const post = await hlsAssetResponse(new Request('http://reader.local/api/reader/hls.js', { method: 'POST' }))
  assert.equal(post.status, 405)
})

import assert from 'node:assert/strict'
import test from 'node:test'

const { isTransportError, readableNetworkError, NETWORK_ERROR_TEXT } = await import('../dist/core/net-error.js')

test('传输层失败统一换成可读文案', () => {
  for (const raw of [
    'Failed to fetch',
    'TypeError: Failed to fetch',
    'client api: reader/getToc failed: Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Load failed',
    'fetch failed',
    'connect ECONNREFUSED 127.0.0.1:3080',
    'getaddrinfo ENOTFOUND book.eayue.com',
  ]) {
    assert.equal(readableNetworkError(raw), NETWORK_ERROR_TEXT, raw)
    assert.equal(isTransportError(raw), true, raw)
  }
})

test('服务端中文文案原样保留', () => {
  const message = '本章暂不可读：书源返回 403'
  assert.equal(readableNetworkError(message), message)
  assert.equal(isTransportError(message), false)
})

test('空文案回落到调用方给的兜底', () => {
  assert.equal(readableNetworkError(''), NETWORK_ERROR_TEXT)
  assert.equal(readableNetworkError('   ', '自定义兜底'), '自定义兜底')
})
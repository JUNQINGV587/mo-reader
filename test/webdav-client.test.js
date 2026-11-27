import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * WebDAV 请求层（#131）的单元测试：注入假 fetch，不联网。
 * 覆盖 PROPFIND 的方法/Depth/Basic 头、404 逐级 MKCOL、状态码与网络错误映射、密码脱敏。
 * 前置：npm run build:server（测试 import 的是 dist/core/webdav/*）。
 */

const { WebdavClient } = await import('../dist/core/webdav/client.js')
const { redactWebdavPassword } = await import('../dist/core/webdav/config.js')

const PUBLIC_URL = 'https://dav.example.com/remote.php/dav/files/me/books/'

/** 按顺序返回响应；给 Error 实例时抛它，模拟网络/证书/超时失败。 */
function seqFetch(steps) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]
    if (step instanceof Error) throw step
    return new Response(step.body ?? null, { status: step.status })
  }
  return { fetchImpl, calls }
}

function makeClient(steps, config = {}, options = {}) {
  const { fetchImpl, calls } = seqFetch(steps)
  const client = new WebdavClient(
    { url: PUBLIC_URL, username: 'me', password: 'p@ss word', allowPrivate: false, ...config },
    { fetchImpl, ...options },
  )
  return { client, calls }
}

function basicOf(call) {
  const header = call.init.headers?.Authorization ?? call.init.headers?.authorization ?? ''
  assert.match(header, /^Basic /)
  return Buffer.from(header.slice(6), 'base64').toString('utf8')
}

test('连通测试用 PROPFIND depth 0 打招呼，带 Basic 认证与目录地址', async () => {
  const { client, calls } = makeClient([{ status: 207 }])
  const result = await client.testConnection()
  assert.equal(result.ok, true)
  assert.equal(result.code, 'ok')
  assert.equal(result.status, 207)
  assert.equal(result.message, '连接成功')
  assert.equal(result.createdDirs, 0)
  assert.equal(typeof result.elapsedMs, 'number')
  assert.ok(result.elapsedMs >= 0)
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.init.method, 'PROPFIND')
  assert.equal(call.url, PUBLIC_URL)
  assert.equal(call.init.headers.Depth, '0')
  assert.match(String(call.init.headers['Content-Type']), /xml/)
  assert.match(String(call.init.body), /resourcetype/)
  assert.equal(basicOf(call), 'me:p@ss word')
  assert.ok(call.init.signal instanceof AbortSignal)
})

test('没有保留账号密码时不发认证头；地址缺结尾斜杠时自动补上', async () => {
  const { client, calls } = makeClient([{ status: 207 }], {
    url: 'https://dav.example.com/dav/books',
    username: '',
    password: '',
  })
  const result = await client.testConnection()
  assert.equal(result.ok, true)
  assert.equal(calls[0].url, 'https://dav.example.com/dav/books/')
  assert.equal('Authorization' in (calls[0].init.headers ?? {}), false)
})

test('目录 404 时从根逐级 MKCOL，已存在的目录（405）跳过并继续', async () => {
  const steps = [
    { status: 404 },
    { status: 201 },
    { status: 405 },
    { status: 201 },
    { status: 201 },
    { status: 201 },
    { status: 207 },
  ]
  const { client, calls } = makeClient(steps)
  const result = await client.testConnection()
  assert.equal(result.ok, true)
  assert.equal(result.code, 'ok')
  assert.equal(result.createdDirs, 4)
  assert.match(result.message, /已创建 4 个目录/)
  const mkcols = calls.filter((call) => call.init.method === 'MKCOL').map((call) => call.url)
  assert.deepEqual(mkcols, [
    'https://dav.example.com/remote.php/',
    'https://dav.example.com/remote.php/dav/',
    'https://dav.example.com/remote.php/dav/files/',
    'https://dav.example.com/remote.php/dav/files/me/',
    'https://dav.example.com/remote.php/dav/files/me/books/',
  ])
  // 建目录后再用 PROPFIND 确认一次，而不是把 MKCOL 的 201 当成功。
  assert.equal(calls.at(-1).init.method, 'PROPFIND')
})

test('401/403/5xx/其他状态都映射成可读文案，且不泄漏密码', async () => {
  const cases = [
    [{ status: 401 }, 'unauthorized', /账号或密码不正确/],
    [{ status: 403 }, 'forbidden', /没有权限/],
    [{ status: 500 }, 'server-error', /服务器出错（500）/],
    [{ status: 502 }, 'server-error', /服务器出错（502）/],
    [{ status: 418 }, 'http', /连接失败（HTTP 418）/],
  ]
  for (const [step, code, pattern] of cases) {
    const { client } = makeClient([step])
    const result = await client.testConnection()
    assert.equal(result.ok, false)
    assert.equal(result.code, code)
    assert.equal(result.status, step.status)
    assert.match(result.message, pattern)
    assert.equal(result.message.includes('p@ss word'), false)
  }
})

test('自动建目录失败：401 映射成账号问题，409 说明上级目录缺失', async () => {
  const { client } = makeClient([{ status: 404 }, { status: 401 }])
  const unauthorized = await client.testConnection()
  assert.equal(unauthorized.code, 'unauthorized')
  assert.match(unauthorized.message, /账号或密码不正确/)

  const { client: conflictClient } = makeClient([{ status: 404 }, { status: 409 }])
  const conflict = await conflictClient.testConnection()
  assert.equal(conflict.ok, false)
  assert.equal(conflict.status, 409)
  assert.match(conflict.message, /上级目录不存在/)
})

test('网络层失败映射：证书、超时、域名解析、断网各不相同，密码不出现在文案里', async () => {
  const cert = Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
  })
  const certResult = await makeClient([cert]).client.testConnection()
  assert.equal(certResult.code, 'certificate')
  assert.match(certResult.message, /证书不受信任/)
  assert.equal(certResult.status, null)

  const timeout = Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
  const timeoutResult = await makeClient([timeout]).client.testConnection()
  assert.equal(timeoutResult.code, 'timeout')
  assert.match(timeoutResult.message, /连接超时/)

  const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
  const dnsResult = await makeClient([dns]).client.testConnection()
  assert.equal(dnsResult.code, 'network')
  assert.match(dnsResult.message, /域名解析失败/)

  // 上游错误里就算带了密码，也不能原样透出：未知网络错误统一用固定文案，
  // 不动上游 message（少数已知错误也只会是固定文案），再叠一层脱敏兜底。
  const leaky = new Error('connect failed me:p@ss word')
  const leakyResult = await makeClient([leaky]).client.testConnection()
  assert.equal(leakyResult.code, 'network')
  assert.equal(leakyResult.message, '网络不通，连不上服务器')
  assert.equal(leakyResult.message.includes('p@ss word'), false)
})

test('地址非法时直接给出地址错误，不发请求', async () => {
  const { client, calls } = makeClient([{ status: 207 }], { url: 'ftp://dav.example.com/books' })
  const result = await client.testConnection()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-url')
  assert.match(result.message, /http 或 https/)
  assert.equal(calls.length, 0)
})

test('本机与私网地址默认拒绝；显式允许后照常发请求', async () => {
  for (const url of ['http://127.0.0.1:5005/dav/', 'http://localhost:5005/dav/', 'http://192.168.1.5/dav/']) {
    const { client, calls } = makeClient([{ status: 207 }], { url })
    const result = await client.testConnection()
    assert.equal(result.ok, false, url)
    assert.equal(result.code, 'private-blocked', url)
    assert.match(result.message, /允许私网/)
    assert.equal(calls.length, 0)
    const allowed = await makeClient([{ status: 207 }], { url, allowPrivate: true }).client.testConnection()
    assert.equal(allowed.ok, true, url)
  }
})

test('空地址按未配置处理；密码脱敏函数把密码全部替换成星号', async () => {
  const { client, calls } = makeClient([{ status: 207 }], { url: '' })
  const result = await client.testConnection()
  assert.equal(result.code, 'not-configured')
  assert.equal(calls.length, 0)
  assert.equal(redactWebdavPassword('a:p@ss word:b:p@ss word', 'p@ss word'), 'a:******:b:******')
  assert.equal(redactWebdavPassword('没有密码', ''), '没有密码')
})

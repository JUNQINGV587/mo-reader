import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * WebDAV 配置与连通（#131）的服务端测试：假数据表 + 假 fetch，不联网、不起端口。
 * 覆盖配置打码、空密码不改、清空、地址校验、私网策略与错误映射。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */

function fakeTable() {
  const map = new Map()
  return {
    map,
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

async function makeService(seed = {}) {
  const { ReaderService } = await import('../dist/server/service.js')
  let settingsValue = { ...seed }
  let writes = 0
  const db = {
    books: fakeTable(),
    chapters: fakeTable(),
    sources: fakeTable(),
    notes: fakeTable(),
    bookmarks: fakeTable(),
    readRecords: fakeTable(),
    jobs: fakeTable(),
    downloadEntries: fakeTable(),
    mediaEntries: fakeTable(),
    subscriptions: fakeTable(),
    settings: {
      get: () => settingsValue,
      set: async (next) => {
        settingsValue = next
        writes += 1
      },
    },
    readConfigs: fakeTable(),
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  return {
    service,
    getStored: () => settingsValue,
    writeCount: () => writes,
  }
}

/** 记录每次请求，按 status 序列返回响应；抛错用 throw 的 Error 模拟网络失败。 */
function fakeFetch(responses) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    if (next instanceof Error) throw next
    return new Response(next.body ?? null, { status: next.status })
  }
  return { fetchImpl, calls }
}

test('未配置时读取只返回打码信息，字段齐全且不含密码', async () => {
  const { service } = await makeService()
  const result = await service.getWebdavConfig()
  assert.equal(result.config.url, '')
  assert.equal(result.config.username, '')
  assert.equal(result.config.hasPassword, false)
  assert.equal(result.config.allowPrivate, false)
  assert.equal(result.configured, false)
  assert.equal('password' in result.config, false)
  assert.equal(JSON.stringify(result).includes('password'), false)
})

test('保存后跨读取保留：地址账号密码与允许私网都落设置表，读取打码', async () => {
  const { service, getStored } = await makeService()
  const saved = await service.saveWebdavConfig({
    url: ' https://dav.example.com/remote.php/dav/files/me/books/ ',
    username: 'me',
    password: 'p@ss word',
    allowPrivate: false,
  })
  assert.equal(saved.config.url, 'https://dav.example.com/remote.php/dav/files/me/books/')
  assert.equal(saved.config.username, 'me')
  assert.equal(saved.config.hasPassword, true)
  assert.equal(saved.config.allowPrivate, false)
  assert.equal('password' in saved.config, false)
  assert.equal(saved.warning, '')
  assert.equal(getStored().webdavPassword, 'p@ss word')
  // 密码原样保存：前后空格也是密码的一部分，不 trim。
  assert.equal(getStored().webdavUrl, 'https://dav.example.com/remote.php/dav/files/me/books/')
  const readBack = await service.getWebdavConfig()
  assert.equal(readBack.config.username, 'me')
  assert.equal(readBack.config.hasPassword, true)
  assert.equal(readBack.configured, true)
})

test('密码写空串表示不改，写非空才覆盖；账号可单独改', async () => {
  const { service, getStored } = await makeService()
  await service.saveWebdavConfig({ url: 'https://dav.example.com/books', username: 'me', password: 'old' })
  const kept = await service.saveWebdavConfig({ url: 'https://dav.example.com/books', username: 'me2', password: '' })
  assert.equal(kept.config.username, 'me2')
  assert.equal(kept.config.hasPassword, true)
  assert.equal(getStored().webdavPassword, 'old')
  await service.saveWebdavConfig({ url: 'https://dav.example.com/books', username: 'me2', password: 'new' })
  assert.equal(getStored().webdavPassword, 'new')
})

test('地址非法时拒绝保存且不动旧配置', async () => {
  const { service, getStored, writeCount } = await makeService({ webdavUrl: 'https://old.example.com/dav' })
  for (const url of ['', '   ', 'ftp://dav.example.com', 'dav.example.com/books', 'https://me:secret@dav.example.com/books']) {
    await assert.rejects(service.saveWebdavConfig({ url, username: 'me' }), /地址/, `应拒绝 ${JSON.stringify(url)}`)
  }
  assert.equal(getStored().webdavUrl, 'https://old.example.com/dav')
  assert.equal(writeCount(), 0)
})

test('清空配置一键抹掉地址、账号、密码与私网开关；之后测试按未配置处理', async () => {
  const { service, getStored } = await makeService({
    webdavUrl: 'https://dav.example.com/books',
    webdavUsername: 'me',
    webdavPassword: 'secret',
    webdavAllowPrivate: true,
  })
  const result = await service.saveWebdavConfig({ clear: true })
  assert.equal(result.cleared, true)
  assert.equal(result.config.url, '')
  assert.equal(result.config.hasPassword, false)
  assert.equal(result.config.allowPrivate, false)
  assert.equal(getStored().webdavPassword, '')
  assert.equal(getStored().webdavAllowPrivate, false)
  const testResult = await service.testWebdav()
  assert.equal(testResult.ok, false)
  assert.equal(testResult.code, 'not-configured')
})

test('内网字面量地址保存时给提示，测试默认拒绝且不发请求', async () => {
  const { service } = await makeService()
  const { fetchImpl, calls } = fakeFetch([{ status: 207 }])
  service.webdavFetch = fetchImpl
  const saved = await service.saveWebdavConfig({
    url: 'http://192.168.1.5:5005/books/',
    username: 'me',
    password: 'x',
  })
  assert.match(saved.warning, /内网/)
  const result = await service.testWebdav()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'private-blocked')
  assert.match(result.message, /允许私网/)
  assert.equal(calls.length, 0)
})

test('显式允许私网后不再拦截，请求照常发出', async () => {
  const { service } = await makeService({
    webdavUrl: 'http://192.168.1.5:5005/books/',
    webdavUsername: 'me',
    webdavPassword: 'x',
    webdavAllowPrivate: true,
  })
  const { fetchImpl, calls } = fakeFetch([{ status: 207 }])
  service.webdavFetch = fetchImpl
  const result = await service.testWebdav()
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
})

test('getSettings 及各设置写回路径都不泄漏 WebDAV 密码，saveSettings 也写不进它', async () => {
  const { service, getStored } = await makeService({
    theme: 'system',
    fontSize: 24,
    webdavUrl: 'https://dav.example.com/books',
    webdavUsername: 'me',
    webdavPassword: 'top-secret',
  })
  const read = await service.getSettings()
  assert.equal(JSON.stringify(read).includes('top-secret'), false)
  assert.equal('webdavPassword' in read.settings, false)
  assert.equal('webdavUrl' in read.settings, false)
  const saved = await service.saveSettings({
    settings: { fontSize: 26, webdavPassword: 'attacker', webdavUrl: 'https://evil.example.com' },
  })
  assert.equal(JSON.stringify(saved).includes('attacker'), false)
  assert.equal(getStored().webdavPassword, 'top-secret')
  assert.equal(getStored().webdavUrl, 'https://dav.example.com/books')
  const reset = await service.resetBookSettings({ bookId: 'b1' })
  assert.equal(JSON.stringify(reset).includes('top-secret'), false)
  const resetGroup = await service.resetSettingsGroup({ group: 'layout' })
  assert.equal(JSON.stringify(resetGroup).includes('top-secret'), false)
})
test('测试连通可用表单草稿：空密码沿用已存密码，草稿不写库', async () => {
  const { service, getStored, writeCount } = await makeService({
    webdavUrl: 'https://dav.example.com/books/',
    webdavUsername: 'old-user',
    webdavPassword: 'stored-secret',
  })
  const { fetchImpl, calls } = fakeFetch([{ status: 207 }])
  service.webdavFetch = fetchImpl
  const result = await service.testWebdav({
    url: 'https://dav.example.com/books/',
    username: 'new-user',
    password: '',
  })
  assert.equal(result.ok, true)
  const header = calls[0].init.headers.Authorization
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'new-user:stored-secret')
  // 只测试不保存：设置表一个字没动。
  assert.equal(writeCount(), 0)
  assert.equal(getStored().webdavUsername, 'old-user')
})

test('测试连通带草稿密码时用草稿，不用已存密码', async () => {
  const { service } = await makeService({
    webdavUrl: 'https://dav.example.com/books/',
    webdavUsername: 'me',
    webdavPassword: 'stored-secret',
  })
  const { fetchImpl, calls } = fakeFetch([{ status: 207 }])
  service.webdavFetch = fetchImpl
  await service.testWebdav({ url: 'https://dav.example.com/other/', password: 'draft-secret' })
  const header = calls[0].init.headers.Authorization
  assert.equal(Buffer.from(header.slice(6), 'base64').toString('utf8'), 'me:draft-secret')
  assert.equal(calls[0].url, 'https://dav.example.com/other/')
})

test('测试连通遇 401 给出可读文案，错误信息不含密码', async () => {
  const { service } = await makeService({
    webdavUrl: 'https://dav.example.com/books/',
    webdavUsername: 'me',
    webdavPassword: 'top-secret',
  })
  const { fetchImpl } = fakeFetch([{ status: 401 }])
  service.webdavFetch = fetchImpl
  const result = await service.testWebdav()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unauthorized')
  assert.equal(result.status, 401)
  assert.match(result.message, /账号或密码不正确/)
  assert.equal(result.message.includes('top-secret'), false)
  assert.equal(JSON.stringify(result).includes('top-secret'), false)
})

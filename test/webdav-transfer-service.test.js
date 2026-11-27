import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

const EXPORT_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-webdav-transfer-'))
process.env.MO_READER_EXPORT_ROOT = EXPORT_ROOT

const { ReaderService } = await import('../dist/server/service.js')

/**
 * WebDAV 上传与下载（#133）的服务端测试：假 fetch + 假数据表 + 临时导出目录，不联网、不起端口。
 * 覆盖 PUT/GET 的方法、地址与 Basic 头，覆盖确认，进度与取消，错误映射与密码脱敏，
 * 以及「取回后走与本地导入完全相同的预览与写库通路」。
 * 前置：npm run build:server（测试 import 的是 dist/server/*）。
 */

const DAV_DIR = 'https://dav.example.com/remote.php/dav/files/me/books/'
const DAV_USER = 'me'
const DAV_PASSWORD = 'p@ss word'

function fakeTable(records = []) {
  const map = new Map()
  for (const record of records) map.set(record.id, record)
  return {
    map,
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    put: async (key, value) => {
      map.set(key, value)
    },
    delete: async (key) => map.delete(key),
  }
}

function seedBooks() {
  return [
    { id: 'book-a', name: '备份的书', author: '甲', bookUrl: 'https://example.com/a', origin: 'https://example.com' },
  ]
}

async function makeService(overrides = {}) {
  const db = {
    books: fakeTable(overrides.books ?? seedBooks()),
    chapters: fakeTable(),
    sources: fakeTable(),
    groups: fakeTable(),
    dictRules: fakeTable(),
    notes: fakeTable(),
    bookmarks: fakeTable(),
    readRecords: fakeTable(),
    readConfigs: fakeTable(),
    subscriptions: fakeTable(),
    jobs: fakeTable(),
    downloadEntries: fakeTable(),
    mediaEntries: fakeTable(),
    settings: {
      get: () => ({
        theme: 'light',
        webdavUrl: DAV_DIR,
        webdavUsername: DAV_USER,
        webdavPassword: DAV_PASSWORD,
        webdavAllowPrivate: true,
        ...(overrides.settings ?? {}),
      }),
      set: async () => undefined,
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  return { service, db }
}

/**
 * 极简 WebDAV 假服务器：按方法分派，记录每次调用的方法/地址/头；PUT 把请求体读成 Buffer。
 * 覆盖某一步就传 overrides.<method>，抛错或返回自定义 Response 都行。
 */
function webdavServer(overrides = {}) {
  const calls = []
  const uploads = []
  const fn = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = init.headers ?? {}
    const call = { url: String(url), method, headers, init }
    calls.push(call)
    if (overrides[method.toLowerCase()]) {
      const handled = await overrides[method.toLowerCase()](call, calls.length - 1)
      if (handled !== undefined) return handled
    }
    if (method === 'PROPFIND') return new Response(null, { status: 207 })
    if (method === 'HEAD') return new Response(null, { status: overrides.headStatus ?? 404 })
    if (method === 'MKCOL') return new Response(null, { status: 201 })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    if (method === 'PUT') {
      const chunks = []
      for await (const chunk of init.body) chunks.push(Buffer.from(chunk))
      uploads.push(Buffer.concat(chunks))
      return new Response(null, { status: 201 })
    }
    if (method === 'GET') return new Response(null, { status: 404 })
    throw new Error(`unexpected ${method} ${url}`)
  }
  return { fn, calls, uploads }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitUntil(predicate, label, timeoutMs = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await sleep(10)
  }
  throw new Error(`等待超时：${label}`)
}

async function readBackupZip(service, backupJobId) {
  const { job } = await service.getBackupJob({ jobId: backupJobId })
  return { job, bytes: await readFile(join(EXPORT_ROOT, job.filePath)) }
}

test.after(async () => {
  await rm(EXPORT_ROOT, { recursive: true, force: true })
})

test('上传：PUT 当前备份到目录下的同名文件，带 Basic 头与 Content-Length，内容与导出逐字节一致', async () => {
  const server = webdavServer()
  const { service } = await makeService()
  service.webdavFetch = server.fn
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const backup = await readBackupZip(service, started.job.id)

  const transfer = await service.uploadBackupToWebdav({ backupJobId: backup.job.id })
  await service.waitForWebdavTransfers()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })

  assert.equal(job.status, 'done')
  assert.equal(job.direction, 'upload')
  assert.equal(job.stage, 'done')
  assert.equal(job.fileName, backup.job.fileName)
  assert.equal(job.bytes, backup.job.bytes)
  assert.equal(job.completed, backup.job.bytes)
  assert.equal(job.error, '')
  assert.deepEqual(server.calls.map((call) => call.method), ['PROPFIND', 'HEAD', 'PUT'])
  const put = server.calls.at(-1)
  assert.equal(put.url, `${DAV_DIR}${encodeURIComponent(backup.job.fileName)}`)
  assert.equal(put.headers.Authorization, `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASSWORD}`).toString('base64')}`)
  assert.equal(put.headers['Content-Type'], 'application/zip')
  assert.equal(put.headers['Content-Length'], String(backup.job.bytes))
  assert.deepEqual(server.uploads[0], backup.bytes)
})

test('覆盖确认：远端已有同名文件时先暂停，确认后才 PUT，且只写目标文件', async () => {
  const server = webdavServer({ headStatus: 200 })
  const { service } = await makeService()
  service.webdavFetch = server.fn
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const backup = await readBackupZip(service, started.job.id)

  const transfer = await service.uploadBackupToWebdav({ backupJobId: backup.job.id })
  await service.waitForWebdavTransfers()
  const paused = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(paused.job.status, 'paused')
  assert.equal(paused.job.stage, 'confirm')
  assert.equal(paused.job.remoteExists, true)
  assert.equal(server.calls.some((call) => call.method === 'PUT'), false)

  await service.uploadBackupToWebdav({ id: transfer.job.id })
  await service.waitForWebdavTransfers()
  const done = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(done.job.status, 'done')
  assert.equal(done.job.overwrite, true)
  assert.equal(server.calls.filter((call) => call.method === 'PUT').length, 1)
  assert.deepEqual(server.calls.map((call) => call.method), ['PROPFIND', 'HEAD', 'PROPFIND', 'PUT'])
})

test('错误映射：401、证书、超时、域名解析失败都给出可读原因，且不含密码', async () => {
  const cases = [
    {
      label: '401',
      overrides: { propfind: () => new Response(null, { status: 401 }) },
      pattern: /账号或密码不正确（401）/,
    },
    {
      label: '证书',
      overrides: {
        propfind: () => {
          throw Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
        },
      },
      pattern: /证书不受信任/,
    },
    {
      label: '超时',
      overrides: {
        propfind: () => {
          throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
        },
      },
      pattern: /连接超时/,
    },
    {
      label: '域名解析失败',
      overrides: {
        propfind: () => {
          throw Object.assign(new Error('getaddrinfo ENOTFOUND dav.example.com'), { code: 'ENOTFOUND' })
        },
      },
      pattern: /域名解析失败/,
    },
  ]
  for (const item of cases) {
    const server = webdavServer(item.overrides)
    const { service } = await makeService()
    service.webdavFetch = server.fn
    const started = await service.startBackup({ light: true })
    await service.waitForBackups()
    const transfer = await service.uploadBackupToWebdav({ backupJobId: started.job.id })
    await service.waitForWebdavTransfers()
    const { job } = await service.getBackupJob({ jobId: transfer.job.id })
    assert.equal(job.status, 'failed', item.label)
    assert.match(job.error, item.pattern, item.label)
    assert.equal(job.stageText, '上传失败', item.label)
    assert.equal(JSON.stringify(job).includes(DAV_PASSWORD), false, item.label)
  }
})

test('取消上传：PUT 中途取消记为已取消，不报错也不留作业在跑', async () => {
  const pending = []
  const server = webdavServer({
    put: ({ init }) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject, signal: init.signal })
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }),
  })
  const { service } = await makeService()
  service.webdavFetch = server.fn
  const started = await service.startBackup({ light: true })
  await service.waitForBackups()
  const transfer = await service.uploadBackupToWebdav({ backupJobId: started.job.id })
  await waitUntil(() => server.calls.some((call) => call.method === 'PUT'), 'PUT 开始')
  await service.cancelBackupJob({ id: transfer.job.id })
  await service.waitForWebdavTransfers()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(job.status, 'cancelled')
  assert.equal(job.error, '')
  assert.equal(job.stageText, '已取消')
  assert.equal(pending.length, 1)
  assert.equal(pending[0].signal.aborted, true)
})

test('下载：GET 取回备份后先走导入预览，确认前不写库，确认后恢复数据并清掉临时目录', async () => {
  const { service, db } = await makeService()
  const backupStart = await service.startBackup({ light: true })
  await service.waitForBackups()
  const backup = await readBackupZip(service, backupStart.job.id)

  const server = webdavServer({
    get: () =>
      new Response(backup.bytes, {
        status: 200,
        headers: { 'content-length': String(backup.bytes.length), 'content-type': 'application/zip' },
      }),
  })
  service.webdavFetch = server.fn
  db.books.delete('book-a')
  assert.equal(db.books.get('book-a'), undefined)

  const transfer = await service.downloadBackupFromWebdav({ fileName: backup.job.fileName })
  await service.waitForWebdavTransfers()
  await service.waitForBackupImports()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(job.status, 'done')
  assert.equal(job.direction, 'download')
  assert.ok(job.importJobId)
  assert.equal(server.calls.filter((call) => call.method === 'GET').length, 1)
  assert.equal(server.calls.at(-1).url, `${DAV_DIR}${encodeURIComponent(backup.job.fileName)}`)
  const entries = await readdir(EXPORT_ROOT)
  assert.equal(entries.includes(`${job.id}.webdav.parts`), false)

  const previewed = await service.getBackupJob({ jobId: job.importJobId })
  assert.equal(previewed.job.status, 'paused')
  assert.equal(previewed.job.stage, 'preview')
  assert.ok(previewed.job.preview.books.total >= 1)
  assert.equal(db.books.get('book-a'), undefined)

  await service.applyBackupImport({ jobId: job.importJobId })
  assert.equal(db.books.get('book-a')?.name, '备份的书')
})

test('下载 404：远端没有这个备份文件时给出明确原因', async () => {
  const server = webdavServer()
  const { service } = await makeService()
  service.webdavFetch = server.fn
  const transfer = await service.downloadBackupFromWebdav({ fileName: 'backup.zip' })
  await service.waitForWebdavTransfers()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(job.status, 'failed')
  assert.equal(job.error, '远端没有这个备份文件（404）')
  assert.equal(job.stageText, '取回失败')
})

test('取消下载：GET 中途取消记为已取消，临时目录不残留', async () => {
  const server = webdavServer({
    get: ({ init }) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      }),
  })
  const { service } = await makeService()
  service.webdavFetch = server.fn
  const transfer = await service.downloadBackupFromWebdav({ fileName: 'backup.zip' })
  await waitUntil(() => server.calls.some((call) => call.method === 'GET'), 'GET 开始')
  await service.cancelBackupJob({ id: transfer.job.id })
  await service.waitForWebdavTransfers()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(job.status, 'cancelled')
  assert.equal(job.error, '')
  const entries = await readdir(EXPORT_ROOT)
  assert.equal(entries.includes(`${job.id}.webdav.parts`), false)
})

test('下载的备份来自更新版本时，导入预览按 #132 的规则拒绝', async () => {
  const { service } = await makeService()
  const backupStart = await service.startBackup({ light: true })
  await service.waitForBackups()
  const backup = await readBackupZip(service, backupStart.job.id)
  const zip = await JSZip.loadAsync(backup.bytes)
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'))
  zip.file('manifest.json', JSON.stringify({ ...manifest, version: 999 }))
  const newer = await zip.generateAsync({ type: 'nodebuffer' })

  const server = webdavServer({
    get: () => new Response(newer, { status: 200, headers: { 'content-length': String(newer.length) } }),
  })
  service.webdavFetch = server.fn
  const transfer = await service.downloadBackupFromWebdav({ fileName: backup.job.fileName })
  await service.waitForWebdavTransfers()
  const { job } = await service.getBackupJob({ jobId: transfer.job.id })
  assert.equal(job.status, 'done')
  await service.waitForBackupImports()
  const previewed = await service.getBackupJob({ jobId: job.importJobId })
  assert.equal(previewed.job.status, 'failed')
  assert.match(previewed.job.error, /备份来自更新版本的墨读，请先升级/)
})

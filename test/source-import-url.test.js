import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

// 成功抓取用本机 http 服务；guard 只有在显式放行时才允许私网字面量。
process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

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
    deleteMany: async (keys) => {
      let count = 0
      for (const key of keys) if (map.delete(key)) count += 1
      return count
    },
  }
}

async function makeService() {
  const { ReaderService } = await import('../dist/server/service.js')
  const sources = fakeTable()
  const books = fakeTable()
  const readRecords = fakeTable()
  const notes = fakeTable()
  const bookmarks = fakeTable()
  let settingsValue = { theme: 'system', fontSize: 24, lineSpacing: 0.5 }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = { sources, books, readRecords, notes, bookmarks, settings }
  return { service, map: sources.map }
}

const A = { bookSourceUrl: 'https://a.example.com', bookSourceName: '甲源' }
const B = { bookSourceUrl: 'https://b.example.com', bookSourceName: '乙源' }

/** 起一个只在 127.0.0.1 监听的临时服务，结束后强制断开残留连接（超时用例会留着挂起请求）。 */
async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

test('远程书源：跟随重定向、兼容 bookSources 包装、按地址去重计数', async () => {
  const { service, map } = await makeService()
  await withServer(
    (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/sources.json' })
        res.end()
        return
      }
      if (req.url === '/wrapped') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ bookSources: [B] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([A, B]))
    },
    async (origin) => {
      const first = await service.importSources({ payload: `${origin}/redirect` })
      assert.equal(first.total, 2)
      assert.equal(first.added, 2)
      assert.equal(first.updated, 0)
      assert.equal(map.size, 2)

      const again = await service.importSources({ payload: `${origin}/sources.json` })
      assert.equal(again.added, 0)
      assert.equal(again.updated, 2)
      assert.equal(map.size, 2)

      const wrapped = await service.importSources({ payload: `${origin}/wrapped` })
      assert.equal(wrapped.total, 1)
      assert.equal(wrapped.added, 0)
      assert.equal(wrapped.updated, 1)
    },
  )
})

test('远程书源：404 给可读提示，不写库、不影响已有书源', async () => {
  const { service, map } = await makeService()
  await service.importSources({ payload: JSON.stringify([A]) })
  await withServer(
    (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    },
    async (origin) => {
      await assert.rejects(
        () => service.importSources({ payload: `${origin}/missing.json` }),
        /下载书源失败：HTTP 404/,
      )
    },
  )
  assert.equal(map.size, 1)
  assert.equal(map.get([...map.keys()][0]).bookSourceName, '甲源')
})

test('远程书源：返回非 JSON 时报错且不写库', async () => {
  const { service, map } = await makeService()
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body>书源列表</body></html>')
    },
    async (origin) => {
      await assert.rejects(
        () => service.importSources({ payload: `${origin}/sources.html` }),
        /下载的内容不是合法的 JSON/,
      )
    },
  )
  assert.equal(map.size, 0)
})

test('远程书源：慢响应按超时处理，给可读提示且不写库', async () => {
  const { service, map } = await makeService()
  await withServer(
    () => {
      // 故意不响应：客户端应自行超时。
    },
    async (origin) => {
      const started = Date.now()
      await assert.rejects(
        () => service.importSources({ payload: `${origin}/slow.json`, timeoutMs: 300 }),
        /下载书源超时/,
      )
      assert.ok(Date.now() - started < 5000)
    },
  )
  assert.equal(map.size, 0)
})

test('远程书源：超过 5 MB 响应体上限时报错且不写库', async () => {
  const { service, map } = await makeService()
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)
  await withServer(
    (req, res) => {
      res.on('error', () => {})
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(oversized)
    },
    async (origin) => {
      await assert.rejects(
        () => service.importSources({ payload: `${origin}/big.json` }),
        /书源文件超过 5 MB/,
      )
    },
  )
  assert.equal(map.size, 0)
})

test('远程书源：私网地址默认拒绝并明确提示，请求不会发出', async () => {
  delete process.env.MO_READER_INSECURE_ALLOW_PRIVATE
  try {
    const { service, map } = await makeService()
    let hits = 0
    await withServer(
      (req, res) => {
        hits += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([A]))
      },
      async (origin) => {
        await assert.rejects(
          () => service.importSources({ payload: `${origin}/sources.json` }),
          /禁止访问本机\/内网地址/,
        )
      },
    )
    assert.equal(hits, 0)
    assert.equal(map.size, 0)
  } finally {
    process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'
  }
})

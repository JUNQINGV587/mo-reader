import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

/** 固定字宽 + 可调边距的命中测试布局（真实阅读器由 canvas.measureText 提供宽度）。 */
function layout(overrides = {}) {
  return {
    left: 0,
    top: 0,
    lineHeight: 30,
    measure: (text) => text.length * 10,
    ...overrides,
  }
}

test('命中：按 y 落行、按 x 落字符，并扩展成 CJK 词', async () => {
  const { hitTest } = await import('../dist/core/reader/hit-test.js')
  const lines = ['第一行的内容，测试', '第二行的内容，测试', '第三行的内容，测试']
  const hit = hitTest(lines, { x: 25, y: 45 }, layout())
  assert.ok(hit)
  assert.equal(hit.lineIndex, 1)
  assert.equal(hit.line, lines[1])
  assert.equal(hit.charIndex, 2)
  assert.equal(hit.word, '第二行的内容')
  assert.equal(hit.start, 0)
  assert.equal(hit.end, 6)
  assert.equal(hit.fallback, false)
})

test('命中：CJK 词在标点处停下', async () => {
  const { wordAt } = await import('../dist/core/reader/hit-test.js')
  assert.deepEqual(wordAt('　　春天来了，我们出发', 2), {
    word: '春天来了',
    start: 2,
    end: 6,
    fallback: false,
  })
  // 指针落在标点上时取相邻的词，而不是整行
  assert.equal(wordAt('春天来了，我们出发', 4).word, '春天来了')
})

test('命中：拉丁词保留内部撇号和连字符', async () => {
  const { wordAt } = await import('../dist/core/reader/hit-test.js')
  assert.equal(wordAt("Don't stop, hello-world 42", 2).word, "Don't")
  assert.equal(wordAt("Don't stop, hello-world 42", 13).word, 'hello-world')
  assert.equal(wordAt("Don't stop, hello-world 42", 25).word, '42')
})

test('命中：缩进按实际描画位置换算', async () => {
  const { hitTest } = await import('../dist/core/reader/hit-test.js')
  const line = '　　春天来了'
  // left=20、缩进两字共 20px；x=45 → 正文第一个字
  const hit = hitTest([line], { x: 45, y: 5 }, layout({ left: 20 }))
  assert.ok(hit)
  assert.equal(hit.charIndex, 2)
  assert.equal(hit.word, '春天来了')
  assert.equal(hit.start, 2)
  // 指针落在缩进上时跳过缩进，仍能拿到后面的词
  const indentHit = hitTest([line], { x: 25, y: 5 }, layout({ left: 20 }))
  assert.equal(indentHit.word, '春天来了')
  assert.equal(indentHit.start, 2)
})

test('命中：超出正文范围、空行、空页时按文档规则回退', async () => {
  const { hitTest } = await import('../dist/core/reader/hit-test.js')
  const lines = ['　　春天来了', '　　夏天走了']

  // x 超出整行宽度 → 回退整行文本（去掉缩进）
  const far = hitTest(lines, { x: 500, y: 0 }, layout({ left: 20 }))
  assert.equal(far.lineIndex, 0)
  assert.equal(far.fallback, true)
  assert.equal(far.word, '春天来了')
  assert.equal(far.start, 2)

  // y 落在最后一行下方 → 夹到最后一行
  const below = hitTest(lines, { x: 55, y: 999 }, layout({ left: 20 }))
  assert.equal(below.lineIndex, 1)
  assert.equal(below.word, '夏天走了')

  // 指针落在段间空行 → 取最近的非空行
  const gap = hitTest(['　　春天来了', '', '　　夏天走了'], { x: 25, y: 35 }, layout({ left: 20 }))
  assert.equal(gap.lineIndex, 0)

  // 整页都是空行 / 没有行 → 返回 null
  assert.equal(hitTest([], { x: 0, y: 0 }, layout()), null)
  assert.equal(hitTest(['', '  '], { x: 0, y: 0 }, layout()), null)
})

test('lookupAll：结果顺序与规则顺序一致，且空列表不发查询', async () => {
  const { lookupAll } = await import('../dist/core/dict/lookup-all.js')
  let calls = 0
  assert.deepEqual(
    await lookupAll([], '词', async () => {
      calls += 1
      return { name: '不会调用', text: 'x' }
    }),
    [],
  )
  assert.equal(calls, 0)

  const rules = [
    { id: 'slow', name: '慢字典' },
    { id: 'fast', name: '快字典' },
  ]
  const results = await lookupAll(rules, '词', async (ruleId) => {
    if (ruleId === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { name: '慢字典', text: '慢释义', url: 'https://slow.example/x' }
    }
    return { name: '快字典', text: '快释义', url: 'https://fast.example/y' }
  })
  assert.deepEqual(results.map((item) => item.id), ['slow', 'fast'])
  assert.deepEqual(results.map((item) => item.ok), [true, true])
  assert.equal(results[0].name, '慢字典')
  assert.equal(results[0].text, '慢释义')
  assert.equal(results[1].url, 'https://fast.example/y')
})

test('lookupAll：一本字典失败只落在自己的结果里，禁用的不查', async () => {
  const { lookupAll } = await import('../dist/core/dict/lookup-all.js')
  const rules = [
    { id: 'a', name: '甲', enabled: true },
    { id: 'b', name: '乙', enabled: true },
    { id: 'c', name: '丙', enabled: true },
    { id: 'off', name: '停用', enabled: false },
  ]
  const calls = []
  const results = await lookupAll(rules, '词', async (ruleId) => {
    calls.push(ruleId)
    if (ruleId === 'b') throw new Error('词典坏了')
    return { name: `${ruleId} 字典`, text: `${ruleId} 释义`, url: `https://${ruleId}.example/` }
  })
  assert.deepEqual(calls, ['a', 'b', 'c'])
  assert.deepEqual(results.map((item) => item.id), ['a', 'b', 'c'])
  assert.equal(results[0].ok, true)
  assert.equal(results[0].name, 'a 字典')
  assert.equal(results[1].ok, false)
  assert.equal(results[1].name, '乙')
  assert.match(results[1].error, /词典坏了/)
  assert.equal(results[1].text, undefined)
  assert.equal(results[2].ok, true)
  assert.equal(results[2].text, 'c 释义')
})

function fakeTable() {
  const map = new Map()
  return {
    get: (key) => map.get(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    size: () => map.size,
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
  const service = Object.create(ReaderService.prototype)
  service.db = { dictRules: fakeTable(), sources: fakeTable() }
  return service
}

test('lookupAll：服务层并发查询两本字典，一本坏不影响另一本', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<div class="meaning">春天：四季之一</div>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`

  const dead = http.createServer((_request, response) => response.end('x'))
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  const service = await makeService()
  await service.saveDictRule({
    rule: {
      name: '好字典',
      url: `${origin}/dict?word={{key}}`,
      rule: 'class.meaning@text',
    },
  })
  await service.saveDictRule({
    rule: {
      name: '坏字典',
      url: `http://127.0.0.1:${deadPort}/?word={{key}}`,
      rule: 'class.meaning@text',
    },
  })

  const { rules } = await service.listDictRules()
  const { lookupAll } = await import('../dist/core/dict/lookup-all.js')
  const results = await lookupAll(rules, '春', (ruleId, key) => service.lookupDict({ ruleId, key }))

  assert.equal(results.length, 2)
  assert.equal(results[0].ok, true)
  assert.equal(results[0].name, '好字典')
  assert.equal(results[0].text, '春天：四季之一')
  assert.match(results[0].url, /\/dict\?word=/)
  assert.equal(results[1].ok, false)
  assert.equal(results[1].name, '坏字典')
  assert.equal(typeof results[1].error, 'string')
  assert.ok(results[1].error.length > 0)
})

import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

process.env.MO_READER_INSECURE_ALLOW_PRIVATE = '1'

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

function dictRule(overrides = {}) {
  return {
    name: '测试字典',
    url: 'https://dict.example/word/{{key}}',
    rule: 'class.meaning@text',
    ...overrides,
  }
}

test('字典规则：新增、更新保持稳定 id，未知字段原样保留', async () => {
  const service = await makeService()
  const first = await service.saveDictRule({
    rule: dictRule({ group: '汉语', comment: '保留我' }),
  })
  assert.match(first.rule.id, /^dict-/)
  assert.equal(first.rule.enabled, true)
  assert.equal(first.rule.group, '汉语')
  assert.equal(first.rule.comment, '保留我')

  const second = await service.saveDictRule({
    rule: dictRule({ rule: 'class.other@text', comment: '保留我' }),
  })
  assert.equal(second.rule.id, first.rule.id)

  const { rules } = await service.listDictRules()
  assert.equal(rules.length, 1)
  assert.equal(rules[0].rule, 'class.other@text')
  assert.equal(rules[0].comment, '保留我')
})

test('字典规则：列表按 customOrder 排序', async () => {
  const service = await makeService()
  await service.saveDictRule({ rule: dictRule({ name: '乙', customOrder: 2 }) })
  await service.saveDictRule({ rule: dictRule({ name: '甲', customOrder: 1 }) })
  const { rules } = await service.listDictRules()
  assert.deepEqual(
    rules.map((item) => item.name),
    ['甲', '乙'],
  )
})

test('字典规则：URL 必须含 {{key}}，规则不能为空', async () => {
  const service = await makeService()
  await assert.rejects(
    service.saveDictRule({ rule: dictRule({ url: 'https://dict.example/word/' }) }),
    /\{\{key\}\}/,
  )
  await assert.rejects(service.saveDictRule({ rule: dictRule({ url: '' }) }), /地址/)
  await assert.rejects(service.saveDictRule({ rule: dictRule({ rule: '   ' }) }), /规则/)
  await assert.rejects(
    service.saveDictRule({ rule: { name: '缺规则', url: 'https://dict.example/{{key}}' } }),
    /规则/,
  )
  await assert.rejects(service.saveDictRule({}), /rule|字典/)
})

test('字典规则：按 id 删除，空 ids 拒绝', async () => {
  const service = await makeService()
  const saved = await service.saveDictRule({ rule: dictRule({ name: '临时字典' }) })
  const { deleted } = await service.deleteDictRules({ ids: [saved.rule.id, 'missing'] })
  assert.equal(deleted, 1)
  assert.equal((await service.listDictRules()).rules.length, 0)
  await assert.rejects(service.deleteDictRules({ ids: [] }), /ids/)
})

test('字典规则：导入数组时单条非法返回错误但不中断', async () => {
  const service = await makeService()
  const result = await service.importDictRules({
    payload: JSON.stringify([
      dictRule({ name: '甲' }),
      dictRule({ name: '乙', rule: '' }),
      dictRule({ name: '丙', url: 'https://dict.example/no-placeholder' }),
    ]),
  })
  assert.equal(result.total, 3)
  assert.equal(result.added, 1)
  assert.equal(result.errors.length, 2)
  assert.match(result.errors[0].message, /规则/)

  const { rules } = await service.listDictRules()
  assert.equal(rules.length, 1)
  assert.equal(rules[0].name, '甲')
})

test('字典规则：支持 {dictRules} 包装并拒绝非法顶层结构', async () => {
  const service = await makeService()
  const result = await service.importDictRules({
    payload: JSON.stringify({ dictRules: [dictRule({ name: '甲' }), dictRule({ name: '乙' })] }),
  })
  assert.equal(result.added, 2)
  assert.equal(result.errors.length, 0)

  await assert.rejects(
    service.importDictRules({ payload: JSON.stringify({ foo: [] }) }),
    /字典数据|格式/,
  )
  await assert.rejects(service.importDictRules({ payload: '{bad json' }), /JSON/)
})

test('字典规则：导出 Legado 兼容数组并可再次导入（不重复）', async () => {
  const service = await makeService()
  await service.saveDictRule({ rule: dictRule({ name: '甲', comment: '备注' }) })
  await service.saveDictRule({ rule: dictRule({ name: '乙', enabled: false, group: '汉语' }) })

  const exported = await service.exportDictRules()
  assert.ok(Array.isArray(exported))
  assert.equal(exported.length, 2)
  for (const item of exported) {
    assert.equal(item.id, undefined)
    assert.ok(item.url.includes('{{key}}'))
    assert.equal(typeof item.enabled, 'boolean')
  }
  assert.ok(exported.some((item) => item.comment === '备注'))

  const again = await service.importDictRules({ payload: JSON.stringify(exported) })
  assert.equal(again.added, 0)
  assert.equal(again.updated, 2)
  assert.equal((await service.listDictRules()).rules.length, 2)
})

test('字典查询：替换 {{key}}、透传 header、按规则提取纯文本', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push({
      path: url.pathname,
      words: url.searchParams.getAll('word'),
      header: request.headers['x-dict-token'],
    })
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<div class="meaning"><p>你好</p><p>这里是释义</p></div>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`

  const service = await makeService()
  const saved = await service.saveDictRule({
    rule: {
      name: '本地词典',
      url: `${origin}/dict?word={{key}}&word={{key}}`,
      rule: 'class.meaning@html',
      header: JSON.stringify({ 'X-Dict-Token': 'secret' }),
    },
  })

  const result = await service.lookupDict({ ruleId: saved.rule.id, key: '你好' })
  assert.equal(result.name, '本地词典')
  assert.equal(result.text, '你好\n这里是释义')
  assert.equal(result.url, `${origin}/dict?word=%E4%BD%A0%E5%A5%BD&word=%E4%BD%A0%E5%A5%BD`)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, '/dict')
  assert.deepEqual(requests[0].words, ['你好', '你好'])
  assert.equal(requests[0].header, 'secret')
})

test('字典查询：非法规则 id、缺少查询词、未启用字典都报错', async () => {
  const service = await makeService()
  const saved = await service.saveDictRule({ rule: dictRule() })
  await assert.rejects(
    service.lookupDict({ ruleId: 'missing', key: 'x' }),
    /字典不存在/,
  )
  await assert.rejects(service.lookupDict({ ruleId: saved.rule.id }), /缺少参数 key/)

  await service.saveDictRule({ rule: { ...saved.rule, enabled: false } })
  await assert.rejects(
    service.lookupDict({ ruleId: saved.rule.id, key: 'x' }),
    /未启用/,
  )
})

test('字典查询：非 http(s) 地址被 SSRF 守卫拒绝', async () => {
  const service = await makeService()
  const saved = await service.saveDictRule({
    rule: dictRule({ url: 'ftp://dict.example/{{key}}' }),
  })
  await assert.rejects(
    service.lookupDict({ ruleId: saved.rule.id, key: 'x' }),
    /http/,
  )
})

test('字典查询：单本失败不影响其他字典（UI 并发契约）', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<div class="meaning">在线释义</div>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`

  const dead = http.createServer((_request, response) => response.end('x'))
  await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve))
  const deadPort = dead.address().port
  await new Promise((resolve) => dead.close(resolve))

  const service = await makeService()
  const good = await service.saveDictRule({
    rule: dictRule({ name: '好字典', url: `${origin}/dict?word={{key}}` }),
  })
  const bad = await service.saveDictRule({
    rule: dictRule({
      name: '坏字典',
      url: `http://127.0.0.1:${deadPort}/?q={{key}}`,
    }),
  })

  const settled = await Promise.allSettled([
    service.lookupDict({ ruleId: good.rule.id, key: '词' }),
    service.lookupDict({ ruleId: bad.rule.id, key: '词' }),
  ])
  assert.equal(settled[0].status, 'fulfilled')
  assert.equal(settled[1].status, 'rejected')
  assert.equal(settled[0].value.text, '在线释义')
})

test('字典排序：交换实际 customOrder，稀疏与缺失时按位置兜底', async () => {
  const { swapDictOrder } = await import('../dist/core/dict/order.js')
  assert.deepEqual(swapDictOrder({ customOrder: 6 }, { customOrder: 7 }, 1, 2), {
    currentOrder: 7,
    otherOrder: 6,
  })
  assert.deepEqual(swapDictOrder({ customOrder: 5 }, { customOrder: 7 }, 0, 2), {
    currentOrder: 7,
    otherOrder: 5,
  })
  assert.deepEqual(swapDictOrder({}, { customOrder: 7 }, 0, 1), {
    currentOrder: 2,
    otherOrder: 1,
  })
  assert.deepEqual(swapDictOrder({ customOrder: 5 }, {}, 0, 1), {
    currentOrder: 2,
    otherOrder: 1,
  })
  assert.deepEqual(swapDictOrder({ customOrder: Number.NaN }, { customOrder: 7 }, 0, 1), {
    currentOrder: 2,
    otherOrder: 1,
  })
})

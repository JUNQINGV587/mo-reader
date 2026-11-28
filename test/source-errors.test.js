import assert from 'node:assert/strict'
import test from 'node:test'
import { ZodError } from 'zod'
import { BookSourceSchema } from '../dist/core/model/source.js'
import { formatSourceError, formatSourceImportError } from '../dist/core/model/source-errors.js'

const ENGLISH = /Invalid input|expected|received|Too small|Too big|Unrecognized|Invalid format|Invalid option/i

function errorOf(input) {
  const result = BookSourceSchema.safeParse(input)
  assert.equal(result.success, false)
  return result.error
}

test('保存书源：缺名称与缺地址输出中文必填提示，不透出 zod 英文', () => {
  const missingName = errorOf({ bookSourceUrl: 'https://a.example.com' })
  assert.equal(formatSourceError(missingName), '名称不能为空')
  assert.doesNotMatch(formatSourceError(missingName), ENGLISH)

  const missingBoth = errorOf({ bookSourceUrl: '', bookSourceName: '' })
  assert.equal(formatSourceError(missingBoth), '地址不能为空；名称不能为空')
})

test('保存书源：类型、整数与嵌套规则字段都有中文字段名', () => {
  assert.equal(
    formatSourceError(errorOf({ bookSourceUrl: 'https://a.example.com', bookSourceName: '甲', bookSourceType: 'x' })),
    '类型应为数字',
  )
  assert.equal(
    formatSourceError(errorOf({ bookSourceUrl: 'https://a.example.com', bookSourceName: '甲', weight: 1.5 })),
    '权重应为整数',
  )
  assert.equal(
    formatSourceError(
      errorOf({ bookSourceUrl: 'https://a.example.com', bookSourceName: '甲', ruleSearch: { bookList: 1 } }),
    ),
    '搜索规则·书单应为文本',
  )
})

test('未知字段、未知规则与枚举/格式/额外字段都有中文兜底', () => {
  const unknownTop = new ZodError([{ code: 'custom', path: ['foo'], message: 'bad' }])
  assert.equal(formatSourceError(unknownTop), '字段「foo」填写内容不合法')

  const unknownNested = new ZodError([{ code: 'custom', path: ['ruleSearch', 'mystery'], message: 'bad' }])
  assert.equal(formatSourceError(unknownNested), '搜索规则·字段「mystery」填写内容不合法')

  const enumError = new ZodError([{ code: 'invalid_value', path: ['weight'], values: ['a', 'b'], message: 'bad' }])
  assert.equal(formatSourceError(enumError), '权重只能为「a」、「b」')

  const formatError = new ZodError([{ code: 'invalid_format', path: ['bookSourceUrl'], format: 'url', message: 'bad' }])
  assert.equal(formatSourceError(formatError), '地址格式不正确')

  const extraError = new ZodError([{ code: 'unrecognized_keys', path: [], keys: ['a', 'b'], message: 'bad' }])
  assert.equal(formatSourceError(extraError), '书源包含不认识的字段：a、b')
})

test('批量导入序号从 1 开始，且与输入顺序一致', () => {
  const missing = errorOf({ bookSourceUrl: 'https://a.example.com' })
  assert.equal(formatSourceImportError(0, missing), '第 1 条：名称不能为空')
  assert.equal(formatSourceImportError(2, missing), '第 3 条：名称不能为空')
})

test('非 zod 错误与完全未知的错误仍有中文兜底', () => {
  assert.equal(formatSourceError(new Error('网络不可用')), '网络不可用')
  assert.equal(formatSourceError({ weird: true }), '书源校验失败')
})

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
  const service = Object.create(ReaderService.prototype)
  service.db = {
    sources: fakeTable(),
    books: fakeTable(),
    chapters: fakeTable(),
    readRecords: fakeTable(),
    notes: fakeTable(),
    bookmarks: fakeTable(),
    dictRules: fakeTable(),
  }
  return { service }
}

const VALID = {
  bookSourceUrl: 'https://ok.example.com',
  bookSourceName: '可用源',
  enabled: true,
  searchUrl: 'https://ok.example.com/search?q={{key}}',
  ruleSearch: { bookList: 'class.item', name: 'a@text', bookUrl: 'a@href' },
  vendorExtra: { note: '未知字段原样保留' },
}

test('服务层保存书源：抛出的错误已经是中文，成功路径不变', async () => {
  const { service } = await makeService()
  await assert.rejects(
    () => service.saveSource({ source: { bookSourceUrl: 'https://bad.example.com' } }),
    (error) => error.message === '名称不能为空' && !ENGLISH.test(error.message),
  )
  const saved = await service.saveSource({ source: VALID })
  assert.equal(saved.source.bookSourceName, '可用源')
  assert.equal(saved.source.vendorExtra.note, '未知字段原样保留')
})

test('服务层批量导入：成功计数不变，失败逐条带输入序号与中文字段', async () => {
  const { service } = await makeService()
  const result = await service.importSources({
    payload: JSON.stringify([
      VALID,
      { bookSourceUrl: 'https://bad1.example.com' },
      { bookSourceUrl: 'https://bad2.example.com', bookSourceName: '坏源', bookSourceType: 'x' },
    ]),
  })
  assert.equal(result.total, 3)
  assert.equal(result.added, 1)
  assert.equal(result.updated, 0)
  assert.equal(result.errors.length, 2)
  assert.equal(result.errors[0].message, '第 2 条：名称不能为空')
  assert.equal(result.errors[1].message, '第 3 条：类型应为数字')
  for (const item of result.errors) assert.doesNotMatch(item.message, ENGLISH)
})

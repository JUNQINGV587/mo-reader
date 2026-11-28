import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 设置底座（#124）的服务端测试：假数据表直接调服务对象，不联网、不起端口。
 * 覆盖全局读写、每书覆盖、恢复全局/本节、旧调用兼容与非法值容错。
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
  const readConfigs = fakeTable()
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
    readConfigs,
  }
  const service = Object.create(ReaderService.prototype)
  service.db = db
  return {
    service,
    readConfigs,
    getStored: () => settingsValue,
    writeCount: () => writes,
  }
}

test('无 bookId 的旧调用形状不变：只返回 settings，读取不写存储', async () => {
  const { service, writeCount } = await makeService({ theme: 'system', fontSize: 26, lineSpacing: 0.5 })
  const result = await service.getSettings()
  assert.equal('bookOverridden' in result, false)
  assert.equal(result.settings.fontSize, 26)
  assert.equal(result.settings.theme, 'system')
  // 旧记录的越界行距只在返回时钳制，不写回存储。
  assert.equal(result.settings.lineSpacing, 1.2)
  assert.equal(writeCount(), 0)
})

test('旧设置缺字段读时补默认，未知字段原样保留', async () => {
  const { service } = await makeService({ theme: 'system', fontSize: 26, myFlag: 'keep-me' })
  const { settings } = await service.getSettings()
  assert.equal(settings.letterSpacing, 0)
  assert.equal(settings.paragraphSpacing, 6)
  assert.equal(settings.indent, 2)
  assert.deepEqual(settings.padding, { left: 22, top: 5, right: 22, bottom: 4 })
  assert.equal(settings.compressPunctuation, true)
  assert.equal(settings.autoPageSeconds, 10)
  assert.equal(settings.myFlag, 'keep-me')
})

test('保存全局设置补齐默认值、越界钳制并保留未知字段', async () => {
  const { service, getStored } = await makeService({ theme: 'system', fontSize: 24 })
  const { settings } = await service.saveSettings({ settings: { fontSize: 999, futureFlag: 1 } })
  assert.equal(settings.fontSize, 48)
  assert.equal(settings.lineSpacing, 1.8)
  assert.equal(settings.tapZones.length, 9)
  assert.equal(settings.futureFlag, 1)
  assert.equal(getStored().fontSize, 48)
  assert.equal(getStored().futureFlag, 1)
})

test('非法类型不覆盖旧值，也不丢整份设置', async () => {
  const { service, getStored } = await makeService({ theme: 'system', fontSize: 26, paragraphSpacing: 6 })
  const { settings } = await service.saveSettings({
    settings: { fontSize: 'abc', tapZones: [1, 2], paragraphSpacing: 12, keepFlag: true },
  })
  assert.equal(settings.fontSize, 26)
  assert.equal(settings.tapZones.length, 9)
  assert.equal(settings.paragraphSpacing, 12)
  assert.equal(settings.keepFlag, true)
  assert.equal(getStored().fontSize, 26)
})

test('未知主题继续报错，全局设置不被破坏', async () => {
  const { service, getStored, writeCount } = await makeService({ theme: 'system', fontSize: 24 })
  await assert.rejects(service.saveSettings({ settings: { theme: 'nope' } }), /主题不存在/)
  assert.equal(getStored().theme, 'system')
  assert.equal(writeCount(), 0)
})

test('本书只写改动字段，读取时与全局合并', async () => {
  const { service, readConfigs } = await makeService({ theme: 'system', fontSize: 24, lineSpacing: 1.8 })
  await service.saveSettings({ settings: { fontSize: 26, lineSpacing: 1.9, indent: 2 } })
  const saved = await service.saveSettings({ bookId: 'b1', settings: { fontSize: 30 } })
  assert.equal(saved.bookOverridden, true)
  const record = readConfigs.get('b1')
  assert.equal(record.fontSize, 30)
  assert.equal('lineSpacing' in record, false)
  assert.equal('indent' in record, false)
  const book = await service.getSettings({ bookId: 'b1' })
  assert.equal(book.settings.fontSize, 30)
  assert.equal(book.settings.lineSpacing, 1.9)
  assert.equal(book.bookOverridden, true)
  const other = await service.getSettings({ bookId: 'b2' })
  assert.equal(other.settings.fontSize, 26)
  assert.equal(other.bookOverridden, false)
})

test('本书多次保存不清空之前改过的字段', async () => {
  const { service, readConfigs } = await makeService({ theme: 'system', fontSize: 24, paragraphSpacing: 6 })
  await service.saveSettings({ bookId: 'b1', settings: { fontSize: 30 } })
  await service.saveSettings({ bookId: 'b1', settings: { paragraphSpacing: 12 } })
  await service.saveSettings({ bookId: 'b1', settings: { fontSize: 32 } })
  const record = readConfigs.get('b1')
  assert.equal(record.fontSize, 32)
  assert.equal(record.paragraphSpacing, 12)
})

test('恢复全局清除本书覆盖并立即继承', async () => {
  const { service, readConfigs } = await makeService({ theme: 'system', fontSize: 26 })
  await service.saveSettings({ bookId: 'b1', settings: { fontSize: 34, bold: true } })
  const reset = await service.resetBookSettings({ bookId: 'b1' })
  assert.equal(reset.bookOverridden, false)
  assert.equal(reset.settings.fontSize, 26)
  assert.equal(readConfigs.get('b1'), undefined)
  const book = await service.getSettings({ bookId: 'b1' })
  assert.equal(book.settings.fontSize, 26)
  assert.equal(book.settings.bold, false)
})

test('恢复本节默认只影响该分区', async () => {
  const { service } = await makeService({ theme: 'system', fontSize: 24, padding: { left: 22, top: 5, right: 22, bottom: 4 } })
  await service.saveSettings({
    settings: { fontSize: 30, padding: { left: 30, top: 5, right: 22, bottom: 4 } },
  })
  const globalReset = await service.resetSettingsGroup({ group: 'layout' })
  assert.equal(globalReset.settings.fontSize, 24)
  assert.equal(globalReset.settings.padding.left, 30)
  await service.saveSettings({ bookId: 'b1', settings: { fontSize: 34, padding: { left: 40, top: 5, right: 22, bottom: 4 } } })
  const bookReset = await service.resetSettingsGroup({ bookId: 'b1', group: 'layout' })
  assert.equal(bookReset.settings.fontSize, 24)
  assert.equal(bookReset.settings.padding.left, 40)
  assert.equal(bookReset.bookOverridden, true)
})

test('本书保存忽略全局专属字段，主题按全局主题表校验', async () => {
  const { service, readConfigs, getStored } = await makeService({ theme: 'system', fontSize: 24, mediaQuotaBytes: 0 })
  await service.saveSettings({
    bookId: 'b1',
    settings: { fontSize: 28, mediaQuotaBytes: 5, customThemes: [{ id: 'theme-abc12345', name: '夜', bg: '#000', text: '#fff', muted: '#888', line: '#333', createdAt: '2024-01-01' }] },
  })
  const record = readConfigs.get('b1')
  assert.equal(record.fontSize, 28)
  assert.equal('mediaQuotaBytes' in record, false)
  assert.equal('customThemes' in record, false)
  assert.equal(getStored().mediaQuotaBytes, 0)
  await assert.rejects(service.saveSettings({ bookId: 'b1', settings: { theme: 'nope' } }), /主题不存在/)
})

test('保存九宫格拒绝已隐藏动作与越界值，旧值保留', async () => {
  const { service, getStored } = await makeService({ theme: 'system', tapZones: [2, 2, 1, 2, 0, 1, 2, 1, 2] })
  const before = [...getStored().tapZones]
  const hidden = await service.saveSettings({
    settings: { fontSize: 26, tapZones: [8, 2, 1, 2, 0, 1, 2, 1, 2] },
  })
  assert.deepEqual(hidden.settings.tapZones, before)
  assert.equal(hidden.settings.fontSize, 26)
  const outOfRange = await service.saveSettings({
    settings: { tapZones: [99, 2, 1, 2, 0, 1, 2, 1, 2] },
  })
  assert.deepEqual(outOfRange.settings.tapZones, before)
})

test('fontFamily 上限两端一致为 200', async () => {
  const { normalizeReaderSettings } = await import('../dist/core/reader/settings.js')
  const { ReaderDomain } = await import('../dist/server/storage.js')
  const long = 'A'.repeat(260)
  assert.equal(normalizeReaderSettings({ fontFamily: long }).fontFamily.length, 200)
  const schema = ReaderDomain.global.schema
  assert.equal(schema.parse({ fontFamily: 'A'.repeat(200) }).fontFamily.length, 200)
  assert.throws(() => schema.parse({ fontFamily: 'A'.repeat(201) }))
  const { service, getStored } = await makeService({ theme: 'system' })
  const { settings } = await service.saveSettings({ settings: { fontFamily: long } })
  assert.equal(settings.fontFamily.length, 200)
  assert.equal(getStored().fontFamily.length, 200)
})

test('恢复未知分组报错，不写任何设置', async () => {
  const { service, writeCount } = await makeService({ theme: 'system', fontSize: 24 })
  await assert.rejects(service.resetSettingsGroup({ group: 'nope' }), /未知设置分组/)
  assert.equal(writeCount(), 0)
})

test('全局恢复页面分区不清空自定义主题', async () => {
  const theme = { id: 'theme-abc12345', name: '夜', bg: '#000', text: '#fff', muted: '#888', line: '#333', createdAt: '2024-01-01' }
  const { service, getStored } = await makeService({ theme: 'theme-abc12345', customThemes: [theme], fontSize: 30 })
  const reset = await service.resetSettingsGroup({ group: 'page' })
  assert.equal(reset.settings.theme, 'light')
  assert.equal(reset.settings.customThemes.length, 1)
  assert.equal(getStored().customThemes.length, 1)
})

test('书架皮肤默认网格，保存后重新读取仍保持', async () => {
  const { service, getStored, writeCount } = await makeService({ theme: 'system' })
  const initial = await service.getSettings()
  assert.equal(initial.settings.shelfSkin, 'grid')
  const saved = await service.saveSettings({ settings: { shelfSkin: 'list' } })
  assert.equal(saved.settings.shelfSkin, 'list')
  assert.equal(getStored().shelfSkin, 'list')
  // 刷新/重进插件 = 用同一份存储新建服务实例再读
  const reloaded = await makeService(getStored())
  assert.equal((await reloaded.service.getSettings()).settings.shelfSkin, 'list')
  const back = await reloaded.service.saveSettings({ settings: { shelfSkin: 'grid' } })
  assert.equal(back.settings.shelfSkin, 'grid')
  assert.equal(reloaded.getStored().shelfSkin, 'grid')
  assert.ok(writeCount() >= 1)
  assert.ok(reloaded.writeCount() >= 1)
})

test('书架皮肤未知值回落网格，且不写进本书覆盖', async () => {
  const { service, readConfigs } = await makeService({ theme: 'system' })
  const global = await service.saveSettings({ settings: { shelfSkin: 'wall' } })
  assert.equal(global.settings.shelfSkin, 'grid')
  const book = await service.saveSettings({ bookId: 'b1', settings: { shelfSkin: 'list', fontSize: 30 } })
  assert.equal(book.settings.shelfSkin, 'grid')
  assert.equal(book.settings.fontSize, 30)
  assert.equal('shelfSkin' in readConfigs.get('b1'), false)
})

test('书架皮肤在存储 schema 上只接受 grid/list', async () => {
  const { ReaderDomain } = await import('../dist/server/storage.js')
  const schema = ReaderDomain.global.schema
  assert.equal(schema.parse({ shelfSkin: 'list' }).shelfSkin, 'list')
  assert.equal(schema.parse({ shelfSkin: 'wall' }).shelfSkin, 'grid')
  assert.equal(schema.parse({}).shelfSkin, 'grid')
  assert.equal(ReaderDomain.global.initial.shelfSkin, 'grid')
})

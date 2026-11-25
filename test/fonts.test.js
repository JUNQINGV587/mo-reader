import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const FONT_ROOT = await mkdtemp(join(tmpdir(), 'mo-reader-fonts-'))
process.env.MO_READER_FONT_ROOT = FONT_ROOT
const { ReaderService } = await import('../dist/server/service.js')

function makeService() {
  let settingsValue = { fontSize: 22, fontId: '' }
  const settings = {
    get: () => settingsValue,
    set: async (value) => {
      settingsValue = value
    },
  }
  const service = Object.create(ReaderService.prototype)
  service.db = { settings }
  return { service, settings, getSettings: () => settingsValue }
}

function ttf(size = 256) {
  const bytes = Buffer.alloc(size, 0)
  Buffer.from([0, 1, 0, 0]).copy(bytes, 0)
  return bytes
}

test('字体上传、列表、读取、重复上传与删除', async () => {
  const { service, getSettings } = makeService()
  const bytes = ttf()
  const first = await service.uploadFont({ fileName: '我的字体.ttf', dataBase64: bytes.toString('base64') })
  assert.equal(first.created, true)
  assert.equal(first.font.name, '我的字体')
  assert.match(first.font.id, /^font-[a-f0-9]{24}$/)

  const duplicate = await service.uploadFont({ fileName: 'again.ttf', dataBase64: bytes.toString('base64') })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.font.id, first.font.id)

  const list = await service.listFonts()
  assert.equal(list.fonts.length, 1)
  assert.equal(list.fonts[0].name, '我的字体')

  const loaded = await service.getFont({ id: first.font.id })
  assert.equal(loaded.dataBase64, bytes.toString('base64'))
  assert.equal(loaded.mime, 'font/ttf')
  assert.equal((await readFile(join(FONT_ROOT, `${first.font.id}.ttf`))).length, 256)

  await service.saveSettings({ settings: { fontId: first.font.id } })
  assert.equal(getSettings().fontId, first.font.id)

  const removed = await service.deleteFont({ id: first.font.id })
  assert.equal(removed.deleted, true)
  assert.equal((await service.listFonts()).fonts.length, 0)
  assert.equal(getSettings().fontId, '')
  await assert.rejects(service.getFont({ id: first.font.id }), /字体不存在/)
})

test('字体校验拒绝不支持格式、伪造内容和超大文件', async () => {
  const { service } = makeService()
  await assert.rejects(
    service.uploadFont({ fileName: 'font.exe', dataBase64: ttf().toString('base64') }),
    /字体格式不支持/,
  )
  await assert.rejects(
    service.uploadFont({ fileName: 'fake.ttf', dataBase64: Buffer.from('not a font').toString('base64') }),
    /不是有效的字体文件/,
  )
  const huge = Buffer.alloc(20 * 1024 * 1024 + 1, 0)
  Buffer.from([0, 1, 0, 0]).copy(huge, 0)
  await assert.rejects(
    service.uploadFont({ fileName: 'huge.ttf', dataBase64: huge.toString('base64') }),
    /不能超过 20MB/,
  )
  await assert.rejects(service.uploadFont({ fileName: 'empty.ttf', dataBase64: '' }), /缺少参数 dataBase64|字体文件为空/)
  await assert.rejects(service.getFont({ id: '../../etc/passwd' }), /字体不存在/)
})

test('保存设置时拒绝不存在的字体', async () => {
  const { service } = makeService()
  await assert.rejects(
    service.saveSettings({ settings: { fontId: 'font-000000000000000000000000' } }),
    /字体不存在/,
  )
})

test.after(async () => {
  await rm(FONT_ROOT, { recursive: true, force: true })
})

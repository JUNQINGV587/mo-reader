import assert from 'node:assert/strict'
import test from 'node:test'

const { ARGLESS_METHODS, REMOTE_METHODS } = await import('../dist/core/remote-methods.js')

test('无参方法都在远端清单里，且没有重复', () => {
  const seen = new Set()
  for (const method of ARGLESS_METHODS) {
    assert.ok(REMOTE_METHODS.includes(method), `${method} 不在 REMOTE_METHODS`)
    assert.ok(!seen.has(method), `${method} 重复声明`)
    seen.add(method)
  }
})

test('不接收入参的方法必须声明成零参数（否则参数个数会校验失败）', () => {
  for (const method of [
    'state',
    'listBooks',
    'listFonts',
    'getStorageUsage',
    'getReadingStats',
    'clearReadingStats',
    'clearAllMedia',
    'clearAllCaches',
    'clearDownloads',
  ]) {
    assert.ok(ARGLESS_METHODS.includes(method), `${method} 应当零参数`)
  }
})

test('备份导出与导入方法注册给客户端，且都接收 args 对象', () => {
  for (const method of [
    'startBackup',
    'getBackupDownload',
    'getBackupJob',
    'cancelBackupJob',
    'previewBackupImport',
    'beginBackupImportUpload',
    'appendBackupImportUpload',
    'finishBackupImportUpload',
    'applyBackupImport',
  ]) {
    assert.ok(REMOTE_METHODS.includes(method), `${method} 不在 REMOTE_METHODS`)
    assert.ok(!ARGLESS_METHODS.includes(method), `${method} 需要接收 args 对象`)
  }
})

test('搜索与取消都注册给客户端，且都接收 args 对象', () => {
  for (const method of ['searchBooks', 'cancelSearch']) {
    assert.ok(REMOTE_METHODS.includes(method), `${method} 不在 REMOTE_METHODS`)
    assert.ok(!ARGLESS_METHODS.includes(method), `${method} 需要接收 args 对象`)
  }
})

test('WebDAV 配置方法注册给客户端：读取零参数，保存与连通测试都接收 args', () => {
  assert.ok(REMOTE_METHODS.includes('getWebdavConfig'))
  assert.ok(REMOTE_METHODS.includes('saveWebdavConfig'))
  assert.ok(REMOTE_METHODS.includes('testWebdav'))
  assert.ok(ARGLESS_METHODS.includes('getWebdavConfig'), 'getWebdavConfig 应当零参数')
  assert.ok(!ARGLESS_METHODS.includes('saveWebdavConfig'), 'saveWebdavConfig 需要接收 args 对象')
  assert.ok(!ARGLESS_METHODS.includes('testWebdav'), 'testWebdav 需要接收 args 对象')
})

test('接受入参的方法不能声明成零参数（否则客户端调用直接报参数个数不符）', () => {
  for (const method of [
    'getSettings',
    'saveSettings',
    'resetBookSettings',
    'resetSettingsGroup',
    'getProgress',
    'getContent',
    'saveReadingTime',
  ]) {
    assert.ok(!ARGLESS_METHODS.includes(method), `${method} 需要接收 args 对象`)
  }
})

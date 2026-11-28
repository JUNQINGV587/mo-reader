import assert from 'node:assert/strict'
import test from 'node:test'

const { shelfLoadErrorMessage, shelfShowsEmpty } = await import('../dist/core/reader/shelf-load.js')

test('书架加载失败：裸 fetch 文案换成人话', () => {
  assert.equal(shelfLoadErrorMessage('Failed to fetch'), '网络连接失败，请检查网络后重试')
  assert.equal(shelfLoadErrorMessage('TypeError: Failed to fetch'), '网络连接失败，请检查网络后重试')
  assert.equal(shelfLoadErrorMessage('NetworkError when attempting to fetch resource.'), '网络连接失败，请检查网络后重试')
  assert.equal(shelfLoadErrorMessage('Load failed'), '网络连接失败，请检查网络后重试')
  assert.equal(shelfLoadErrorMessage('fetch failed'), '网络连接失败，请检查网络后重试')
  assert.equal(shelfLoadErrorMessage('listBooks：Failed to fetch'), '网络连接失败，请检查网络后重试')
})

test('书架加载失败：插件未就绪与中文服务端文案', () => {
  assert.equal(shelfLoadErrorMessage('Remote 未就绪：listBooks'), '插件尚未就绪，请稍后重试')
  const reason = '书架数据读取失败：目录不可写'
  assert.equal(shelfLoadErrorMessage(reason), reason)
})

test('书架加载失败：空文案与对象兜底', () => {
  assert.equal(shelfLoadErrorMessage(''), '书架加载失败，请稍后重试')
  assert.equal(shelfLoadErrorMessage('   '), '书架加载失败，请稍后重试')
  assert.equal(shelfLoadErrorMessage('[object Object]'), '书架加载失败，请稍后重试')
})

test('错误态不再显示空书架，正常空书架仍显示', () => {
  assert.equal(shelfShowsEmpty(0, '网络连接失败，请检查网络后重试'), false)
  assert.equal(shelfShowsEmpty(0, ''), true)
  assert.equal(shelfShowsEmpty(-1, ''), true)
  assert.equal(shelfShowsEmpty(3, ''), false)
  assert.equal(shelfShowsEmpty(3, '出错了'), false)
})

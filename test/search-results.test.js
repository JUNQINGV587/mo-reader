import assert from 'node:assert/strict'
import test from 'node:test'

const { dedupeSearchResults, searchBookKey } = await import('../dist/core/source/search-results.js')

function book(name, author, origin, bookUrl, extra = {}) {
  return {
    name,
    author,
    kind: '玄幻',
    wordCount: '',
    lastChapter: '',
    intro: '',
    coverUrl: '',
    bookUrl,
    origin,
    originName: origin.replace('https://', ''),
    type: 0,
    ...extra,
  }
}

test('同一本书多个来源只留一条，主记录取首个来源并保留全部来源', () => {
  const merged = dedupeSearchResults([
    book('完美世界', '辰东', 'https://a', 'https://a/book/1'),
    book('完美世界', '辰东', 'https://b', 'https://b/book/9'),
    book('完美世界', '辰东', 'https://c', 'https://c/x'),
  ])
  assert.equal(merged.length, 1)
  const first = merged[0]
  assert.equal(first.name, '完美世界')
  assert.equal(first.author, '辰东')
  assert.equal(first.origin, 'https://a')
  assert.equal(first.bookUrl, 'https://a/book/1')
  assert.equal(first.sourceCount, 3)
  assert.deepEqual(
    first.sources.map((source) => source.origin),
    ['https://a', 'https://b', 'https://c'],
  )
})

test('同书名不同作者不合并', () => {
  const merged = dedupeSearchResults([
    book('完美世界', '辰东', 'https://a', 'https://a/1'),
    book('完美世界', '辰东（续写）', 'https://b', 'https://b/1'),
  ])
  assert.equal(merged.length, 2)
  assert.deepEqual(merged.map((item) => item.sourceCount), [1, 1])
})

test('书名大小写与多余空格归一化后合并', () => {
  const merged = dedupeSearchResults([
    book(' The Perfect World ', '  Chen  Dong ', 'https://a', 'https://a/1'),
    book('the perfect world', 'chen dong', 'https://b', 'https://b/2'),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceCount, 2)
})

test('缺作者时按书名成键，同书多源仍合并', () => {
  const merged = dedupeSearchResults([
    book('完美世界', '', 'https://a', 'https://a/1'),
    book('完美世界', '  ', 'https://b', 'https://b/2'),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceCount, 2)
  assert.equal(searchBookKey('完美世界', ''), searchBookKey('完美世界', '   '))
})

test('空数组与无书名的条目被跳过', () => {
  assert.deepEqual(dedupeSearchResults([]), [])
  const merged = dedupeSearchResults([book('', '辰东', 'https://a', 'https://a/1'), book('完美世界', '辰东', 'https://a', 'https://a/2')])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].name, '完美世界')
})

test('重复去重幂等：已合并结果再次合并不会丢失来源', () => {
  const once = dedupeSearchResults([
    book('完美世界', '辰东', 'https://a', 'https://a/1'),
    book('完美世界', '辰东', 'https://b', 'https://b/2'),
  ])
  const twice = dedupeSearchResults(once)
  assert.equal(twice.length, 1)
  assert.equal(twice[0].sourceCount, 2)
  assert.equal(twice[0].sources.length, 2)
})

test('合并时用后续来源补上主记录缺失的字段', () => {
  const merged = dedupeSearchResults([
    book('完美世界', '辰东', 'https://a', 'https://a/1', { intro: '' }),
    book('完美世界', '辰东', 'https://b', 'https://b/2', { intro: '一粒尘可填海', lastChapter: '第1章' }),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].intro, '一粒尘可填海')
  assert.equal(merged[0].lastChapter, '第1章')
})

test('同源同书只记一个来源，不同书 URL 视为不同来源', () => {
  const merged = dedupeSearchResults([
    book('完美世界', '辰东', 'https://a', 'https://a/1'),
    book('完美世界', '辰东', 'https://a', 'https://a/1'),
    book('完美世界', '辰东', 'https://a', 'https://a/2'),
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].sourceCount, 2)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeChapterContent, analyzeContent, contentKindOf } from '../dist/core/source/analyze.js'

const baseSource = {
  bookSourceUrl: 'https://example.com',
  bookSourceName: '示例源',
  bookSourceType: 0,
}

test('contentKindOf 按 BookSourceType 映射', () => {
  assert.equal(contentKindOf({ ...baseSource, bookSourceType: 0 }), 'text')
  assert.equal(contentKindOf({ ...baseSource, bookSourceType: 1 }), 'audio')
  assert.equal(contentKindOf({ ...baseSource, bookSourceType: 2 }), 'images')
  assert.equal(contentKindOf({ ...baseSource, bookSourceType: 4 }), 'video')
  assert.equal(contentKindOf({ ...baseSource, bookSourceType: 3 }), 'text')
})

test('文本源仍返回纯文本', () => {
  const source = { ...baseSource, ruleContent: { content: '.content@text' } }
  const html = '<div class="content"><p>第一段</p><p>第二段</p></div>'
  const result = analyzeChapterContent(html, source, 'https://example.com/ch/1')
  assert.equal(result.kind, 'text')
  assert.match(result.text, /第一段/)
  assert.match(result.text, /第二段/)
  assert.deepEqual(result.images, [])
  assert.equal(analyzeContent(html, source, 'https://example.com/ch/1'), result.text)
})

test('图片源从 ruleContent 取图片并补全相对地址', () => {
  const source = { ...baseSource, bookSourceType: 2, ruleContent: { content: 'img@src' } }
  const html = '<div id="images"><img src="/a.jpg"><img src="b.jpg"><img src="/a.jpg"></div>'
  const result = analyzeChapterContent(html, source, 'https://example.com/ch/1')
  assert.equal(result.kind, 'images')
  assert.deepEqual(result.images, ['https://example.com/a.jpg', 'https://example.com/ch/b.jpg'])
})

test('图片源规则为空时回退整页 <img>', () => {
  const source = { ...baseSource, bookSourceType: 2, ruleContent: { content: '' } }
  const html = '<html><body><img src="https://cdn.example.com/1.png"/><img src="https://cdn.example.com/2.png"/></body></html>'
  const result = analyzeChapterContent(html, source, 'https://example.com/ch/2')
  assert.equal(result.kind, 'images')
  assert.deepEqual(result.images, [
    'https://cdn.example.com/1.png',
    'https://cdn.example.com/2.png',
  ])
})

test('音频与视频源直接用章节 URL 作为媒体地址', () => {
  const audio = analyzeChapterContent('', { ...baseSource, bookSourceType: 1 }, 'https://example.com/ch/1')
  assert.equal(audio.kind, 'audio')
  assert.equal(audio.mediaUrl, 'https://example.com/ch/1')
  assert.equal(audio.text, '')

  const video = analyzeChapterContent(
    'ignored',
    { ...baseSource, bookSourceType: 4 },
    'https://example.com/fallback',
    'https://cdn.example.com/video.m3u8',
  )
  assert.equal(video.kind, 'video')
  assert.equal(video.mediaUrl, 'https://cdn.example.com/video.m3u8')
})

test('音视频源用 ruleContent 从章节页解析直链', () => {
  const videoSource = { ...baseSource, bookSourceType: 4, ruleContent: { content: 'video@src' } }
  const videoHtml = '<div class="player"><video src="https://cdn.example.com/ep1.m3u8"></video></div>'
  const video = analyzeChapterContent(videoHtml, videoSource, 'https://example.com/ep/1', 'https://example.com/ep/1')
  assert.equal(video.kind, 'video')
  assert.equal(video.mediaUrl, 'https://cdn.example.com/ep1.m3u8')

  const audioSource = { ...baseSource, bookSourceType: 1, ruleContent: { content: 'audio@src' } }
  const audioHtml = '<audio src="/media/a.mp3"></audio>'
  const audio = analyzeChapterContent(audioHtml, audioSource, 'https://example.com/ch/2')
  assert.equal(audio.kind, 'audio')
  assert.equal(audio.mediaUrl, 'https://example.com/media/a.mp3')
})

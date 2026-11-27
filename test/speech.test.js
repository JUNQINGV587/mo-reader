import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 朗读计划与游标（#127）：纯逻辑，不碰 speechSynthesis。
 * 计划 = 章节标题一段 + 正文按换行/空行切段（跳过空白段），每段记录绝对字符偏移；
 * 游标负责段内字符位置、上一段/下一段与章末判断；错误分类决定重试/暂停/停止。
 */
const {
  buildSpeechPlan,
  SpeechCursor,
  segmentIndexForOffset,
  classifySpeechError,
  speechErrorNotice,
  SPEECH_NOT_ALLOWED_NOTICE,
} = await import('../dist/core/reader/speech.js')

test('朗读计划：标题一段 + 正文按换行切段，记录绝对偏移', () => {
  const plan = buildSpeechPlan('  第一章  ', '第一段\n\n第二段\n   \n第三段')
  assert.equal(plan.segments.length, 4)
  assert.deepEqual(
    plan.segments.map((segment) => ({ kind: segment.kind, text: segment.text, start: segment.start, end: segment.end })),
    [
      { kind: 'title', text: '第一章', start: -1, end: -1 },
      { kind: 'paragraph', text: '第一段', start: 0, end: 3 },
      { kind: 'paragraph', text: '第二段', start: 5, end: 8 },
      { kind: 'paragraph', text: '第三段', start: 13, end: 16 },
    ],
  )
})

test('朗读计划：段首段尾空白不计入偏移，CRLF 归一化', () => {
  const plan = buildSpeechPlan('', '  缩进段  \n正常\r\n结尾  ')
  assert.deepEqual(
    plan.segments.map((segment) => ({ text: segment.text, start: segment.start, end: segment.end })),
    [
      { text: '缩进段', start: 2, end: 5 },
      { text: '正常', start: 8, end: 10 },
      { text: '结尾', start: 11, end: 13 },
    ],
  )
})

test('朗读计划：空内容不产生段，空正文只有标题段', () => {
  assert.equal(buildSpeechPlan('', '').segments.length, 0)
  assert.equal(buildSpeechPlan('   ', '\n\n').segments.length, 0)
  const titleOnly = buildSpeechPlan('第二章', '  \n ')
  assert.equal(titleOnly.segments.length, 1)
  assert.equal(titleOnly.segments[0].kind, 'title')
})

test('游标：初始在首段，next/prev 到边界停下，章末 advance 返回 end', () => {
  const cursor = new SpeechCursor(buildSpeechPlan('标题', '甲\n乙'))
  assert.equal(cursor.total, 3)
  assert.equal(cursor.index, 0)
  assert.equal(cursor.segment.kind, 'title')
  assert.equal(cursor.isLast, false)
  assert.equal(cursor.advance(), 'next')
  assert.equal(cursor.segment.text, '甲')
  assert.equal(cursor.advance(), 'next')
  assert.equal(cursor.segment.text, '乙')
  assert.equal(cursor.isLast, true)
  assert.equal(cursor.advance(), 'end')
  assert.equal(cursor.index, 2, '章末不再移动')
  assert.equal(cursor.prev(), true)
  assert.equal(cursor.segment.text, '甲')
  assert.equal(cursor.prev(), true)
  assert.equal(cursor.prev(), false)
  assert.equal(cursor.segment.kind, 'title')
})

test('游标：setIndex 钳位并复位段内偏移，空计划安全', () => {
  const cursor = new SpeechCursor(buildSpeechPlan('', '甲\n乙'))
  cursor.setIndex(1)
  assert.equal(cursor.segment.text, '乙')
  cursor.setBoundary(1)
  cursor.setIndex(0)
  assert.equal(cursor.charOffset, 0)
  cursor.setIndex(99)
  assert.equal(cursor.index, 1)
  cursor.setIndex(-5)
  assert.equal(cursor.index, 0)

  const empty = new SpeechCursor(buildSpeechPlan('', ''))
  assert.equal(empty.total, 0)
  assert.equal(empty.segment, null)
  assert.equal(empty.isLast, true)
  assert.equal(empty.advance(), 'end')
  assert.equal(empty.next(), false)
  assert.equal(empty.prev(), false)
  assert.equal(empty.highlightRange(), null)
  assert.equal(empty.remainingText(), '')
})

test('游标：boundary 转绝对偏移并钳位，无 boundary 时整段高亮', () => {
  const cursor = new SpeechCursor(buildSpeechPlan('标题', '第一段\n第二段'))
  assert.deepEqual(cursor.highlightRange(), null, '标题高亮由页面标题承担')
  cursor.advance()
  assert.deepEqual(cursor.highlightRange(), { start: 0, end: 3 }, '未收到 boundary 时整段高亮')
  cursor.setBoundary(2)
  assert.equal(cursor.absoluteOffset, 2)
  assert.deepEqual(cursor.highlightRange(), { start: 2, end: 3 })
  assert.equal(cursor.remainingText(), '段')
  cursor.setBoundary(99)
  assert.equal(cursor.charOffset, 3)
  assert.equal(cursor.remainingText(), '')
  assert.equal(cursor.highlightRange(), null)
  cursor.setBoundary(-3)
  assert.equal(cursor.charOffset, 0)

  cursor.advance()
  cursor.setBoundary(1)
  assert.equal(cursor.absoluteOffset, 5, '第二段绝对偏移 = 4 + 1')
  assert.deepEqual(cursor.highlightRange(), { start: 5, end: 7 })
})

test('segmentIndexForOffset：按当前页起始偏移找段，找不到取最近', () => {
  const plan = buildSpeechPlan('标题', '第一段\n第二段\n第三段')
  assert.equal(segmentIndexForOffset(plan, 0), 1)
  assert.equal(segmentIndexForOffset(plan, 2), 1)
  assert.equal(segmentIndexForOffset(plan, 4), 2)
  assert.equal(segmentIndexForOffset(plan, 7), 3)
  assert.equal(segmentIndexForOffset(plan, 999), 3)
  assert.equal(segmentIndexForOffset(plan, -1), 1)
  assert.equal(segmentIndexForOffset(buildSpeechPlan('标题', ''), 0), -1)
  assert.equal(segmentIndexForOffset(buildSpeechPlan('', ''), 0), -1)
})

test('错误分类：用户取消忽略、not-allowed 暂停提示、audio-busy 只重试一次、其它停止', () => {
  assert.equal(classifySpeechError('interrupted', true), 'ignore')
  assert.equal(classifySpeechError('canceled', true), 'ignore')
  assert.equal(classifySpeechError('interrupted', false), 'stop')
  assert.equal(classifySpeechError('canceled', false), 'stop')
  assert.equal(classifySpeechError('not-allowed', false), 'not-allowed')
  assert.equal(classifySpeechError('not-allowed', true), 'not-allowed')
  assert.equal(classifySpeechError('audio-busy', false), 'retry')
  assert.equal(classifySpeechError('audio-hardware', false), 'stop')
  assert.equal(classifySpeechError('synthesis-failed', false), 'stop')
  assert.equal(classifySpeechError('network', false), 'stop')
  assert.equal(classifySpeechError('', false), 'stop')
  assert.equal(classifySpeechError(undefined, false), 'stop')
})

test('错误文案：not-allowed 要求点页面，其它给可读原因', () => {
  assert.equal(speechErrorNotice('not-allowed'), SPEECH_NOT_ALLOWED_NOTICE)
  assert.equal(SPEECH_NOT_ALLOWED_NOTICE, '点一下页面再继续')
  assert.match(speechErrorNotice('synthesis-failed'), /朗读失败/)
  assert.match(speechErrorNotice('audio-hardware'), /朗读失败/)
  assert.match(speechErrorNotice('network'), /朗读失败/)
})

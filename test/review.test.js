import assert from 'node:assert/strict'
import test from 'node:test'

const source = {
  bookSourceUrl: 'https://example.com',
  bookSourceName: '示例源',
  ruleReview: {
    enabled: true,
    reviewSummaryUrl: 'https://api.example.com/review?book={{bookUrl}}&chapter={{chapterUrl}}',
    summaryListRule: '$.data[*]',
    summaryParagraphIndexRule: '$.paragraph',
    summaryCountRule: '$.count',
    summaryParagraphDataRule: '$.data',
  },
}

const body = JSON.stringify({
  data: [
    { paragraph: 1, count: 3, data: '第一段' },
    { paragraph: 2, count: 0, data: '第二段' },
    { paragraph: 4, count: 2, data: '第四段' },
  ],
})

test('段评摘要：按段落聚合计数与数据', async () => {
  const { parseReviewSummary } = await import('../dist/core/source/review.js')
  const rule = source.ruleReview
  const result = parseReviewSummary(
    body,
    rule,
    source,
    { bookUrl: 'https://example.com/book/1', name: '示例书' },
    { url: 'https://example.com/book/1/2', title: '第二章', index: 1 },
    'https://api.example.com',
  )
  assert.ok(result)
  assert.deepEqual(result.counts, { 1: 3, 4: 2 })
  assert.equal(result.keys[1], '第一段')
  assert.equal(result.keys[4], '第四段')
})

test('段评：源未配置时返回 not supported', async () => {
  const { reviewRule, summaryIsConfigured } = await import('../dist/core/source/review.js')
  const disabled = { ...source, ruleReview: { ...source.ruleReview, enabled: false } }
  const empty = { ...source, ruleReview: { enabled: true } }
  assert.equal(reviewRule(disabled), null)
  assert.equal(reviewRule(empty)?.enabled, true)
  assert.equal(summaryIsConfigured(empty), false)
  assert.equal(summaryIsConfigured(source.ruleReview), true)
})

test('段评摘要 URL：{{bookUrl}}/{{chapterUrl}} 占位符替换', async () => {
  const { buildReviewSummaryRequest } = await import('../dist/core/source/review.js')
  const rule = source.ruleReview
  const request = buildReviewSummaryRequest(
    rule,
    source,
    { bookUrl: 'https://example.com/book/1' },
    { url: 'https://example.com/book/1/2' },
  )
  assert.ok(request)
  assert.equal(
    request.url,
    'https://api.example.com/review?book=https://example.com/book/1&chapter=https://example.com/book/1/2',
  )
})

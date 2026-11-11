import test from 'node:test'
import assert from 'node:assert/strict'
import { createBackup, parseBackup } from '../lib/backup.js'
import { createJob, transitionJob } from '../lib/jobs.js'
import { stableId } from '../lib/utils.js'

test('persistent download state machine supports queue, recovery, progress and cancellation', () => {
  const created = createJob({ bookId: 'b1', total: 2 })
  assert.equal(created.status, 'queued')
  const running = transitionJob(created, 'start')
  assert.equal(running.status, 'running')
  const progressed = transitionJob(running, 'chapter')
  assert.equal(progressed.done, 1)
  assert.equal(progressed.status, 'running')
  const recovered = transitionJob(running, 'recover')
  assert.equal(recovered.status, 'queued')
  assert.equal(recovered.done, 0)
  const completed = transitionJob(transitionJob(running, 'chapter'), 'complete')
  assert.equal(completed.status, 'completed')
  assert.equal(completed.done, 2)
  assert.equal(transitionJob(running, 'cancel').status, 'cancelled')
  assert.throws(() => transitionJob(completed, 'start'), /Cannot start/)
  assert.throws(() => transitionJob(completed, 'fail'), /Cannot fail/)
})

test('backup allowlists records and strips secrets instead of exporting them', () => {
  const sourceId = stableId('source', 'https://example.com')
  const json = createBackup({
    sources: [{ id: sourceId, name: 'S', bookSourceUrl: 'https://example.com', allowHttp: false, token: 'drop-me', rules: { search: { url: '/s', headers: { Authorization: 'Bearer drop-me', Accept: 'application/json' } } } }],
    books: [{ id: 'b', sourceId, bookUrl: 'https://example.com/b', name: 'B', secret: 'drop-me', progress: { chapterId: 'c', offset: 4, percent: 50 } }],
    chapters: [{ id: 'c', bookId: 'b', index: 0, title: 'C', url: 'https://example.com/c', text: 'raw cache', cookie: 'drop-me' }],
    settings: { replacements: [{ type: 'text', pattern: 'x', replacement: 'y' }], autoDownloadNewChapters: true, password: 'drop-me' },
    notes: [{ id: 'n', bookId: 'b', chapterId: 'c', text: 'note', token: 'drop-me' }],
    subscriptions: [{ id: 'sub', url: 'https://user:pass@example.com/sources.json?token=drop-me&mirror=1#frag', sourceIds: [sourceId], status: 'error', allowHttp: true, lastCheckedAt: '2026-11-11T08:00:00.000Z', lastFailureAt: '2026-11-11T08:00:00.000Z', lastError: 'drop-me', createdAt: '2026-11-11T08:00:00.000Z', runtime: { code: 'drop-me' }, token: 'drop-me' }],
  })
  assert.equal(json.includes('drop-me'), false)
  assert.equal(json.includes('Authorization'), false)
  assert.equal(json.includes('password'), false)
  const parsed = parseBackup(json)
  assert.equal(parsed.chapters[0].text, 'raw cache')
  assert.equal(parsed.sources[0].rules.search.headers.Accept, 'application/json')
  assert.deepEqual(parsed.subscriptions, [{ id: 'sub', url: 'https://example.com/sources.json?mirror=1', sourceIds: [sourceId], status: 'error', allowHttp: true, lastCheckedAt: '2026-11-11T08:00:00.000Z', lastFailureAt: '2026-11-11T08:00:00.000Z', createdAt: '2026-11-11T08:00:00.000Z' }])
  assert.equal(json.includes('lastError'), false, '运行期错误详情不进入备份')
  assert.deepEqual(parseBackup(JSON.parse(json)), parsed)
})

test('backup import rejects secrets and malformed references', () => {
  assert.throws(() => parseBackup('{"type":"modu-reader-backup","version":1,"token":"x"}'), /must not contain secrets/)
  assert.throws(() => parseBackup('{}'), /格式或版本/)
  assert.throws(() => parseBackup(undefined), /data 必须/)
})

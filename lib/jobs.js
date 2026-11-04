import { ReaderError } from './errors.js'
import { id, now } from './utils.js'

export const ACTIVE_JOBS = new Set(['queued', 'running'])

export function createJob({ bookId, type = 'download', total = 0 }) {
  const timestamp = now()
  return { id: id('job'), type, bookId, status: 'queued', total, done: 0, createdAt: timestamp, updatedAt: timestamp }
}

export function transitionJob(job, event, details = {}) {
  if (!job) throw new ReaderError('reader/not-found', 'Download job not found.')
  const next = { ...job, ...details, updatedAt: now() }
  if (event === 'start') {
    if (job.status !== 'queued') throw new ReaderError('reader/job-state', `Cannot start a ${job.status} job.`)
    next.status = 'running'
    next.error = undefined
  } else if (event === 'chapter') {
    if (job.status !== 'running') throw new ReaderError('reader/job-state', `Cannot advance a ${job.status} job.`)
    next.done = Math.min(job.total, job.done + 1)
  } else if (event === 'complete') {
    if (!['queued', 'running'].includes(job.status)) throw new ReaderError('reader/job-state', `Cannot complete a ${job.status} job.`)
    next.status = 'completed'
    next.done = next.total
    next.error = undefined
  } else if (event === 'fail') {
    if (!ACTIVE_JOBS.has(job.status)) throw new ReaderError('reader/job-state', `Cannot fail a ${job.status} job.`)
    next.status = 'failed'
    next.error = details.error ?? 'Unknown error'
  } else if (event === 'cancel') {
    if (!ACTIVE_JOBS.has(job.status)) throw new ReaderError('reader/job-state', `Cannot cancel a ${job.status} job.`)
    next.status = 'cancelled'
    next.cancelledAt = next.updatedAt
  } else if (event === 'recover') {
    if (job.status !== 'running') throw new ReaderError('reader/job-state', `Cannot recover a ${job.status} job.`)
    next.status = 'queued'
    next.recoveredAt = next.updatedAt
  } else {
    throw new ReaderError('reader/job-state', `Unknown job event ${event}.`)
  }
  return next
}

export function jobView(job) {
  const { id, type, bookId, status, total, done, error, createdAt, updatedAt } = job
  return { id, type, bookId, status, total, done, error, createdAt, updatedAt }
}

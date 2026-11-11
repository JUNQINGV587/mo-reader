import { ReaderError } from './errors.js'
import { normalizeSource } from './rules.js'

export function parseSourceLibrary(raw, { allowHttp = false } = {}) {
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [raw]
  if (!items.length || items.length > 1000) throw new ReaderError('reader/invalid-source', '源库必须包含 1 到 1000 个书源。')
  const sources = []
  const ids = new Set()
  items.forEach((item, index) => {
    try {
      const source = normalizeSource(item, { allowHttp })
      if (source.id === 'local' || source.bookSourceUrl === 'local:') throw new ReaderError('reader/invalid-source', '不能订阅本地导入源。')
      if (ids.has(source.id)) throw new ReaderError('reader/invalid-source', `书源 ${source.name} 重复。`)
      ids.add(source.id)
      sources.push(source)
    } catch (error) {
      if (error?.code === 'reader/invalid-source' && /重复|本地导入/.test(error.message)) throw error
      throw new ReaderError('reader/invalid-source', `源库第 ${index + 1} 个书源无效：${error?.message || String(error)}`, undefined, { cause: error })
    }
  })
  return sources
}

function fingerprint(source) {
  return JSON.stringify([source.name, source.bookSourceUrl, source.allowHttp === true, source.rules ?? {}])
}

export function planSourceRefresh(subscription, candidates, existing, otherOwned) {
  const oldIds = new Set(subscription.sourceIds ?? [])
  const candidateIds = candidates.map(source => source.id)
  const candidateSet = new Set(candidateIds)
  const writes = []
  const deletes = []
  let unchanged = 0

  for (const candidate of candidates) {
    const previous = existing.get(candidate.id)
    if (!previous) {
      writes.push({ action: 'add', source: { ...candidate, enabled: true } })
      continue
    }
    if (fingerprint(previous) === fingerprint(candidate)) {
      unchanged += 1
      continue
    }
    writes.push({
      action: 'update',
      source: {
        ...candidate,
        enabled: previous.enabled !== false,
        ...(previous.builtin ? { builtin: true } : {}),
      },
    })
  }

  for (const sourceId of oldIds) {
    if (candidateSet.has(sourceId)) continue
    if (otherOwned.has(sourceId)) continue
    if (existing.get(sourceId)?.builtin) continue
    deletes.push(sourceId)
  }

  return {
    candidateIds,
    writes,
    deletes,
    added: writes.filter(item => item.action === 'add').length,
    updated: writes.filter(item => item.action === 'update').length,
    removed: deletes.length,
    unchanged,
  }
}

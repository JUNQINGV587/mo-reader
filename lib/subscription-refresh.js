import { ReaderError } from './errors.js'
import { isJsRule, normalizeSource } from './rules.js'

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

function collectRuleStrings(value, strings) {
  if (typeof value === 'string') strings.push(value)
  else if (Array.isArray(value)) value.forEach(item => collectRuleStrings(item, strings))
  else if (value && typeof value === 'object') Object.values(value).forEach(item => collectRuleStrings(item, strings))
}

function originOf(value) {
  if (typeof value !== 'string') return null
  const candidate = value.replace(/\{\{[^}]*\}\}/g, 'x').trim()
  if (!/^https?:\/\//i.test(candidate)) return null
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

function addCapability(capabilities, origin, capability) {
  if (!origin) return
  const existing = capabilities.get(origin) ?? new Set()
  existing.add(capability)
  capabilities.set(origin, existing)
}

export function sourcePermissionProfile(sources = []) {
  const origins = new Set()
  const capabilities = new Map()
  for (const source of sources) {
    const sourceOrigin = originOf(source?.bookSourceUrl)
    if (sourceOrigin) origins.add(sourceOrigin)
    const sourceOrigins = new Set(sourceOrigin ? [sourceOrigin] : [])
    const strings = []
    collectRuleStrings(source?.rules ?? {}, strings)
    for (const rule of strings) {
      if (isJsRule(rule)) addCapability(capabilities, sourceOrigin, 'js')
      for (const match of rule.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) {
        const origin = originOf(match)
        if (origin) {
          origins.add(origin)
          sourceOrigins.add(origin)
        }
      }
    }
    if (source?.rules && JSON.stringify(source.rules).match(/"method"\s*:\s*"POST"/)) {
      for (const origin of sourceOrigins) addCapability(capabilities, origin, 'post')
    }
    for (const origin of sourceOrigins) if (origin.startsWith('http://')) addCapability(capabilities, origin, 'http')
  }
  return {
    origins: [...origins].sort(),
    capabilities: [...capabilities.entries()]
      .map(([origin, values]) => ({ origin, capabilities: [...values].sort() }))
      .sort((left, right) => left.origin.localeCompare(right.origin)),
  }
}

export function permissionExpansion(activeSources, candidateSources) {
  const active = sourcePermissionProfile(activeSources)
  const candidate = sourcePermissionProfile(candidateSources)
  const activeOrigins = new Set(active.origins)
  const activeCapabilities = new Map(active.capabilities.map(item => [item.origin, new Set(item.capabilities)]))
  const origins = candidate.origins.filter(origin => !activeOrigins.has(origin))
  const newOrigins = new Set(origins)
  const capabilities = candidate.capabilities
    .filter(item => !newOrigins.has(item.origin))
    .map(item => {
      const before = activeCapabilities.get(item.origin) ?? new Set()
      return { origin: item.origin, capabilities: item.capabilities.filter(capability => !before.has(capability)) }
    })
    .filter(item => item.capabilities.length)
  if (!origins.length && !capabilities.length) return null
  return { origins, capabilities }
}

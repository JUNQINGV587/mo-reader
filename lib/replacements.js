import { ReaderError } from './errors.js'
import { id } from './utils.js'

export function normalizeReplacements(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) throw new ReaderError('reader/invalid-settings', 'replacements 必须是最多 200 条的数组。')
  return value.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new ReaderError('reader/invalid-settings', `替换规则 ${index + 1} 不是对象。`)
    const pattern = rule.pattern ?? rule.from
    const replacement = rule.replacement ?? rule.to ?? ''
    if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 1000 || typeof replacement !== 'string' || replacement.length > 10000) {
      throw new ReaderError('reader/invalid-settings', `替换规则 ${index + 1} 的 pattern/replacement 无效。`)
    }
    const type = rule.type ?? (rule.regex ? 'regex' : 'text')
    if (!['regex', 'text'].includes(type)) throw new ReaderError('reader/invalid-settings', `替换规则 ${index + 1} 仅支持 regex/text。`)
    const flags = rule.flags ?? 'g'
    if (!/^[gimuy]*$/.test(flags)) throw new ReaderError('reader/invalid-settings', `替换规则 ${index + 1} 的 flags 无效。`)
    if (type === 'regex') {
      try {
        new RegExp(pattern, flags)
      } catch (error) {
        throw new ReaderError('reader/invalid-settings', `替换规则 ${index + 1} 不是合法正则。`, undefined, { cause: error })
      }
    }
    return { id: typeof rule.id === 'string' ? rule.id : id('replace'), type, pattern, replacement, flags, enabled: rule.enabled !== false }
  })
}

export function applyReplacements(text, rules = []) {
  let result = String(text)
  for (const rule of normalizeReplacements(rules)) {
    if (!rule.enabled) continue
    if (rule.type === 'regex') result = result.replace(new RegExp(rule.pattern, rule.flags), rule.replacement)
    else result = result.split(rule.pattern).join(rule.replacement)
  }
  return result.trim()
}

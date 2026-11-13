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

function applyCompiled(text, rules, trim) {
  let result = String(text)
  for (const rule of rules) {
    if (rule.type === 'regex') result = result.replace(new RegExp(rule.pattern, rule.flags), rule.replacement)
    else result = result.split(rule.pattern).join(rule.replacement)
  }
  return trim ? result.trim() : result
}

export function applyReplacements(text, rules = []) {
  return applyCompiled(text, normalizeReplacements(rules).filter(rule => rule.enabled), true)
}

// 一次编译所有规则，逐块复用；代码块保留缩进，其余块沿用正文的 trim 语义。
export function applyReplacementsToBlocks(blocks, rules = []) {
  if (!Array.isArray(blocks)) return blocks
  const compiled = normalizeReplacements(rules).filter(rule => rule.enabled)
  return blocks.map(block => {
    if (!block || typeof block !== 'object') return block
    if (block.type === 'image') return block
    if (block.type === 'list') {
      return {
        ...block,
        items: Array.isArray(block.items) ? block.items.map(item => applyCompiled(item, compiled, true)) : [],
      }
    }
    if (typeof block.text === 'string') {
      return { ...block, text: applyCompiled(block.text, compiled, block.type !== 'code') }
    }
    return block
  })
}

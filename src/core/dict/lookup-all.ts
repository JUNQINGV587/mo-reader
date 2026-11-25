/**
 * 并发查询所有启用的字典。
 *
 * 阅读页和「书源 → 字典规则」的试查共用这一份编排：结果顺序与规则顺序一致，
 * 单本失败被 Promise.allSettled 隔离在它自己的结果里，不会影响其他字典。
 */
export interface EnabledRuleLike {
  id: string
  name?: string
  enabled?: boolean
}

/** 单本字典查询成功时由服务端返回的内容。 */
export interface DictLookupPayload {
  name?: string
  text?: string
  url?: string
}

export interface DictLookupOutcome {
  id: string
  name: string
  ok: boolean
  text?: string
  url?: string
  error?: string
}

export type DictLookupFn = (
  ruleId: string,
  key: string,
) => Promise<DictLookupPayload | undefined>

/** 停用的字典不参与查询。 */
export function enabledDictRules<T extends EnabledRuleLike>(rules: readonly T[]): T[] {
  return rules.filter((rule) => rule.enabled !== false)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

export async function lookupAll(
  rules: readonly EnabledRuleLike[],
  key: string,
  lookup: DictLookupFn,
): Promise<DictLookupOutcome[]> {
  const enabled = enabledDictRules(rules)
  if (enabled.length === 0) return []

  const settled = await Promise.allSettled(enabled.map((rule) => lookup(rule.id, key)))
  return settled.map((result, index) => {
    const rule = enabled[index]
    const fallbackName = rule.name || '未命名字典'
    if (result.status === 'fulfilled') {
      const value = result.value
      return {
        id: rule.id,
        name: value?.name || fallbackName,
        ok: true,
        text: value?.text,
        url: value?.url,
      }
    }
    return {
      id: rule.id,
      name: fallbackName,
      ok: false,
      error: errorMessage(result.reason),
    }
  })
}

/**
 * 发现页只依赖的分组工具。放在独立模块里，避免浏览器端因为引一个纯函数
 * 而把 explore.ts 的 Node 依赖（node:net 等）拖进客户端 bundle。
 */
export interface ExploreGrouped<T> {
  name: string
  items: T[]
}

/** 空/空白分组在发现页统一显示为「未分组」。 */
export const UNGROUPED_SOURCE_GROUP = '未分组'

/**
 * 发现页按「书源分组 → 书源 → 分类」组织：空/空白分组归入「未分组」并排在最后，
 * 组内保持传入顺序（服务端已按分组/名称排序，界面只做稳定分组）。
 */
export function groupExploreBySourceGroup<T>(
  items: readonly T[],
  groupOf: (item: T) => unknown,
): ExploreGrouped<T>[] {
  const groups: ExploreGrouped<T>[] = []
  const positions = new Map<string, number>()
  for (const item of items) {
    const raw = groupOf(item)
    const name = typeof raw === 'string' && raw.trim() ? raw.trim() : UNGROUPED_SOURCE_GROUP
    let position = positions.get(name)
    if (position === undefined) {
      position = groups.length
      positions.set(name, position)
      groups.push({ name, items: [] })
    }
    groups[position]!.items.push(item)
  }
  const ungroupedIndex = groups.findIndex((group) => group.name === UNGROUPED_SOURCE_GROUP)
  if (ungroupedIndex >= 0 && ungroupedIndex !== groups.length - 1) {
    const [ungrouped] = groups.splice(ungroupedIndex, 1)
    if (ungrouped) groups.push(ungrouped)
  }
  return groups
}

/**
 * 字典规则上下移动时的排序值交换。
 *
 * 规则可能来自 Legado 导入，`customOrder` 允许稀疏（例如 5/6/7），因此不能按
 * 列表位置重写，否则会把顺序打乱；这里交换两条规则的实际排序值。任一条缺失
 * 或非有限数时，退回按列表位置（index+1 / target+1）兜底，保证旧数据也能移动。
 */
export interface DictOrderSwap {
  /** 当前规则交换后的 customOrder。 */
  currentOrder: number
  /** 目标规则交换后的 customOrder。 */
  otherOrder: number
}

function finiteOrder(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function swapDictOrder(
  current: { customOrder?: unknown } | null | undefined,
  other: { customOrder?: unknown } | null | undefined,
  index: number,
  target: number,
): DictOrderSwap {
  const currentOrder = finiteOrder(current?.customOrder)
  const otherOrder = finiteOrder(other?.customOrder)
  if (currentOrder === null || otherOrder === null) {
    return { currentOrder: target + 1, otherOrder: index + 1 }
  }
  return { currentOrder: otherOrder, otherOrder: currentOrder }
}

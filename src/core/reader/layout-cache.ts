/**
 * 排版缓存与可取消的排版任务。
 *
 * 缓存键 = 章节内容哈希 + 设置哈希 + 视口，三者任一变化都重新排版。
 * 排版是同步 CPU 活，用宏任务延后一帧启动：先让加载态画出来，
 * 启动前取消的任务不会白跑。
 */

export interface LayoutViewport {
  width: number
  height: number
}

export function hashText(text: string): string {
  // FNV-1a 32 位；内容变化时碰撞概率可忽略
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 稳定序列化：对象键排序，同一个设置对象不论键序都得到同一个串。 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map((item) => stableStringify(item)).join(',') + ']'
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts = keys
      .filter((key) => record[key] !== undefined && typeof record[key] !== 'function')
      .map((key) => JSON.stringify(key) + ':' + stableStringify(record[key]))
    return '{' + parts.join(',') + '}'
  }
  return 'null'
}

export function hashSettings(settings: unknown): string {
  return hashText(stableStringify(settings))
}

export function viewportKey(viewport: LayoutViewport): string {
  return Math.round(Math.max(1, viewport.width)) + 'x' + Math.round(Math.max(1, viewport.height))
}

export function layoutCacheKey(input: {
  text: string
  settings: unknown
  viewport: LayoutViewport
}): string {
  return [
    hashText(input.text),
    hashSettings(input.settings),
    viewportKey(input.viewport),
  ].join(':')
}

/** 简单的 LRU 缓存；容量按排版结果条数算。 */
export class LayoutCache<T> {
  private readonly capacity: number
  private readonly entries = new Map<string, T>()

  constructor(capacity = 8) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  get size(): number {
    return this.entries.size
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}

export class LayoutCancelledError extends Error {
  constructor() {
    super('layout cancelled')
    this.name = 'LayoutCancelledError'
  }
}

export interface LayoutJob<T> {
  promise: Promise<T>
  cancel: () => void
  readonly cancelled: boolean
}

/** 延后一帧启动的排版任务；启动前取消则直接作废。 */
export function createLayoutJob<T>(work: () => T): LayoutJob<T> {
  let cancelled = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let rejectRef: ((reason: unknown) => void) | null = null
  const promise = new Promise<T>((resolve, reject) => {
    rejectRef = reject
    timer = setTimeout(() => {
      timer = null
      if (cancelled) {
        settled = true
        reject(new LayoutCancelledError())
        return
      }
      settled = true
      try {
        resolve(work())
      } catch (error) {
        reject(error)
      }
    }, 0)
  })
  return {
    promise,
    get cancelled() {
      return cancelled
    },
    cancel: () => {
      if (settled) return
      cancelled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      settled = true
      rejectRef?.(new LayoutCancelledError())
      rejectRef = null
    },
  }
}

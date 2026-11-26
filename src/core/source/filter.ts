/**
 * 书源列表筛选：把分组、域名、登录要求、发现能力的判断收成纯函数，
 * 供界面与测试共用，避免在模板里堆条件。
 */

export type SourceLoginFilter = 'all' | 'required' | 'none'

export interface SourceFilterInput {
  bookSourceUrl?: unknown
  bookSourceName?: unknown
  bookSourceGroup?: unknown
  loginUrl?: unknown
  loginUi?: unknown
  loginCheckJs?: unknown
  enabledExplore?: unknown
  exploreUrl?: unknown
}

export interface SourceFilterOptions {
  key?: string
  group?: string
  domain?: string
  login?: SourceLoginFilter
  exploreOnly?: boolean
}

function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** 书源域名（含端口），用于域名筛选；非法 URL 返回空串。 */
export function sourceHost(url: unknown): string {
  if (typeof url !== 'string' || !url.trim()) return ''
  try {
    return new URL(url.trim()).host
  } catch {
    return ''
  }
}

/** 需要登录：任意登录字段非空即视为需要登录（与旧界面「需登录」标记一致）。 */
export function needsLogin(source: SourceFilterInput): boolean {
  return filled(source.loginUrl) || filled(source.loginUi) || filled(source.loginCheckJs)
}

/**
 * 发现开关：未设置视为未开启。界面筛选、发现列表与分类解析共用，
 * 避免「筛选里隐藏、发现页却列出」的不一致。
 */
export function isExploreEnabled(source: SourceFilterInput): boolean {
  return source.enabledExplore === true
}

/** 有发现：开启发现且填写了发现地址。 */
export function hasExplore(source: SourceFilterInput): boolean {
  return isExploreEnabled(source) && filled(source.exploreUrl)
}

export function filterSources<T extends SourceFilterInput>(
  sources: readonly T[],
  options: SourceFilterOptions = {},
): T[] {
  const key = (options.key ?? '').trim().toLowerCase()
  const group = options.group ?? ''
  const domain = options.domain ?? ''
  const login = options.login ?? 'all'
  return sources.filter((source) => {
    if (key) {
      const haystack = [source.bookSourceName, source.bookSourceUrl, source.bookSourceGroup]
        .filter((value): value is string => typeof value === 'string')
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(key)) return false
    }
    if (group && source.bookSourceGroup !== group) return false
    if (domain && sourceHost(source.bookSourceUrl) !== domain) return false
    if (login === 'required' && !needsLogin(source)) return false
    if (login === 'none' && needsLogin(source)) return false
    if (options.exploreOnly && !hasExplore(source)) return false
    return true
  })
}

export const SUBSCRIPTION_ENTRY_LIMIT = 500

function publishedTime(value) {
  const text = String(value ?? '').trim()
  if (!text) return NaN
  return Date.parse(text)
}

function byUrl(chapters) {
  return new Map((chapters || []).filter(chapter => chapter?.url).map(chapter => [chapter.url, chapter]))
}

// 订阅只增不删。锚点还留在首页时，锚点之前的条目就是新增；
// 锚点滚出首页后只能用发布时间兜底：时间缺失，或锚点边界上出现无法判定的重复，本轮不改目录。
export function decideSubscriptionAdditions({ fresh = [], old = [], anchorUrl = null } = {}) {
  const oldByUrl = byUrl(old)
  const first = fresh[0]
  const anchorIndex = anchorUrl ? fresh.findIndex(chapter => chapter.url === anchorUrl) : -1
  if (anchorIndex >= 0) {
    return {
      additions: fresh.slice(0, anchorIndex).filter(chapter => !oldByUrl.has(chapter.url)),
      anchorUrl: first?.url ?? anchorUrl,
      reason: null,
    }
  }
  if (!anchorUrl) {
    return {
      additions: fresh.filter(chapter => !oldByUrl.has(chapter.url)),
      anchorUrl: first?.url ?? null,
      reason: null,
    }
  }
  const cachedAnchor = oldByUrl.get(anchorUrl)
  if (!cachedAnchor) {
    return { additions: [], anchorUrl, reason: '锚点条目已不在旧目录里，无法判断新条目，本轮先不改目录。' }
  }
  const anchorTime = publishedTime(cachedAnchor.publishedAt)
  if (!Number.isFinite(anchorTime)) {
    return { additions: [], anchorUrl, reason: '订阅源的最新条目已滚出首页，且旧锚点没有可用的发布时间，本轮先不改目录。' }
  }
  const times = []
  for (const chapter of fresh) {
    const time = publishedTime(chapter.publishedAt)
    if (!Number.isFinite(time)) {
      return { additions: [], anchorUrl, reason: '订阅源的最新条目已滚出首页，且发布时间不完整，本轮先不改目录。' }
    }
    times.push(time)
  }
  // 只有「和锚点同一时间、又不在旧目录里」的新条目才真正无法判断先后；
  // 明确比锚点新的条目即使时间相同，也可以全部收下。
  const boundaryAmbiguous = fresh.some((chapter, position) => times[position] === anchorTime && !oldByUrl.has(chapter.url))
  if (boundaryAmbiguous) {
    return { additions: [], anchorUrl, reason: '订阅源的最新条目已滚出首页，且锚点时间附近有新条目，无法确定先后，本轮先不改目录。' }
  }
  const additions = fresh.filter((chapter, position) => !oldByUrl.has(chapter.url) && times[position] > anchorTime)
  const firstTime = times[0]
  const nextAnchor = first && (firstTime > anchorTime || (firstTime === anchorTime && oldByUrl.has(first.url))) ? first.url : anchorUrl
  return { additions, anchorUrl: nextAnchor, reason: null }
}

// 新条目按抓取顺序放在最前，旧条目保持原有阅读顺序；同一 URL 用新元数据刷新，但保留本地载荷与已读状态。
export function mergeSubscriptionChapters({ old = [], additions = [], fresh = [], bookId } = {}) {
  const oldByUrl = byUrl(old)
  const freshByUrl = byUrl(fresh)
  const additionUrls = new Set(additions.map(chapter => chapter.url))
  const merged = []
  for (const chapter of additions) {
    const cached = oldByUrl.get(chapter.url)
    merged.push({
      ...(cached || {}),
      ...chapter,
      ...(cached ? { id: cached.id, index: cached.index } : {}),
      bookId,
      contentType: 'subscription',
    })
  }
  for (const cached of old) {
    if (additionUrls.has(cached.url)) continue
    const next = freshByUrl.get(cached.url)
    merged.push(next
      ? { ...cached, ...next, id: cached.id, index: cached.index, bookId, contentType: 'subscription' }
      : { ...cached, bookId, contentType: 'subscription' })
  }
  return merged.map((chapter, index) => ({ ...chapter, index }))
}

// 超过上限时只删「已读、未下载、不是当前进度、不是追更锚点」的最旧条目。
// 已下载以 offline 为准：downloadedAt 只是「读的时候缓存过」，不代表用户下载了。
// 受保护的条目一条都不删，所以结果可能暂时超过上限。
export function pruneSubscriptionChapters({ chapters = [], limit = SUBSCRIPTION_ENTRY_LIMIT, progressChapterId = null, anchorUrl = null } = {}) {
  const next = [...chapters]
  const removed = []
  let cursor = next.length - 1
  while (next.length > limit && cursor >= 0) {
    const chapter = next[cursor]
    const removable = Boolean(chapter.readAt) && !chapter.offline && chapter.id !== progressChapterId && chapter.url !== anchorUrl
    if (removable) {
      removed.push(chapter)
      next.splice(cursor, 1)
    }
    cursor -= 1
  }
  return { chapters: next.map((chapter, index) => ({ ...chapter, index })), removed }
}

// 搜索结果点开时单独插入一条：按发布时间放到正确位置，不重排旧条目；
// 同一 URL 已存在就只更新元数据，避免重复建条目。
export function insertSubscriptionEntry({ chapters = [], entry } = {}) {
  const list = [...chapters]
  const existing = list.findIndex(chapter => chapter.url === entry.url)
  if (existing >= 0) {
    const current = list[existing]
    const next = { ...current, ...entry, id: current.id, index: current.index }
    list[existing] = next
    return { chapters: list.map((chapter, index) => ({ ...chapter, index })), entry: next, added: false }
  }
  const time = publishedTime(entry.publishedAt)
  let position = 0
  if (Number.isFinite(time)) {
    position = list.findIndex(chapter => {
      const other = publishedTime(chapter.publishedAt)
      return !Number.isFinite(other) || other < time
    })
    if (position < 0) position = list.length
  }
  const chapter = { ...entry, index: position }
  list.splice(position, 0, chapter)
  return { chapters: list.map((item, index) => ({ ...item, index })), entry: chapter, added: true }
}

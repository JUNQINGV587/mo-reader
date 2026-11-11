import React from 'react'
import { createRoot } from 'react-dom/client'
import { z } from 'zod'

let registration
window.__ModuleLoader__ = { load(config) { registration = config } }
globalThis.__MO_READER_TEST__ = true
await import('../../client.js')
const require = (id) => {
  if (id === 'react') return React
  if (id === 'zod') return { z }
  throw new Error(`unexpected require: ${id}`)
}
const { ShelfBoard, readerStyle } = registration.factory(require).__test
const style = document.createElement('style')
style.textContent = readerStyle
document.head.append(style)

const h = React.createElement
const books = Array.from({ length: 73 }, (_, index) => ({
  id: `book-${String(index + 1).padStart(2, '0')}`,
  name: `窗边藏书 ${index + 1}`,
  author: `作者 ${index % 7 + 1}`,
  createdAt: new Date(2025, 0, index + 1).toISOString(),
  lastReadAt: index % 3 === 0 ? new Date(2026, 0, index + 1).toISOString() : null,
  lastRead: index % 3 === 0 ? { chapterId: 'c1', percent: index + 1 } : null,
  progress: index % 3 === 0 ? { chapterId: 'c1', percent: index + 1 } : null,
  unreadCount: index % 5 === 0 ? 2 : 0,
  downloadStatus: index % 4 === 0 ? 'completed' : null,
  folderId: index % 6 === 0 ? 'window' : null,
}))
const folders = [{ id: 'window', name: '窗边' }]
const counters = window.__shelfCounters = { open: 0, toggle: 0, select: 0 }
const host = document.createElement('div')
host.style.cssText = 'position:fixed;inset:0'
document.body.append(host)
const root = createRoot(host)
const noop = () => {}
let shelfReducedMotion = true
let markReadShouldFail = false
function fixture(items) {
  return h('div', { className: 'mr-root' },
    h('nav', { className: 'mr-nav', 'aria-label': '墨读' },
      h('div', { className: 'mr-brand' }, '墨'),
      h('div', { className: 'mr-nav-items' }, ['书架', '发现', '书源', '设置'].map((name, index) => h('button', { className: index === 0 ? 'active' : '', key: name }, name)))),
    h('section', { className: 'mr-content' }, h(ShelfBoard, {
      books: items,
      folders,
      reducedMotion: shelfReducedMotion,
      onOpen: () => { counters.open += 1 },
      onCheck: noop,
      onDownload: noop,
      onRemove: noop,
      onCheck: noop,
      onToggleDownload: () => { counters.toggle += 1 },
      onSearchOnline: async () => [],
      onAddOnline: noop,
      onCreateFolder: noop,
      onRenameFolder: noop,
      onRemoveFolder: noop,
      onMoveToFolder: noop,
      onBatchDelete: noop,
      onBatchDownload: noop,
      onExport: noop,
      onMarkRead: () => new Promise((resolve, reject) => setTimeout(() => {
        if (markReadShouldFail) reject(new Error('测试标记失败'))
        else resolve()
      }, 40)),
      onSelectMode: () => { counters.select += 1 },
    })))
}
root.render(fixture(books))
window.__updateShelfBooks = (items) => root.render(fixture(items))
window.__setShelfReducedMotion = (value) => { shelfReducedMotion = value; root.render(fixture(books)) }

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
async function waitFor(predicate, message, timeout = 5000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (predicate()) return
    await frame()
  }
  throw new Error(typeof message === 'function' ? message() : message)
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const page = () => document.querySelector(window.innerWidth <= 760 ? '.mr-shelf-mobile-page' : '.mr-shelf-grid:not(.mr-mobile-track)')
const firstId = () => page()?.querySelector('[data-book-id]')?.getAttribute('data-book-id')
const clickText = (selector, text) => {
  const element = [...document.querySelectorAll(selector)].find((node) => {
    const label = node.textContent.trim()
    return label === text || label.startsWith(text)
  })
  assert(element, `找不到按钮 ${text}`)
  element.click()
}
async function settled() {
  await frame()
  await frame()
  await new Promise((resolve) => setTimeout(resolve, 30))
}

async function longPressBook() {
  const node = page().querySelector('[data-book-id]')
  assert(node, '找不到可长按的书籍')
  const rect = node.getBoundingClientRect()
  const init = { bubbles: true, pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, buttons: 1 }
  node.dispatchEvent(new PointerEvent('pointerdown', init))
  await new Promise((resolve) => setTimeout(resolve, 600))
  node.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }))
  await settled()
}
function assertDesktopThemeAndWidth() {
  const content = document.querySelector('.mr-content')
  const shelf = document.querySelector('.mr-window-shelf')
  const contentStyle = getComputedStyle(content)
  const availableWidth = content.clientWidth - parseFloat(contentStyle.paddingLeft) - parseFloat(contentStyle.paddingRight)
  assert(Math.abs(shelf.getBoundingClientRect().width - availableWidth) < 2, `书架没有使用内容区全宽：${shelf.getBoundingClientRect().width}/${availableWidth}`)
  const search = document.querySelector('.mr-shelf-search')
  const input = search.querySelector('input')
  assert(getComputedStyle(search).backgroundColor === getComputedStyle(input).backgroundColor, '搜索框内外底色不一致')
}
function metrics() {
  const current = page()
  const styles = getComputedStyle(current)
  const columns = Number(styles.getPropertyValue('--shelf-columns'))
  const rows = Number(styles.getPropertyValue('--shelf-rows'))
  return {
    columns,
    rows,
    capacity: columns * rows,
    books: current.querySelectorAll('[data-book-id]').length,
    pages: document.querySelectorAll('.mr-shelf-mobile-page').length,
    navWidth: document.querySelector('.mr-nav').getBoundingClientRect().width,
    wallWidth: document.querySelector('.mr-shelf-wall').getBoundingClientRect().width,
    wallHeight: document.querySelector('.mr-shelf-wall').getBoundingClientRect().height,
    first: firstId(),
  }
}

window.shelfTest = {
  async desktopStart() {
    await waitFor(() => page()?.querySelector('[data-book-id]'), '桌面书架未渲染')
    await settled()
    assert(!document.querySelector('.mr-shelf-filter'), '仍显示书架筛选栏')
    assert(!document.querySelector('.mr-shelf-foot'), '仍显示书架底部统计')
    const firstPiece = page().querySelector('.mr-shelf-piece')
    const firstCover = firstPiece.querySelector('.mr-shelf-cover').getBoundingClientRect()
    const firstCap = firstPiece.querySelector('.mr-shelf-cap').getBoundingClientRect()
    assert(Math.abs(firstCover.left - firstCap.left) < 2, `书名与封面左缘未对齐：${firstCover.left}/${firstCap.left}`)
    const value = metrics()
    assert(value.navWidth === 84, `共用导航不是 84px：${value.navWidth}`)
    assert(value.columns >= 3 && value.columns <= 8, `桌面列数越界：${value.columns}`)
    assertDesktopThemeAndWidth()
    assert(value.rows >= 1 && value.rows <= 3, `桌面行数越界：${value.rows}`)
    assert(value.books === value.capacity, `首页容量不匹配：${JSON.stringify(value)}，page=${page().dataset.page}，dataCapacity=${page().dataset.capacity}`)
    assert(document.querySelectorAll('.mr-shelf-pager button[aria-current="page"]').length === 1, '桌面没有真实分页')
    const wall = document.querySelector('.mr-shelf-wall')
    const pager = document.querySelector('.mr-shelf-pager')
    const wallRect = wall.getBoundingClientRect()
    const pagerRect = pager.getBoundingClientRect()
    const gridRect = page().getBoundingClientRect()
    assert(wall.contains(pager), '页码不在书架浏览区内')
    assert(pagerRect.left >= wallRect.left && pagerRect.right <= wallRect.right + 1, '页码超出书架浏览区')
    assert(gridRect.height > 100, `书籍区高度异常：${gridRect.height}`)
    assert(gridRect.bottom <= pagerRect.top + 1, `书籍与页码重叠：${gridRect.bottom}/${pagerRect.top}`)
    const coverRect = page().querySelector('.mr-shelf-cover').getBoundingClientRect()
    assert(Math.abs(coverRect.width / coverRect.height - 2 / 3) < 0.03, `桌面封面比例失调：${coverRect.width}/${coverRect.height}`)
    clickText('.mr-shelf-pager button', '2')
    await waitFor(() => firstId() && firstId() !== value.first, '第二页没有更新')
    window.__shelfAnchor = firstId()
    window.__shelfGeometry = `${metrics().columns}x${metrics().rows}`
    return { ...metrics(), anchor: window.__shelfAnchor }
  },
  async afterResize() {
    await waitFor(() => [...page().querySelectorAll('[data-book-id]')].some((node) => node.dataset.bookId === window.__shelfAnchor), () => `resize 未保留当前书：${innerWidth}x${innerHeight}，当前=${JSON.stringify(metrics())}，期望几何=${window.__shelfGeometry}，anchor=${window.__shelfAnchor}，first=${firstId()}`)
    await settled()
    const ids = [...page().querySelectorAll('[data-book-id]')].map((node) => node.dataset.bookId)
    assert(ids.includes(window.__shelfAnchor), `连续 resize 锚点漂移：${JSON.stringify(metrics())} 不含 ${window.__shelfAnchor}`)
    window.__shelfGeometry = `${metrics().columns}x${metrics().rows}`
    assertDesktopThemeAndWidth()
    return metrics()
  },
  async desktopMotion() {
    window.__setShelfReducedMotion(false)
    await settled()
    clickText('.mr-shelf-pager button', '→')
    await waitFor(() => document.querySelector('.mr-shelf-grid.mr-page-next'), '下一页没有进入方向动画')
    const nextStyle = getComputedStyle(document.querySelector('.mr-shelf-grid.mr-page-next'))
    const nextDuration = nextStyle.animationDuration
    assert(nextStyle.animationName === 'mrShelfPageNext', `下一页动画名错误：${nextStyle.animationName}`)
    assert(nextDuration === '0.22s', `下一页动画时长错误：${nextDuration}`)
    await waitFor(() => !document.querySelector('.mr-shelf-grid.mr-page-next'), '下一页动画没有结束')
    clickText('.mr-shelf-pager button', '←')
    await waitFor(() => document.querySelector('.mr-shelf-grid.mr-page-prev'), '上一页没有进入方向动画')
    assert(getComputedStyle(document.querySelector('.mr-shelf-grid.mr-page-prev')).animationName === 'mrShelfPagePrev', '上一页动画方向错误')
    await waitFor(() => !document.querySelector('.mr-shelf-grid.mr-page-prev'), '上一页动画没有结束')
    window.__setShelfReducedMotion(true)
    await settled()
    clickText('.mr-shelf-pager button', '→')
    await settled()
    assert(!document.querySelector('.mr-shelf-grid.mr-page-next,.mr-shelf-grid.mr-page-prev'), '减少动态效果时仍播放翻页动画')
    return { next: 'mrShelfPageNext', prev: 'mrShelfPagePrev', duration: nextDuration, reducedMotion: true }
  },
  async pollingAndSelection() {
    const anchor = firstId()
    window.__updateShelfBooks([{ id: 'polling-new', name: '轮询新书', updatedAt: '2027-01-01T00:00:00.000Z' }, ...books])
    await waitFor(() => [...page().querySelectorAll('[data-book-id]')].some((node) => node.dataset.bookId === anchor), 'polling 后没有按 ID 找回 anchor')
    window.__updateShelfBooks(books)
    await waitFor(() => [...page().querySelectorAll('[data-book-id]')].some((node) => node.dataset.bookId === anchor), 'polling 恢复后 anchor 漂移')
    await longPressBook()
    const initialSelect = document.querySelector('.mr-select-bar')?.textContent
    assert(initialSelect?.includes('全选 (1/'), `长按没有选中当前书：${initialSelect}`)
    assert(document.querySelectorAll('.mr-select-actions .mr-button').length === 5, '多选操作数量不对')
    assert(document.querySelector('.mr-select-bar')?.getAttribute('role') === 'toolbar', '多选栏缺少工具栏语义')
    const checkbox = document.querySelector('.mr-select-all input')
    checkbox.click()
    await settled()
    const text = document.querySelector('.mr-select-bar').textContent
    const rootBookCount = books.filter((book) => !book.folderId).length
    assert(text.includes(`全选 (${rootBookCount}/${rootBookCount})`), `全选不是当前书库的全部结果：${text}`)
    document.querySelector('.mr-select-close').click()
    await waitFor(() => !document.querySelector('.mr-select-bar'), '关闭后多选栏仍显示')
    await settled()
    clickText('.mr-shelf-pager button', '2')
    await waitFor(() => document.querySelector('.mr-shelf-pager [aria-current="page"]')?.textContent === '2', '搜索前未进入第二页')
    const input = document.querySelector('.mr-shelf-search input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '窗边')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(() => document.querySelector('.mr-shelf-pager [aria-current="page"]')?.textContent === '1', '搜索后没有回第一页')
    assert(!document.querySelector('.mr-shelf-hero'), '搜索后 hero 仍显示')
    document.querySelector('.mr-shelf-search-clear').click()
    await settled()

    clickText('.mr-shelf-pager button', '2')
    await waitFor(() => document.querySelector('.mr-shelf-pager [aria-current="page"]')?.textContent === '2', '文件夹前未进入第二页')
    clickText('.mr-folder-chip', '窗边')
    await waitFor(() => document.querySelector('.mr-shelf-pager [aria-current="page"]')?.textContent === '1', '文件夹后没有回第一页')
    assert(!document.querySelector('.mr-shelf-hero'), '文件夹后 hero 仍显示')
    clickText('.mr-folder-chip', '书库')
    await settled()
    return { selectedAcrossPages: books.length, updates: null, resetOperations: ['search', 'folder'] }
  },
  async tallFilter() {
    await settled()
    await settled()
    const value = metrics()
    assert(value.rows >= 2 && value.rows <= 3, `桌面高度行数错误：${JSON.stringify(value)}`)
    assert(value.books <= value.capacity, '尾页容量越界')
    const wall = document.querySelector('.mr-shelf-wall').getBoundingClientRect()
    const grid = page().getBoundingClientRect()
    const pager = document.querySelector('.mr-shelf-pager').getBoundingClientRect()
    assert(grid.bottom <= wall.bottom + 1, `书架网格超出可用高度：${grid.bottom}/${wall.bottom}`)
    assert(grid.bottom <= pager.top + 1, `书架网格与页码重叠：${grid.bottom}/${pager.top}`)
    return value
  },
  async mobileStart() {
    await waitFor(() => document.querySelectorAll('.mr-shelf-mobile-page').length > 1, '手机纵向内容未渲染')
    assert(!document.querySelector('.mr-shelf-hero'), '书架仍显示正在读 hero')
    await settled()
    const wallRect = document.querySelector('.mr-shelf-wall')
    const track = document.querySelector('.mr-mobile-track')
    const trackRect = track.getBoundingClientRect()
    assert(getComputedStyle(track).display === 'block', '手机书架不是纵向流')
    assert(track.scrollWidth <= track.clientWidth + 1, `手机书架仍有横向溢出：${track.scrollWidth}/${track.clientWidth}`)
    assert(document.querySelector('.mr-content').scrollHeight > document.querySelector('.mr-content').clientHeight + 100, '手机书架没有纵向滚动内容')
    const coverRect = document.querySelector('.mr-mobile-track .mr-shelf-cover').getBoundingClientRect()
    assert(Math.abs(coverRect.width / coverRect.height - 2 / 3) < 0.03, `手机封面比例失调：${coverRect.width}/${coverRect.height}`)
    assert(coverRect.width >= 90, `手机封面被过度压缩：${coverRect.width}`)
    const gridCount = books.filter((book) => !book.folderId).length
    const value = metrics()
    assert(value.columns === 3 && value.rows >= 2 && value.rows <= 3, `手机行数错误：${JSON.stringify(value)}`)
    const capacity = value.capacity
    const pages = [...document.querySelectorAll('.mr-shelf-mobile-page')]
    assert(pages.length === Math.ceil(gridCount / capacity), `手机页数错误：${pages.length}/${capacity}`)
    assert(pages.every((node, index) => node.querySelectorAll('[data-book-id]').length === (index === pages.length - 1 ? gridCount - capacity * (pages.length - 1) : capacity)), '手机每屏数量错误')
    const pager = document.querySelector('.mr-shelf-pager')
    assert(!pager || getComputedStyle(pager).display === 'none', '手机仍显示页码')
    assert(!document.querySelector('.mr-shelf-head-actions'), '书架头部动作行仍在')
    const back = document.querySelector('.mr-shelf-back')
    assert(back && back.getAttribute('aria-label') === '打开 DSH 侧栏', '书架缺少返回 DSH 按钮')
    const hostOpener = document.createElement('button')
    hostOpener.dataset.sidebarOpener = 'true'
    hostOpener.setAttribute('aria-label', '打开侧边栏')
    let hostOpenCount = 0
    hostOpener.addEventListener('click', () => { hostOpenCount += 1 })
    document.body.append(hostOpener)
    back.click()
    assert(hostOpenCount === 1, `返回按钮没有触发宿主侧栏开关：${hostOpenCount}`)
    assert(document.querySelector('.mr-root').style.zIndex === '50', '打开宿主侧栏前没有降低插件层级')
    hostOpener.remove()
    const refresh = document.querySelector('.mr-shelf-refresh')
    const search = document.querySelector('.mr-shelf-mobile-search-toggle')
    assert(refresh && search, '搜索旁缺少检查更新按钮')
    assert(back.getBoundingClientRect().left < search.getBoundingClientRect().left, '返回按钮未在搜索左侧')
    assert(refresh.getBoundingClientRect().left > search.getBoundingClientRect().right, '检查更新按钮未排在搜索旁')
    assert(refresh.getAttribute('aria-label') === '检查更新', '检查更新按钮语义错误')
    assert(!document.querySelector('.mr-shelf-filter'), '手机仍显示筛选栏')
    assert(!document.querySelector('.mr-shelf-foot'), '手机仍显示底部统计')
    const searchButton = document.querySelector('.mr-shelf-mobile-search-toggle')
    const closedSearchRect = searchButton.getBoundingClientRect()
    assert(closedSearchRect.left > innerWidth / 2, `手机搜索按钮没有靠右：${closedSearchRect.left}`)
    const firstPiece = document.querySelector('.mr-mobile-track .mr-shelf-piece')
    const newBadge = firstPiece?.querySelector('.mr-new-badge')?.getBoundingClientRect()
    const downloadBadge = firstPiece?.querySelector('.mr-dl-badge')?.getBoundingClientRect()
    const doneBadge = document.querySelector('.mr-mobile-track .mr-dl-badge.done')
    if (doneBadge) {
      assert(doneBadge.querySelector('svg'), '已下载状态没有使用轻量下载图标')
      const badgeRect = doneBadge.getBoundingClientRect()
      const ownCover = doneBadge.closest('.mr-shelf-cover-frame').getBoundingClientRect()
      assert(badgeRect.top >= ownCover.bottom, '已下载图标仍压在封面左下角')
    }
    if (newBadge && downloadBadge) {
      const overlap = !(newBadge.right <= downloadBadge.left || newBadge.left >= downloadBadge.right || newBadge.bottom <= downloadBadge.top || newBadge.top >= downloadBadge.bottom)
      assert(!overlap, '手机封面徽标互相重叠')
      assert(downloadBadge.width <= 22, `手机下载角标不够紧凑：${downloadBadge.width}`)
      assert((firstPiece.querySelector('.mr-dl-badge')?.getAttribute('aria-label') || '').includes('已下载'), '手机下载角标缺少可读标签')
    }
    searchButton.click()
    await waitFor(() => document.activeElement === document.querySelector('.mr-shelf-search input'), '手机搜索没有展开并聚焦')
    assert(!document.querySelector('.mr-shelf-head'), '书架标题仍显示')
    const openSearchRect = document.querySelector('.mr-shelf-search').getBoundingClientRect()
    const openInputRect = document.querySelector('.mr-shelf-search input').getBoundingClientRect()
    assert(openSearchRect.width > (innerWidth - 24) * 0.9, `手机搜索框未占满行：${openSearchRect.width}`)
    assert(openInputRect.height <= openSearchRect.height + 1, `手机搜索输入框溢出容器：${openInputRect.height}/${openSearchRect.height}`)
    assert(getComputedStyle(document.querySelector('.mr-shelf-search input')).backgroundColor === 'rgba(0, 0, 0, 0)', '手机搜索输入框仍是白色长条')
    assert(getComputedStyle(document.querySelector('.mr-shelf-search')).boxShadow === 'none', '手机搜索框仍有高亮外框')
    assert(openInputRect.width > 100, '手机搜索框输入区过窄')
    document.activeElement.blur()
    document.querySelector('.mr-shelf-mobile-search-toggle').click()
    await settled()
    await longPressBook()
    const selectedPiece = document.querySelector('.mr-shelf-piece[aria-pressed="true"]')
    assert(getComputedStyle(selectedPiece).outlineStyle === 'none', '选中外框仍然存在')
    assert(getComputedStyle(selectedPiece).transform !== 'none', '选中书没有放大层次')
    const selectedCheck = selectedPiece.querySelector('.mr-select-check')
    assert(selectedCheck?.classList.contains('mr-checked'), '选中书没有显示选中态')
    assert(!selectedCheck.querySelector('input'), '书卡仍在使用平台原生复选框')
    assert(getComputedStyle(selectedCheck).borderRadius === '50%', '书卡选择标记不是圆形')
    assert(!document.querySelector('.mr-selecting .mr-dl-badge'), '多选时仍显示下载勾，与选择圈混淆')
    const selectBar = document.querySelector('.mr-select-bar')
    const selectRect = selectBar.getBoundingClientRect()
    assert(getComputedStyle(selectBar).position === 'fixed', '手机多选栏没有悬浮在底部')
    assert(selectRect.bottom <= innerHeight - 56, `多选栏压住底部导航：${selectRect.bottom}/${innerHeight}`)
    assert(selectRect.left >= 0 && selectRect.right <= innerWidth, '多选栏超出屏幕')
    const actionWidths = [...document.querySelectorAll('.mr-select-actions .mr-button')].map((node) => node.getBoundingClientRect().width)
    assert(actionWidths.length === 5 && Math.max(...actionWidths) - Math.min(...actionWidths) < 2, `多选操作没有等宽排列：${actionWidths}`)
    assert(document.querySelector('.mr-selecting .mr-shelf-wall'), '多选时没有为悬浮栏预留内容空间')
    const markRead = [...document.querySelectorAll('.mr-select-actions button')].find((node) => node.textContent.includes('已读'))
    markRead.click()
    assert(document.querySelector('.mr-select-bar'), '操作尚未完成就提前退出了多选')
    await waitFor(() => !document.querySelector('.mr-select-bar'), '操作完成后仍停留在多选模式')
    assert(!document.querySelector('.mr-shelf-piece[aria-pressed="true"]'), '操作完成后没有清空选择')
    await settled()
    markReadShouldFail = true
    await longPressBook()
    const failedMarkRead = [...document.querySelectorAll('.mr-select-actions button')].find((node) => node.textContent.includes('已读'))
    failedMarkRead.click()
    await new Promise((resolve) => setTimeout(resolve, 90))
    assert(document.querySelector('.mr-select-bar'), '操作失败后错误退出了多选')
    assert(document.querySelector('.mr-shelf-piece[aria-pressed="true"]'), '操作失败后没有保留选择')
    markReadShouldFail = false
    document.querySelector('.mr-select-close').click()
    await settled()
    return { pages: pages.length, perPage: capacity, focused: true, vertical: true }
  },
  mobileSwipeResult() {
    const track = document.querySelector('.mr-mobile-track')
    return { scrollLeft: track.scrollLeft, ...counters }
  },
  async mobileTall() {
    if (document.querySelector('.mr-mobile-search-open')) {
      document.querySelector('.mr-shelf-mobile-search-toggle')?.click()
      await settled()
    }
    await settled()
    await settled()
    const value = metrics()
    assert(value.columns === 3 && value.rows === 3 && value.capacity === 9, `高屏没有 3×3：${JSON.stringify(value)}`)
    const rootBookCount = books.filter((book) => !book.folderId).length
    assert(document.querySelectorAll('.mr-shelf-mobile-page').length === Math.ceil(rootBookCount / value.capacity), '高屏书籍页数错误')
    const cover = document.querySelector('.mr-shelf-mobile-page .mr-shelf-cover').getBoundingClientRect()
    assert(Math.abs(cover.width / cover.height - 2 / 3) < 0.03, `高屏封面比例失调：${cover.width}/${cover.height}`)
    assert(cover.width >= 60, `高屏封面被过度压缩：${cover.width}`)
    assert(getComputedStyle(document.querySelector('.mr-mobile-track')).display === 'block', '高屏书架不是纵向流')
    const hero = document.querySelector('.mr-shelf-mobile-page .mr-shelf-piece')
    const badge = hero.querySelector('.mr-new-badge')?.getBoundingClientRect()
    const download = hero.querySelector('.mr-dl-badge')?.getBoundingClientRect()
    if (badge && download) {
      const overlap = !(badge.right <= download.left || badge.left >= download.right || badge.bottom <= download.top || badge.top >= download.bottom)
      assert(!overlap, '高屏封面徽标互相重叠')
      const coverRect = hero.querySelector('.mr-shelf-cover').getBoundingClientRect()
      assert(download.top >= coverRect.bottom, '下载图标仍压在封面内')
    }
    return value
  },
  async mobileSmall() {
    await settled()
    await settled()
    const value = metrics()
    assert(value.columns === 3 && value.rows >= 2 && value.rows <= 3, `小屏行数错误：${JSON.stringify(value)}`)
    const rootBookCount = books.filter((book) => !book.folderId).length
    assert(document.querySelectorAll('.mr-shelf-mobile-page').length === Math.ceil(rootBookCount / value.capacity), '小屏丢失书籍页')
    assert(!document.querySelector('.mr-shelf-head-actions'), '小屏仍显示头部动作行')
    const pages = [...document.querySelectorAll('.mr-shelf-mobile-page')]
    assert(pages.every(node => getComputedStyle(node).gridTemplateColumns.split(' ').length === 3), '小屏书架不是 3 列')
    assert(document.querySelector('.mr-content').scrollHeight > document.querySelector('.mr-content').clientHeight, '小屏书架不能纵向滚动')
    return value
  },
}
window.shelfReady = true

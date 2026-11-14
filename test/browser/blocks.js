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
window.__readerTest = registration.factory(require).__test
const style = document.createElement('style')
style.textContent = window.__readerTest.readerStyle
document.head.append(style)

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
async function waitFor(predicate, message, timeout = 6000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (predicate()) return
    await frame()
  }
  throw new Error(message)
}

const paragraph = Array.from({ length: 160 }, (_, index) =>
  `第 ${index + 1} 段：图文块回归只检查渲染顺序与语义标签，不连接真实站点。`,
).join('')
const blocks = [
  { type: 'heading', level: 2, text: '图文块回归' },
  { type: 'paragraph', text: paragraph },
  { type: 'quote', text: '引用也要有语义。' },
  { type: 'code', lang: 'js', text: 'const answer = 42' },
  { type: 'list', ordered: false, items: ['第一项', '第二项'] },
  { type: 'image', url: 'https://img.example/cover.png', alt: '封面图' },
]

window.blocksTest = (async () => {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;'
  document.body.append(host)
  const root = createRoot(host)
  try {
    const toc = [{ id: 'chapter-0', name: '图文块条目' }]
    const ctx = { remote: { reader: {
      toc: async () => toc,
      chapter: async () => ({ id: 'chapter-0', name: '图文块条目', contentType: 'subscription', blocks }),
      saveProgress: async () => ({}),
    } } }
    const book = {
      id: 'blocks-book', title: '图文块回归', contentType: 'subscription',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'chapter-0', percent: 0, offset: 0 },
    }
    const settings = {
      mode: 'scroll', ambience: 'off', animations: false, reducedMotion: 'on',
      fontSize: 20, lineHeight: 1.9, fontFamily: 'serif',
      readerTheme: 'paper', measureWidth: 800,
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      ctx, book, settings, notes: [], onClose() {},
    }))
    await waitFor(() => host.querySelectorAll('.mr-block-heading').length === 1, '标题块未渲染')
    const find = (selector) => host.querySelector(selector)
    const checks = []
    const check = (name, value) => { checks.push({ name, value }); if (!value) throw new Error(name) }
    check('标题语义', find('.mr-block-heading')?.tagName === 'H2')
    check('段落渲染', host.querySelectorAll('p').length > 0)
    check('引用语义', find('.mr-block-quote')?.tagName === 'BLOCKQUOTE')
    check('代码语义', find('.mr-block-code code')?.textContent === 'const answer = 42')
    check('列表语义', find('.mr-block-list')?.tagName === 'UL' && find('.mr-block-list').children.length === 2)
    check('图片留在文中', find('.mr-block-image img')?.getAttribute('src')?.includes('block=5'))
    check('图片走媒体代理', find('.mr-block-image img')?.getAttribute('src')?.startsWith('/api/reader/proxy?'))
    check('图注可见', find('.mr-block-image figcaption')?.textContent === '封面图')
    const scroller = find('.mr-chapter-scroll')
    check('出现滚动容器', !!scroller)
    check('长文可滚动', scroller.scrollHeight > scroller.clientHeight + 100)
    const order = [...host.querySelectorAll('.mr-block-heading, .mr-block-quote, .mr-block-code, .mr-block-list, .mr-block-image')]
      .map((node) => node.className)
    check('块顺序与正文一致', order.join('|') === 'mr-block-heading|mr-block-quote|mr-block-code|mr-block-list|mr-block-image')

    // 视频条目：订阅条目带 mediaUrl 时应渲染可直接播放的播放器，而不是空正文。
    const mediaCtx = { remote: { reader: {
      toc: async () => [{ id: 'video-0', name: '视频条目' }],
      chapter: async () => ({ id: 'video-0', name: '视频条目', contentType: 'subscription', mediaUrl: 'https://media.example/clip.mp4' }),
      saveProgress: async () => ({}),
    } } }
    const mediaBook = {
      id: 'video-book', title: '视频订阅回归', contentType: 'subscription',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'video-0', percent: 0, offset: 0 },
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      ctx: mediaCtx, book: mediaBook, settings, notes: [], onClose() {},
    }))
    await waitFor(() => host.querySelector('.mr-video-player video')?.getAttribute('src')?.includes('/api/reader/proxy?'), '视频条目未渲染播放器')
    const video = host.querySelector('.mr-video-player video')
    check('视频条目渲染播放器', !!video)
    check('播放器有控制条', video.controls === true)
    check('视频走媒体代理', String(video.getAttribute('src')).includes('/api/reader/proxy?') && String(video.getAttribute('src')).includes('chapterId=video-0'))

    // 订阅媒体：手动下载当前条目后，播放器切到本地缓存地址；目录显示封面与日期。
    const downloadCalls = [];
    let downloaded = false
    const downloadCtx = { remote: { reader: {
      toc: async () => {
        const item = { id: 'dl-0', name: '可下载条目', coverUrl: 'https://img.example/entry.png', publishedAt: '2026-11-14 08:00' }
        if (downloaded) item.offline = { kind: 'file', mediaId: 'local-1' }
        return [item]
      },
      chapter: async () => {
        const entry = { id: 'dl-0', name: '可下载条目', contentType: 'subscription', mediaUrl: 'https://media.example/clip.mp4', coverUrl: 'https://img.example/entry.png', publishedAt: '2026-11-14 08:00' }
        if (downloaded) entry.offline = { kind: 'file', mediaId: 'local-1' }
        return entry
      },
      download: async (args) => { downloadCalls.push(args); downloaded = true; return { id: 'job-dl' } },
      markChapterRead: async () => ({}),
      saveProgress: async () => ({}),
    } } }
    const downloadBook = {
      id: 'download-book', title: '下载回归', contentType: 'subscription', readBaselineAt: '2026-01-01T00:00:00.000Z',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'dl-0', percent: 0, offset: 0 },
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      key: 'download-book', ctx: downloadCtx, book: downloadBook, settings, notes: [], onClose() {},
    }))
    await waitFor(() => host.querySelector('.mr-video-player video'), '可下载条目未渲染播放器')
    const downloadButton = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '下载这一条')
    check('订阅条目显示下载入口', !!downloadButton)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const tocButtonForDownload = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '目录')
    tocButtonForDownload.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => host.querySelector('.mr-toc-cover'), '目录没有显示封面')
    check('目录封面走媒体代理', /cover=1/.test(host.querySelector('.mr-toc-cover img')?.getAttribute('src') || ''))
    check('目录显示日期', /11-14$/.test(host.querySelector('.mr-toc-date')?.textContent || ''))
    const downloadNow = host.querySelector('.mr-reader-top-download')
    downloadNow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await waitFor(() => downloadCalls.length === 1, '点击下载没有调用服务')
    check('下载只提交当前条目', downloadCalls[0].bookId === 'download-book' && downloadCalls[0].chapterIds.length === 1 && downloadCalls[0].chapterIds[0] === 'dl-0')
    await waitFor(() => String(host.querySelector('.mr-video-player video')?.getAttribute('src')).includes('/api/reader/media?id=local-1'), '下载后播放器未切到本地地址')
    check('下载后走本地缓存', String(host.querySelector('.mr-video-player video')?.getAttribute('src')).includes('/api/reader/media?id=local-1'))

    // 订阅搜索：目录里的搜索框只对有 searchUrl 的订阅出现，点结果加入目录并直接打开。
    const searchCalls = []
    let searchOpened = false
    const searchCtx = { remote: { reader: {
      toc: async () => searchOpened
        ? [{ id: 'search-1', name: '搜索结果' }, { id: 'entry-0', name: '第一篇' }]
        : [{ id: 'entry-0', name: '第一篇' }],
      chapter: async (args) => args.chapterId === 'search-1'
        ? { id: 'search-1', name: '搜索结果', contentType: 'subscription', text: '搜索结果正文' }
        : { id: 'entry-0', name: '第一篇', contentType: 'subscription', text: '第一篇正文' },
      searchSubscription: async (args) => {
        searchCalls.push(args)
        return { items: [{ title: '搜到的条目', url: 'https://rss.example/post/9', publishedAt: '2026-11-14 09:00' }], page: 1, hasMore: false }
      },
      openSubscriptionEntry: async (args) => {
        searchOpened = true
        searchCalls.push(args)
        return { id: 'search-1', title: args.title, url: args.url }
      },
      saveProgress: async () => ({}),
    } } }
    const searchBook = {
      id: 'search-book', title: '搜索回归', contentType: 'subscription', searchable: true,
      readBaselineAt: '2026-01-01T00:00:00.000Z',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'entry-0', percent: 0, offset: 0 },
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      key: 'search-book', ctx: searchCtx, book: searchBook, settings, notes: [], onClose() {},
    }))
    await waitFor(() => /第一篇正文/.test(host.textContent || '') && !host.querySelector('.mr-drawer-left'), '搜索回归正文未加载')
    ;[...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '目录').click()
    await waitFor(() => host.querySelector('.mr-toc-search input'), '有 searchUrl 的订阅没有出现搜索框')
    const tocSearchInput = host.querySelector('.mr-toc-search input')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(tocSearchInput, '麻豆')
    tocSearchInput.dispatchEvent(new Event('input', { bubbles: true }))
    host.querySelector('.mr-toc-search-row button').click()
    await waitFor(() => host.querySelector('.mr-toc-result'), '搜索结果没有显示')
    check('搜索只提交当前订阅', searchCalls[0]?.bookId === 'search-book' && searchCalls[0]?.query === '麻豆')
    check('搜索结果显示标题与日期', /搜到的条目/.test(host.querySelector('.mr-toc-result-label')?.textContent || '') && /11-14$/.test(host.querySelector('.mr-toc-result-date')?.textContent || ''))
    host.querySelector('.mr-toc-result').click()
    await waitFor(() => /搜索结果正文/.test(host.textContent || ''), '点搜索结果后没有打开正文')
    check('点搜索结果后关闭目录', !host.querySelector('.mr-drawer-left'))
    ;[...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '目录').click()
    await waitFor(() => [...host.querySelectorAll('.mr-toc-label')].some((node) => node.textContent === '搜索结果'), '搜索结果没有写入目录')
    check('搜索结果写入目录', [...host.querySelectorAll('.mr-toc-label')].some((node) => node.textContent === '搜索结果'))
    root.render(React.createElement(window.__readerTest.ReaderView, {
      key: 'search-book-off', ctx: searchCtx, book: { ...searchBook, searchable: false }, settings, notes: [], onClose() {},
    }))
    await waitFor(() => !host.querySelector('.mr-drawer-left'), '切换无搜索订阅后目录仍开着')
    await waitFor(() => [...host.querySelectorAll('button')].some((node) => node.getAttribute('aria-label') === '目录'), '无搜索订阅目录入口未渲染')
    ;[...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '目录').click()
    await waitFor(() => host.querySelector('.mr-toc'), '无搜索订阅目录未渲染')
    check('没有 searchUrl 不显示搜索框', !host.querySelector('.mr-toc-search'))

    // 导入订阅源：分类默认不选、可全选/全不选，勾选后按分类加入书架。
    const addedCalls = []
    const sourceCtx = {
      sources: [], subscriptions: [], busy: false,
      onImport: async () => ({
        kind: 'rss', sourceId: 'rss-ui', name: '示例订阅',
        categories: [
          { name: '分类01', url: 'https://rss.example/list/1/page/{{page}}.html' },
          { name: '分类02', url: 'https://rss.example/list/2/page/{{page}}.html' },
        ],
        unsupported: ['cookie'],
      }),
      onAddSubscriptions: async (sourceId, categories) => { addedCalls.push({ sourceId, categories }); return { added: categories.length } },
      onRemove() {}, onToggle() {}, onSubscribe() {}, onUnsubscribe() {}, onRefresh() {},
      onConfirmUpdate() {}, onRejectUpdate() {}, onRestoreBuiltin() {},
    }
    root.render(React.createElement(window.__readerTest.Sources, sourceCtx))
    await waitFor(() => host.querySelector('.mr-sources-left textarea'), '导入输入框没有渲染')
    const draft = host.querySelector('.mr-sources-left textarea')
    check('导入输入框存在', !!draft)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(draft, '{"sourceName":"示例订阅"}')
    draft.dispatchEvent(new Event('input', { bubbles: true }))
    const importButton = [...host.querySelectorAll('button')].find((node) => node.textContent === '导入')
    check('导入按钮存在', !!importButton)
    importButton.click()
    await waitFor(() => host.querySelector('.mr-rss-import'), '订阅源分类面板未出现')
    check('面板提示不支持能力', /Cookie/.test(host.querySelector('.mr-rss-import .mr-source-warning')?.textContent || ''))
    check('分类默认全不选', [...host.querySelectorAll('.mr-rss-row input')].every((node) => node.checked === false))
    const addButton = () => [...host.querySelectorAll('.mr-rss-import button')].find((node) => /加入书架/.test(node.textContent || ''))
    check('未选分类时不能加入书架', addButton()?.disabled === true)
    ;[...host.querySelectorAll('.mr-rss-import button')].find((node) => node.textContent === '全选').click()
    await waitFor(() => [...host.querySelectorAll('.mr-rss-row input')].every((node) => node.checked), '全选没有选中全部分类')
    ;[...host.querySelectorAll('.mr-rss-import button')].find((node) => node.textContent === '全不选').click()
    await waitFor(() => [...host.querySelectorAll('.mr-rss-row input')].every((node) => !node.checked), '全不选没有清空分类')
    host.querySelector('.mr-rss-row input').click()
    await waitFor(() => /加入书架（1）/.test(addButton()?.textContent || ''), '勾选一个分类后按钮计数不对')
    addButton().click()
    await waitFor(() => addedCalls.length === 1, '加入书架没有调用服务')
    check('只提交勾选分类', addedCalls[0].sourceId === 'rss-ui' && addedCalls[0].categories.length === 1 && addedCalls[0].categories[0] === 'https://rss.example/list/1/page/{{page}}.html')

    // 列表卡：订阅卡显示来源名、最近条目标题与日期。
    root.render(React.createElement(window.__readerTest.Library, {
      books: [{
        id: 'card-1', name: '分类01', title: '分类01', contentType: 'subscription', unread: 2,
        latestChapter: '最近一条', latestEntryAt: '2026-11-14 08:00',
        download: { status: 'none', total: 0, done: 0 },
        subscription: { sourceName: '示例订阅', categoryName: '分类01' },
      }],
      category: { label: '订阅', unit: '份' }, view: 'list', onView() {}, onOpen() {}, onCheck() {}, onRemove() {},
      onMarkRead() {}, onToggleDownload() {}, busy: false,
    }))
    await waitFor(() => host.querySelector('.mr-book-card'), '订阅列表卡未渲染')
    check('列表卡显示来源名', host.querySelector('.mr-book-info p')?.textContent === '示例订阅')
    const cardMeta = host.querySelector('.mr-book-info small')?.textContent || ''
    check('列表卡显示最近条目', cardMeta.includes('最近一条'))
    check('列表卡显示最近日期', /11-14$/.test(cardMeta))
    check('相对日期也能显示', /^\d{2}-\d{2}$/.test(window.__readerTest.formatShortDate('3天前')))
    check('月日日期也能显示', /^\d{2}-\d{2}$/.test(window.__readerTest.formatShortDate('11-14')))
    check('列表卡显示未读数', host.querySelector('.mr-book-card .mr-badge')?.textContent === '2 条')
    check('未下载的订阅卡不显示下载徽标', !host.querySelector('.mr-dl-badge'))

    // 未读：打开条目应标记当前条目，目录标出剩余未读，并提供全部已读。
    const readCalls = []
    const markAllCalls = []
    const unreadCtx = { remote: { reader: {
      toc: async () => [{ id: 'u-0', name: '未读条目' }, { id: 'u-1', name: '第二条' }],
      chapter: async () => ({ id: 'u-0', name: '条目正文', contentType: 'subscription', text: '条目正文' }),
      markChapterRead: async (args) => { readCalls.push(args.chapterId); return {} },
      markBookRead: async () => { markAllCalls.push('all'); return {} },
      saveProgress: async () => ({}),
    } } }
    const unreadBook = {
      id: 'unread-book', title: '未读回归', contentType: 'subscription', readBaselineAt: '2026-01-01T00:00:00.000Z',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'u-0', percent: 0, offset: 0 },
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      key: 'unread-book', ctx: unreadCtx, book: unreadBook, settings, notes: [], onClose() {},
    }))
    await waitFor(() => readCalls.length === 1, '打开未读条目没有标记已读')
    check('打开条目标记当前条目', readCalls[0] === 'u-0')
    const tocButton = [...host.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '目录')
    check('目录入口存在', !!tocButton)
    tocButton.click()
    await waitFor(() => host.querySelector('.mr-toc-new'), '目录没有标出未读条目')
    check('目录标出剩余未读', host.querySelectorAll('.mr-toc-new').length === 1)
    const markAll = [...host.querySelectorAll('button')].find((node) => node.textContent === '全部已读')
    check('全部已读入口存在', !!markAll)
    markAll.click()
    await waitFor(() => !host.querySelector('.mr-toc-new'), '全部已读后仍有未读标记')
    check('全部已读调用服务', markAllCalls.length === 1)
    return { ok: true, checks }
  } catch (error) {
    return { ok: false, error: error.stack || String(error) }
  } finally {
    root.unmount()
    host.remove()
    localStorage.clear()
  }
})()

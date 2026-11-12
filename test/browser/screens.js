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
const { Discover, Sources, Settings, ShelfBoard, ReaderNav, SHELF_CATEGORIES, booksForShelfCategory, WebsiteShelf, MediaReader, MediaDownloadSheet, MediaAudioDock, mediaChapterSource, mediaStartSeconds, mediaProgressPayload, readerStyle } = registration.factory(require).__test
const style = document.createElement('style')
style.textContent = readerStyle
document.head.append(style)
const h = React.createElement
const host = document.createElement('div')
host.style.cssText = 'position:fixed;inset:0'
document.body.append(host)
const root = createRoot(host)
const noop = () => {}
const sources = [
  { id: 'src-1', bookSourceName: '起点中文网', bookSourceUrl: 'https://a.example.com', builtin: true },
  { id: 'src-2', bookSourceName: '17K 小说', bookSourceUrl: 'https://www.17k.com', compatibility: '基础规则' },
  { id: 'src-3', bookSourceName: '维基文库', bookSourceUrl: 'https://zh.wikisource.org', lastError: 'timeout' },
  { id: 'src-4', bookSourceName: '笔趣阁', bookSourceUrl: 'https://b.example.com', enabled: false },
  { id: 'src-5', bookSourceName: '番茄小说', bookSourceUrl: 'https://c.example.com' },
  { id: 'local', bookSourceName: '本地导入', bookSourceUrl: 'local:' },
]
const websites = [
  { id: 'web-1', contentType: 'website', name: '示例站点', homeUrl: 'https://site.example/home', searchUrl: 'https://site.example/search?q={{key}}', enabled: true },
  { id: 'web-2', contentType: 'website', name: '停用站点', homeUrl: 'https://disabled.example', enabled: false },
  { id: 'web-3', contentType: 'website', name: '仅首页站点', homeUrl: 'https://home.example', enabled: true },
]
const discoverySources = [...sources, ...websites]
window.__openedWebsites = []
window.open = (url, target, features) => { window.__openedWebsites.push({ url, target, features }); return {} }
const subscriptions = [
  { id: 'sub-1', url: 'https://library.example/sources.json', sourceIds: ['src-1', 'src-2'], status: 'ready', lastCheckedAt: '2026-11-11T08:00:00.000Z', lastSuccessAt: '2026-11-11T08:00:00.000Z' },
  { id: 'sub-2', url: 'https://broken.example/sources.json', sourceIds: ['src-3'], status: 'error', lastCheckedAt: '2026-11-11T09:00:00.000Z', lastSuccessAt: '2026-11-10T08:00:00.000Z', lastFailureAt: '2026-11-11T09:00:00.000Z', lastError: '源库返回的不是有效 JSON。' },
  { id: 'sub-3', url: 'https://slow.example/sources.json', sourceIds: ['src-4'], status: 'ready', checking: true },
  { id: 'sub-4', url: 'https://new.example/sources.json', sourceIds: ['src-1'], status: 'pending', pending: { permissions: { origins: ['https://new.example'], capabilities: [{ origin: 'https://a.example', capabilities: ['js'] }] }, changes: { added: 2, updated: 1, removed: 0, addedNames: ['新站甲', '新站乙'], updatedNames: ['17K 小说'], removedNames: [] } } },
]
const results = [
  { name: '凡人外传', author: '忘语', sourceName: '起点中文网', bookUrl: 'https://a.example.com/book/1', kind: '连载中' },
  { name: '剑破苍穹', author: '狂飙的蜗牛', sourceName: '17K 小说', bookUrl: 'https://www.17k.com/book/2', kind: '已完结' },
]
const settings = { replacements: [], mode: 'scroll', flipStyle: 'slide', animations: true, motionQuality: 'auto', ambience: 'full', reducedMotion: 'system', fontSize: 19, lineHeight: 1.9, readerTheme: 'paper', mediaQuotaBytes: 50 * 1024 ** 3 }
const props = { settings, onSettings: (value) => { window.__settingsUpdate = value }, onLocal: noop, onExport: noop, onImport: noop, busy: false, onExportNotes: noop, onUploadFont: noop }
const shell = (screen) => h('div', { className: 'mr-root' }, h('section', { className: 'mr-content' }, screen))
const render = (screen) => root.render(shell(screen))

const categoryBooks = [
  { id: 'novel-1', name: '小说一', author: '作者', contentType: 'novel', createdAt: '2026-01-01', unreadCount: 2 },
  { id: 'comic-1', name: '漫画一', author: '作者', contentType: 'comic', createdAt: '2026-01-02', unreadCount: 4 },
]
function CategorySwitchScreen() {
  const [tab, setTab] = React.useState('novel')
  const category = SHELF_CATEGORIES.find(item => item.id === tab)
  return h('div', { className: 'mr-root' },
    h(ReaderNav, { tab, onTab: setTab }),
    h('section', { className: 'mr-content' },
      h(ShelfBoard, { books: booksForShelfCategory(categoryBooks, tab), category, reducedMotion: true, onOpen: noop, onCheck: noop })))
}


const mediaToc = [
  { id: 'media-c1', title: '第一话 山门', downloaded: false },
  { id: 'media-c2', title: '第二话 夜行', downloaded: true },
  { id: 'media-c3', title: '第三话 风起', downloaded: false },
]
const image = (seed) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="460"><rect width="320" height="460" fill="${seed}"/><text x="160" y="220" text-anchor="middle" fill="#fff" font-size="24">漫画页</text></svg>`)}`
const comicPages = [image('#5d705f'), image('#986b4f'), image('#72618a')]
const comicBook = { id: 'media-comic', name: '山海图', author: '绘者', contentType: 'comic', readerPrefs: { comicMode: 'scroll' }, progress: { chapterId: 'media-c1', offset: 0, percent: 0 } }
const audioBook = { id: 'media-audio', name: '夜航船', author: '讲述者', contentType: 'audio', progress: { chapterId: 'media-c1', offset: 18, percent: 10 } }
const videoBook = { id: 'media-video', name: '风起长林', author: '影像', contentType: 'video', sourceHome: 'https://source.example', progress: { chapterId: 'media-c1', offset: 0, percent: 0 } }
const mediaCtx = (payloadFor) => ({ remote: { reader: {
  toc: async () => mediaToc.map(item => ({ ...item })),
  chapter: async ({ chapterId }) => ({ ...mediaToc.find(item => item.id === chapterId), ...payloadFor(chapterId) }),
  saveProgress: async (args) => { window.__mediaProgress = args; return args },
  setBookSettings: async (args) => { window.__mediaSettings = args; return args },
  download: async () => ({ id: 'media-job', status: 'queued' }),
  pauseJob: async () => ({ id: 'media-job', status: 'paused' }),
  resumeJob: async () => { window.__mediaJobAction = 'resume'; return { id: 'media-job', status: 'running' } },
  cancelJob: async () => ({ id: 'media-job', status: 'cancelled' }),
  cancelDownloadChapters: async (args) => { window.__mediaCancelOne = args; return {} },
  mediaCacheStats: async () => ({ usedBytes: 12 * 1024 ** 2, mediaCount: 1 }),
  listMediaCache: async () => [{ id: 'media-c2-file', chapterId: 'media-c2', retained: true, size: 12 * 1024 ** 2 }],
  setChapterRetained: async (args) => { window.__mediaRetain = args; return [] },
} } })
const comicCtx = mediaCtx((id) => ({ images: id === 'media-c2' ? [] : comicPages }))
const audioCtx = mediaCtx(() => ({ mediaUrl: 'https://media.example/audio.mp3' }))
const videoCtx = mediaCtx((id) => id === 'media-c3' ? {} : ({ mediaUrl: 'https://media.example/video.mp4' }))
const hlsCtx = mediaCtx(() => ({ mediaUrl: 'https://media.example/video.m3u8' }))

function MediaComicScreen() {
  return h(MediaReader, {
    ctx: comicCtx,
    book: comicBook,
    settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
    jobs: [],
    onClose: noop,
    notify: (message) => { window.__mediaNotice = message },
  })
}
function MediaAudioScreen() {
  return h(MediaReader, {
    ctx: audioCtx,
    book: audioBook,
    settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
    jobs: [],
    onClose: noop,
    notify: noop,
  })
}
function MediaVideoScreen() {
  return h(MediaReader, {
    ctx: videoCtx,
    book: videoBook,
    settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
    jobs: [],
    onClose: noop,
    notify: noop,
  })
}
function MediaPausedScreen() {
  return h(MediaReader, {
    ctx: comicCtx,
    book: comicBook,
    settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
    jobs: [{ id: 'media-job', bookId: 'media-comic', status: 'paused', state: 'paused', total: 2, done: 1, chapterIds: ['media-c1', 'media-c3'], failedReasons: { 'media-c3': '网络断开' } }],
    onClose: noop,
    notify: noop,
  })
}
function MediaHlsScreen() {
  return h(MediaReader, {
    ctx: hlsCtx,
    book: videoBook,
    settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
    jobs: [],
    onClose: noop,
    notify: noop,
  })
}

function MediaAudioFlowScreen() {
  const [track, setTrack] = React.useState({ bookId: audioBook.id, bookName: audioBook.name, chapterId: 'media-c1', chapterTitle: '第一话 山门', url: 'https://media.example/audio.mp3' })
  return h('div', { className: 'mr-root' },
    h(MediaReader, {
      ctx: audioCtx,
      book: audioBook,
      settings: { ...settings, mediaQuotaBytes: 50 * 1024 ** 3 },
      jobs: [],
      onClose: noop,
      notify: noop,
      audioTrack: track,
      audioPlaying: true,
      audioTime: 0,
      audioDuration: 0,
      onAudioPlay: (next, start) => { setTrack(next); window.__audioTrack = next; window.__audioStart = start },
      onAudioToggle: noop,
      onAudioSeek: noop,
    }),
    h('div', { id: 'audio-state' }, track?.chapterId || ''))
}

function MediaDockScreen() {
  return h('div', { className: 'mr-root' }, h(MediaAudioDock, {
    track: { bookId: audioBook.id, bookName: audioBook.name, chapterId: 'media-c1', chapterTitle: '第一话 山门' },
    playing: true,
    time: 18,
    duration: 120,
    onToggle: noop,
    onSeek: noop,
    onClose: noop,
    onPrev: () => { window.__dockPrev = true },
    onNext: () => { window.__dockNext = true },
  }))
}
function MediaDownloadFixture() {
  const [selected, setSelected] = React.useState(mediaToc.map(item => item.id))
  const job = { id: 'media-job', bookId: comicBook.id, status: 'paused', state: 'paused', total: 3, done: 1, failedReasons: { 'media-c3': '网络断开' } }
  return h('div', { className: 'mr-root mr-reader' }, h(MediaDownloadSheet, {
    book: comicBook,
    toc: mediaToc,
    job,
    selected,
    setSelected,
    onClose: noop,
    onStart: () => { window.__mediaDownloadStarted = selected.slice() },
    onJobAction: (action) => { window.__mediaJobAction = action },
    onCancelOne: (id) => { window.__mediaCancelOne = id },
    quota: 50 * 1024 ** 3,
  }))
}

window.screensUI = {
  nav: () => root.render(h('div', { className: 'mr-root' }, h(ReaderNav, { tab: 'novel', onTab: noop }), h('section', { className: 'mr-content' }, h('h1', null, '小说书架')))),
  categoryShelf: () => render(h(ShelfBoard, { books: booksForShelfCategory(categoryBooks, 'novel'), category: SHELF_CATEGORIES[0], reducedMotion: true, onOpen: noop, onCheck: noop })),
  emptyShelf: () => render(h(ShelfBoard, { books: booksForShelfCategory(categoryBooks, 'audio'), category: SHELF_CATEGORIES[2], reducedMotion: true, onOpen: noop, onCheck: noop })),
  categorySwitch: () => root.render(h(CategorySwitchScreen)),
  websiteShelf: () => render(h(WebsiteShelf, { sources: websites })),
  websiteEmpty: () => render(h(WebsiteShelf, { sources: [websites[1]] })),
  discover: () => render(h(Discover, { sources: discoverySources, onSearch: noop, onAdd: noop, results, busy: false, failed: 1 })),
  sources: () => render(h(Sources, { sources, subscriptions, onImport: noop, onRemove: noop, onToggle: noop, onSubscribe: async () => false, onRefresh: (id) => { window.__refreshClicked = id; }, onConfirmUpdate: (id) => { window.__confirmClicked = id; }, onRejectUpdate: (id) => { window.__rejectClicked = id; }, onUnsubscribe: noop, busy: false, onRestoreBuiltin: noop })),
  settings: () => render(h(Settings, props)),
  mediaComic: () => root.render(h(MediaComicScreen)),
  mediaAudio: () => root.render(h(MediaAudioScreen)),
  mediaAudioFlow: () => root.render(h(MediaAudioFlowScreen)),
  mediaVideo: () => root.render(h(MediaVideoScreen)),
  mediaHls: () => root.render(h(MediaHlsScreen)),
  mediaPaused: () => root.render(h(MediaPausedScreen)),
  mediaDock: () => root.render(h(MediaDockScreen)),
  mediaDownload: () => root.render(h(MediaDownloadFixture)),
  measure() {
    const screen = document.querySelector('.mr-screen')
    const layout = document.querySelector('.mr-discover-layout, .mr-sources-layout, .mr-settings-grid')
    const panel = document.querySelector('.mr-settings-grid .mr-panel')
    const online = document.querySelector('.mr-online-row input')
    return {
      vw: innerWidth,
      overflow: document.documentElement.scrollWidth,
      screenWidth: screen ? Math.round(screen.getBoundingClientRect().width) : 0,
      head: document.querySelector('.mr-screen-head h1, .mr-shelf-head h1')?.textContent || '',
      navButtons: document.querySelectorAll('.mr-nav-items button').length,
      navLabels: [...document.querySelectorAll('.mr-nav-items button')].map((button) => button.textContent).join(','),
      navActive: document.querySelector('.mr-nav-items button.active')?.dataset.tab || '',
      navWidth: Math.round(document.querySelector('.mr-nav')?.getBoundingClientRect().width || 0),
      shelfCount: document.querySelector('.mr-shelf-head .tag, .mr-screen-count')?.textContent || '',
      shelfEmpty: document.querySelector('.mr-shelf-empty h3')?.textContent || '',
      websiteCount: document.querySelector('.mr-website-screen .mr-screen-stat')?.textContent || '',
      websiteCards: document.querySelectorAll('.mr-website-card').length,
      websiteNames: [...document.querySelectorAll('.mr-website-card h2')].map(node => node.textContent).join(','),
      siteResults: document.querySelectorAll('.mr-site-result').length,
      layout: layout ? getComputedStyle(layout).gridTemplateColumns : '',
      display: layout ? getComputedStyle(layout).display : '',
      columns: layout && getComputedStyle(layout).display === 'grid' ? getComputedStyle(layout).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      results: document.querySelectorAll('.mr-discovery-result').length,
      warning: document.querySelectorAll('.mr-source-warning').length,
      sourceRows: document.querySelectorAll('.mr-source-row').length,
      subscriptionRows: document.querySelectorAll('.mr-subscription-row').length,
      refreshButtons: document.querySelectorAll('.mr-subscription-actions [title="立即检查订阅更新"]').length,
      checkingTags: document.querySelectorAll('.mr-subscription-actions .mr-tag.checking').length,
      failedTags: document.querySelectorAll('.mr-subscription-actions .mr-tag.failed').length,
      unsubscribeButtons: document.querySelectorAll('.mr-subscription-actions [title="取消订阅，不删除书源"]').length,
      pendingTags: document.querySelectorAll('.mr-subscription-actions .mr-tag.pending').length,
      pendingPermissions: document.querySelectorAll('.mr-pending-permissions').length,
      pendingRowWidth: document.querySelector('.mr-subscription-row.is-pending')?.getBoundingClientRect().width || 0,
      pendingCopyWidth: document.querySelector('.mr-subscription-row.is-pending .mr-subscription-copy')?.getBoundingClientRect().width || 0,
      pendingActionsWidth: document.querySelector('.mr-subscription-row.is-pending .mr-subscription-actions')?.getBoundingClientRect().width || 0,
      confirmButtons: document.querySelectorAll('.mr-subscription-actions [title="应用已获取并等待确认的更新"]').length,
      rejectButtons: document.querySelectorAll('.mr-subscription-actions [title="放弃这次候选更新，继续使用旧版"]').length,
      sourceChips: document.querySelectorAll('.mr-source-chip').length,
      disabledRows: document.querySelectorAll('.mr-source-row.is-disabled').length,
      toggleButtons: document.querySelectorAll('.mr-source-side [aria-pressed]').length,
      panels: document.querySelectorAll('.mr-settings-grid .mr-panel').length,
      mediaQuotaValue: document.querySelector('[aria-label="媒体缓存上限GB"]')?.value || '',
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      onlineHeight: online ? Math.round(online.getBoundingClientRect().height) : 0,
      mediaImages: document.querySelectorAll('.mr-comic img').length,
      mediaVisibleImages: [...document.querySelectorAll('.mr-comic img')].filter(node => getComputedStyle(node).display !== 'none').length,
      mediaPaged: !!document.querySelector('.mr-comic.paged'),
      mediaAudio: !!document.querySelector('.mr-audio-stage'),
      mediaVideo: !!document.querySelector('.mr-video-stage video'),
      mediaError: document.querySelector('.mr-media-error')?.textContent || '',
      downloadRows: document.querySelectorAll('.mr-download-row').length,
      downloadReady: document.querySelectorAll('.mr-download-row.is-ready').length,
      downloadFailed: document.querySelectorAll('.mr-download-row.is-failed').length,
      downloadSheet: !!document.querySelector('.mr-download-sheet'),
    }
  },
}
window.__mediaChapterSource = mediaChapterSource
window.__mediaStartSeconds = mediaStartSeconds
window.__mediaProgressPayload = mediaProgressPayload
window.screensReady = true

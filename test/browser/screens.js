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
const { Discover, Sources, Settings, readerStyle } = registration.factory(require).__test
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
const subscriptions = [
  { id: 'sub-1', url: 'https://library.example/sources.json', sourceIds: ['src-1', 'src-2'], status: 'ready', lastSuccessAt: '2026-11-11T08:00:00.000Z' },
  { id: 'sub-2', url: 'https://broken.example/sources.json', sourceIds: ['src-3'], status: 'error', lastSuccessAt: '2026-11-10T08:00:00.000Z', lastFailureAt: '2026-11-11T09:00:00.000Z', lastError: '源库返回的不是有效 JSON。' },
  { id: 'sub-3', url: 'https://slow.example/sources.json', sourceIds: ['src-4'], status: 'ready', checking: true },
]
const results = [
  { name: '凡人外传', author: '忘语', sourceName: '起点中文网', bookUrl: 'https://a.example.com/book/1', kind: '连载中' },
  { name: '剑破苍穹', author: '狂飙的蜗牛', sourceName: '17K 小说', bookUrl: 'https://www.17k.com/book/2', kind: '已完结' },
]
const settings = { replacements: [], mode: 'scroll', flipStyle: 'slide', animations: true, motionQuality: 'auto', ambience: 'full', reducedMotion: 'system', fontSize: 19, lineHeight: 1.9, readerTheme: 'paper' }
const props = { settings, onSettings: noop, onLocal: noop, onExport: noop, onImport: noop, busy: false, onExportNotes: noop, onUploadFont: noop }
const shell = (screen) => h('div', { className: 'mr-root' }, h('section', { className: 'mr-content' }, screen))
const render = (screen) => root.render(shell(screen))

window.screensUI = {
  discover: () => render(h(Discover, { sources, onSearch: noop, onAdd: noop, results, busy: false, failed: 1 })),
  sources: () => render(h(Sources, { sources, subscriptions, onImport: noop, onRemove: noop, onToggle: noop, onSubscribe: async () => false, onRefresh: (id) => { window.__refreshClicked = id; }, onUnsubscribe: noop, busy: false, onRestoreBuiltin: noop })),
  settings: () => render(h(Settings, props)),
  measure() {
    const screen = document.querySelector('.mr-screen')
    const layout = document.querySelector('.mr-discover-layout, .mr-sources-layout, .mr-settings-grid')
    const panel = document.querySelector('.mr-settings-grid .mr-panel')
    const online = document.querySelector('.mr-online-row input')
    return {
      vw: innerWidth,
      overflow: document.documentElement.scrollWidth,
      screenWidth: screen ? Math.round(screen.getBoundingClientRect().width) : 0,
      head: document.querySelector('.mr-screen-head h1')?.textContent || '',
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
      sourceChips: document.querySelectorAll('.mr-source-chip').length,
      disabledRows: document.querySelectorAll('.mr-source-row.is-disabled').length,
      toggleButtons: document.querySelectorAll('.mr-source-side [aria-pressed]').length,
      panels: document.querySelectorAll('.mr-settings-grid .mr-panel').length,
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      onlineHeight: online ? Math.round(online.getBoundingClientRect().height) : 0,
    }
  },
}
window.screensReady = true

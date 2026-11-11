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
  { id: 'src-4', bookSourceName: '笔趣阁', bookSourceUrl: 'https://b.example.com', lastError: 'parse' },
  { id: 'src-5', bookSourceName: '本机缓存', bookSourceUrl: 'local://cache' },
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
  sources: () => render(h(Sources, { sources, onImport: noop, onRemove: noop, busy: false, onPullLibrary: async () => false, onRestoreBuiltin: noop })),
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
      panels: document.querySelectorAll('.mr-settings-grid .mr-panel').length,
      panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      onlineHeight: online ? Math.round(online.getBoundingClientRect().height) : 0,
    }
  },
}
window.screensReady = true

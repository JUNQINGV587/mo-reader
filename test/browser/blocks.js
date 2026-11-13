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
    return { ok: true, checks }
  } catch (error) {
    return { ok: false, error: error.stack || String(error) }
  } finally {
    root.unmount()
    host.remove()
    localStorage.clear()
  }
})()

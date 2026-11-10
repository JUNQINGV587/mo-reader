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
const readerStyle = document.createElement('style')
readerStyle.textContent = window.__readerTest.readerStyle
document.head.append(readerStyle)

const toc = Array.from({ length: 5 }, (_, index) => ({
  id: `chapter-${index}`,
  name: `第${index + 1}章 回归`,
}))
const chapterText = (index) => Array.from({ length: 180 }, (_, line) =>
  `第 ${index + 1} 章第 ${line + 1} 段：跨章裁剪只应换算滚动坐标，不应让读者看到正文向上回跳。`,
).join('\n')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))

async function waitFor(predicate, message, timeout = 6000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (predicate()) return
    await frame()
  }
  throw new Error(message)
}

function chapterTop(el, index) {
  const node = el.querySelector(`[data-chapter-index="${index}"]`)
  if (!node) throw new Error(`找不到第 ${index} 章 DOM`)
  return node.getBoundingClientRect().top - el.getBoundingClientRect().top
}

async function runCase(reducedMotion) {
  const name = reducedMotion ? 'reduced-motion' : 'default-smooth'
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;inset:0;'
  document.body.append(host)
  const root = createRoot(host)
  try {
    const ctx = { remote: { reader: {
      toc: async () => toc,
      chapter: async ({ chapterId }) => {
        const index = Number(chapterId.split('-')[1])
        return { name: toc[index].name, text: chapterText(index) }
      },
      saveProgress: async () => ({}),
    } } }
    const book = {
      id: `scroll-restore-${name}`,
      title: '跨章回归',
      contentType: 'text',
      readerPrefs: { mode: 'scroll', ambience: 'off' },
      lastRead: { chapterId: 'chapter-1', percent: 0, offset: 0 },
    }
    const settings = {
      mode: 'scroll', ambience: 'off', animations: true,
      reducedMotion: reducedMotion ? 'on' : 'off',
      fontSize: 20, lineHeight: 1.9, fontFamily: 'serif',
      readerTheme: 'paper', measureWidth: 800,
    }
    root.render(React.createElement(window.__readerTest.ReaderView, {
      ctx, book, settings, notes: [], onClose() {},
    }))
    await waitFor(
      () => host.querySelectorAll('[data-chapter-index]').length === 3,
      '初始三章窗口未渲染',
    )
    const el = host.querySelector('.mr-chapter-scroll')
    if (!el) throw new Error('阅读滚动容器不存在')
    const behavior = getComputedStyle(el).scrollBehavior
    const expectedBehavior = reducedMotion ? 'auto' : 'smooth'
    if (behavior !== expectedBehavior) throw new Error(`滚动行为应为 ${expectedBehavior}，实际为 ${behavior}`)
    try {
      await waitFor(() => Math.abs(chapterTop(el, 1)) < 2, '初始章节锚点未稳定')
    } catch (error) {
      throw new Error(`${error.message}：${JSON.stringify({
        scrollTop: el.scrollTop, chapterTop: chapterTop(el, 1),
        clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
        readerHeight: el.parentElement?.getBoundingClientRect().height,
      })}`)
    }

    const target = chapterTop(el, 2) + el.scrollTop + 40
    while (el.scrollTop < target - 1) {
      el.scrollBy({ top: Math.min(24, target - el.scrollTop), behavior: 'instant' })
      await frame()
    }
    const before = chapterTop(el, 2)
    const positions = [before]
    await waitFor(() => {
      positions.push(chapterTop(el, 2))
      const keys = [...el.querySelectorAll('[data-chapter-index]')]
        .map((node) => Number(node.dataset.chapterIndex))
      return keys.join(',') === '1,2,3'
    }, '跨章后没有裁掉前章')

    for (let index = 0; index < 45; index += 1) {
      positions.push(chapterTop(el, 2))
      await frame()
    }
    await sleep(900)
    const after = chapterTop(el, 2)
    const min = Math.min(...positions)
    const max = Math.max(...positions)
    const result = {
      name,
      behavior,
      before,
      after,
      range: max - min,
      samples: [0, 5, 10, 20, 30, 44].map((index) => positions[index]),
    }
    if (Math.abs(after - before) > 2) {
      throw new Error(`${name} 裁章后章内偏移改变：${before} → ${after}`)
    }
    if (max - min > 2) {
      throw new Error(`${name} 内部锚点恢复出现可见回跳，范围 ${max - min}px`)
    }
    return result
  } finally {
    root.unmount()
    host.remove()
    localStorage.clear()
  }
}

window.scrollRestoreTest = (async () => {
  const cases = []
  for (const reducedMotion of [false, true]) {
    try {
      cases.push(await runCase(reducedMotion))
    } catch (error) {
      cases.push({ name: reducedMotion ? 'reduced-motion' : 'default-smooth', error: error.stack || String(error) })
    }
  }
  return { ok: cases.every((entry) => !entry.error), cases }
})()

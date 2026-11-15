import { createElement, useEffect, useRef } from 'react'
import { createApp } from 'vue'
import App from './app/App.vue'

/**
 * DSH 的槽位是 React 组件，墨读的界面是 Vue。
 * 这一层只做桥：React 挂一个容器，Vue 在容器里创建应用，卸载时一起销毁。
 */
export function createReaderShell(ctx: any) {
  return function ReaderShell() {
    const hostRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const host = hostRef.current
      if (!host) return undefined
      const app = createApp(App, {
        remote: ctx?.remote?.reader,
        layout: ctx?.layout,
      })
      app.mount(host)
      return () => {
        app.unmount()
        host.innerHTML = ''
      }
    }, [])

    return createElement('div', {
      ref: hostRef,
      className: 'mo-reader-host',
      style: { height: '100%', minHeight: 0, overflow: 'auto' },
    })
  }
}

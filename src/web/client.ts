import { createElement } from 'react'
import { z } from 'zod'
import { PANEL_ID } from '../core/version'
import { createReaderShell } from './shell'

const jsonCodec = () => ({ mode: 'strict' as const, typeSymbol: '@local/mo-reader#Json', create: () => z.json() })

/** M0 只暴露 state；M1 起把书源、搜索、书架、目录、正文等 descriptor 逐个加回来。 */
export const readerContribution = {
  package: '@local/mo-reader',
  descriptors: [
    {
      id: '@local/mo-reader#reader/state',
      package: '@local/mo-reader',
      namespace: 'reader',
      service: 'reader',
      method: 'state',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'args', wire: 'args', source: 'json', acceptsUndefined: true, codec: jsonCodec() }],
      result: jsonCodec(),
    },
  ],
}

function ReaderIcon() {
  return createElement(
    'svg',
    { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'M2.8 3h3.6c.9 0 1.6.7 1.6 1.6v9c0-.9-.7-1.6-1.6-1.6H2.8V3Zm10.4 0H9.6C8.7 3 8 3.7 8 4.6v9c0-.9.7-1.6 1.6-1.6h3.6V3Z',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinejoin: 'round',
    }),
  )
}

const plugin = {
  inject: ['slots', 'layout', 'remote'],

  async apply(ctx: any) {
    const unmount = await ctx.remote.$mount(readerContribution)
    const ui = ctx.inject(['remote.reader'], (inner: any) => {
      const ReaderShell = createReaderShell(inner)
      inner.slots.inject('main', () => {
        inner.slots.register({ name: 'main', key: PANEL_ID }, () => createElement(ReaderShell))
      })
      inner.slots.inject('sidebar.panellist', () => {
        inner.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: 8, label: '墨读' },
          ReaderIcon,
        )
      })
    })
    try {
      await ui
    } catch (error) {
      ui?.dispose?.()
      await unmount()
      throw error
    }
    return async () => {
      await ui?.dispose?.()
      await unmount()
    }
  },
}

export default plugin

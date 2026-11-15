import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

const require = createRequire(import.meta.url)

test('SSRF 守卫：私网、协议与凭据', async () => {
  const { isPrivateAddress, parseHttpUrl, UnsafeUrlError } = await import('../dist/core/net/guard.js')

  const privateAddresses = [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    'ff02::1',
  ]
  for (const address of privateAddresses) assert.equal(isPrivateAddress(address), true, address)

  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, address)
  }

  for (const raw of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://127.0.0.1/',
    'http://localhost:3000/',
    'http://[::1]/',
    'http://user:pass@example.com/',
  ]) {
    assert.throws(() => parseHttpUrl(raw), UnsafeUrlError, raw)
  }

  const url = parseHttpUrl('https://example.com/search?q=墨读')
  assert.equal(url.hostname, 'example.com')
  assert.equal(url.searchParams.get('q'), '墨读')
})

test('server：storage 域与 Remote 契约', async () => {
  const { ReaderDomain } = await import('../dist/server/storage.js')
  assert.equal(ReaderDomain.name, 'mo_reader')
  for (const name of [
    'books',
    'chapters',
    'sources',
    'groups',
    'notes',
    'bookmarks',
    'read_records',
    'jobs',
    'subscriptions',
  ]) {
    assert.ok(ReaderDomain.tables[name], name)
  }

  const mod = await import('../dist/server/index.js')
  assert.equal(typeof mod.default, 'function')
  assert.ok(mod.default.inject.includes('storageDomain'))
  assert.ok(mod.REMOTE_METHODS.includes('state'))
  assert.ok(mod.REMOTE_METHODS.includes('searchBooks'))
})

test('client：bundle 可加载并注册 main 与 sidebar', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  for (const key of [
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'SVGElement',
    'DocumentFragment',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]) {
    if (!(key in globalThis)) {
      Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true })
    }
  }

  let entry = null
  dom.window.__ModuleLoader__ = {
    load(loaded) {
      entry = loaded
    },
  }

  const code = await readFile(new URL('../dist/client/client.js', import.meta.url), 'utf8')
  assert.match(code, /__ModuleLoader__/)
  new Function(code)()

  assert.ok(entry)
  assert.equal(entry.id, '@local/mo-reader')

  const plugin = entry.factory(require)
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.inject.includes('slots'))

  const registered = []
  let mounts = 0
  const reader = {
    state: async () => ({ ok: true, version: 'test', methods: [] }),
    listSources: async () => ({
      sources: [{ bookSourceUrl: 'https://example.com', bookSourceName: '示例源', enabled: true }],
    }),
    listBooks: async () => ({ books: [] }),
    getSettings: async () => ({ settings: { fontSize: 24, lineSpacing: 1.8 } }),
  }
  const ctx = {
    remote: {
      $mount: async () => {
        mounts += 1
        return async () => {}
      },
    },
    inject(_deps, fn) {
      const inner = {
        remote: { reader },
        layout: {},
        slots: {
          inject(_name, cb) {
            cb()
          },
          register(options, component) {
            registered.push({ options, component })
            return { dispose: async () => {} }
          },
        },
      }
      fn(inner)
      return { dispose: async () => {} }
    },
  }

  const dispose = await plugin.apply(ctx)
  assert.equal(mounts, 1)
  assert.equal(registered.length, 2)
  assert.deepEqual(registered[0].options, { name: 'main', key: 'reader' })
  assert.equal(registered[1].options.name, 'sidebar.panellist')
  assert.equal(registered[1].options.id, 'reader')
  assert.equal(typeof registered[0].component, 'function')

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(registered[0].component))
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  const text = dom.window.document.body.textContent ?? ''
  assert.match(text, /书架/)
  assert.match(text, /书源/)
  assert.match(text, /启用 1/)
  await act(async () => root.unmount())
  await dispose()
})

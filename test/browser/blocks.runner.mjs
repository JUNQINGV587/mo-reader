import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')
const chrome = process.env.CHROME_BIN || '/usr/bin/chromium'
const profile = await mkdtemp(path.join(tmpdir(), 'mo-reader-blocks-'))
let server
let browser
let socket

async function waitFor(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error(message)
}

try {
  server = await createServer({
    root,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/test/browser/blocks.html`

  browser = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let browserErrors = ''
  browser.stderr.on('data', (chunk) => { browserErrors += chunk })
  const devtools = await waitFor(async () => {
    try {
      const [webSocketPort] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
      return webSocketPort
    } catch { return null }
  }, `Chrome DevTools 未就绪：${browserErrors}`)
  const tabs = await fetch(`http://127.0.0.1:${devtools}/json/list`).then((response) => response.json())
  const page = tabs.find((entry) => entry.type === 'page')
  assert.ok(page?.webSocketDebuggerUrl, '找不到浏览器页面')

  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      console.error(JSON.stringify(message.params.exceptionDetails))
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      console.error(JSON.stringify(message.params.args))
    }
    if (!message.id) return
    const handlers = pending.get(message.id)
    if (!handlers) return
    pending.delete(message.id)
    if (message.error) handlers.reject(new Error(JSON.stringify(message.error)))
    else handlers.resolve(message.result)
  })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result?.value
  }

  await cdp('Runtime.enable')
  await cdp('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 700, deviceScaleFactor: 1, mobile: false,
  })
  await cdp('Page.navigate', { url })
  await waitFor(() => evaluate('document.readyState === "complete" && !!window.blocksTest'), '回归页面未初始化')
  const result = await evaluate('window.blocksTest', true)
  console.log(JSON.stringify(result, null, 2))
  assert.ok(result?.ok, '真实 DOM 图文块渲染回归失败')
} finally {
  if (socket) socket.close()
  if (browser) {
    browser.kill('SIGTERM')
    if (browser.exitCode === null) await new Promise((resolve) => browser.once('exit', resolve))
  }
  if (server) await server.close()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); break } catch (error) {
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

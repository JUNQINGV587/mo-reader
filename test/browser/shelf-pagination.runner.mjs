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
const profile = await mkdtemp(path.join(tmpdir(), 'mo-reader-shelf-pagination-'))
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
  const url = `http://127.0.0.1:${address.port}/test/browser/shelf-pagination.html`

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
  const pageErrors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') { pageErrors.push(message.params.exceptionDetails); console.error(JSON.stringify(message.params.exceptionDetails)) }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') { pageErrors.push(message.params.args); console.error(JSON.stringify(message.params.args)) }
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
  const viewport = async (width, height, mobile = false) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
    await delay(240)
  }

  await cdp('Runtime.enable')
  await viewport(1280, 800)
  await cdp('Page.navigate', { url })
  await waitFor(() => evaluate('document.readyState === "complete" && !!window.shelfReady'), '书架回归页面未初始化')
  const report = { desktop: await evaluate('window.shelfTest.desktopStart()', true), resizes: [] }
  assert.ok(report.desktop.navWidth >= 84, `桌面导航栏宽度不足：${report.desktop.navWidth}`)
  for (const [width, height] of [[1638, 901], [1920, 1080], [1050, 720], [1440, 900], [920, 640], [1280, 800]]) {
    await viewport(width, height)
    report.resizes.push(await evaluate('window.shelfTest.afterResize()', true))
  }
  report.tailLayout = await evaluate('window.shelfTest.tailLayout()', true)
  report.motion = await evaluate('window.shelfTest.desktopMotion()', true)
  report.selection = await evaluate('window.shelfTest.pollingAndSelection()', true)
  await viewport(1280, 1200)
  report.tallFilter = await evaluate('window.shelfTest.tallFilter()', true)

  await viewport(390, 844, true)
  await cdp('Page.reload', { ignoreCache: true })
  await delay(100)
  await waitFor(() => evaluate('document.readyState === "complete" && !!window.shelfTest && !!window.shelfReady'), '手机书架未初始化')
  report.mobile = await evaluate('window.shelfTest.mobileStart()', true)
  report.vertical = await evaluate(`(() => { const c = document.querySelector('.mr-content'); const before = c.scrollTop; c.scrollTop = 360; return { before, after: c.scrollTop, scrollHeight: c.scrollHeight, clientHeight: c.clientHeight } })()`)
  assert.ok(report.vertical.after > 200, `手机书架不能纵向滚动：${JSON.stringify(report.vertical)}`)
  report.swipe = await evaluate('window.shelfTest.mobileSwipeResult()')
  assert.equal(report.swipe.scrollLeft, 0, '手机书架仍有横向滚动')
  assert.equal(report.swipe.open, 0, '滚动误触打开书籍')
  assert.equal(report.swipe.toggle, 0, '滚动误触下载角标')
  assert.equal(report.swipe.select, 0, '滚动误触多选')
  await viewport(375, 667, true)
  report.mobileSmall = await evaluate('window.shelfTest.mobileSmall()', true)
  await viewport(390, 932, true)
  report.mobileTall = await evaluate('window.shelfTest.mobileTall()', true)
  assert.deepEqual(pageErrors, [], '浏览器出现脚本错误')
  report.ok = true
  console.log(JSON.stringify(report, null, 2))
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
      await delay(200)
    }
  }
}

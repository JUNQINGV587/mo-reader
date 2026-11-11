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
const profile = await mkdtemp(path.join(tmpdir(), 'mo-reader-screens-'))
let server
let browser
let socket
const waitFor = async (check, message, timeout = 8000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(50)
  }
  throw new Error(message)
}
try {
  server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/test/browser/screens.html`
  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let browserErrors = ''
  browser.stderr.on('data', (chunk) => { browserErrors += chunk })
  const devtools = await waitFor(async () => {
    try { return (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')[0] } catch { return null }
  }, `Chrome DevTools 未就绪：${browserErrors}`)
  const tabs = await fetch(`http://127.0.0.1:${devtools}/json/list`).then((response) => response.json())
  const page = tabs.find((entry) => entry.type === 'page')
  assert.ok(page?.webSocketDebuggerUrl, '找不到浏览器页面')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let nextId = 0
  const pending = new Map()
  const pageErrors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails)
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args)
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
    await delay(200)
  }
  await cdp('Runtime.enable')
  await viewport(1280, 800)
  await cdp('Page.navigate', { url })
  await waitFor(() => evaluate('document.readyState === "complete" && !!window.screensReady'), '四屏回归页面未初始化')
  const report = {}

  await evaluate('screensUI.discover(); true')
  await delay(250)
  report.discoverDesktop = await evaluate('screensUI.measure()', true)
  assert.equal(report.discoverDesktop.head, '发现')
  assert.equal(report.discoverDesktop.columns, 2)
  assert.equal(report.discoverDesktop.results, 2)
  assert.equal(report.discoverDesktop.warning, 1)
  assert.equal(report.discoverDesktop.sourceChips, 5)
  assert.ok(report.discoverDesktop.overflow <= 1280)
  assert.ok(report.discoverDesktop.screenWidth >= 700)

  await viewport(390, 844, true)
  await evaluate('screensUI.discover(); true')
  await delay(200)
  report.discoverMobile = await evaluate('screensUI.measure()', true)
  assert.equal(report.discoverMobile.display, 'block')
  assert.equal(report.discoverMobile.results, 2)
  assert.equal(report.discoverMobile.sourceChips, 5)
  assert.ok(report.discoverMobile.overflow <= 390)

  await viewport(1280, 800)
  await evaluate('screensUI.sources(); true')
  await delay(200)
  report.sourcesDesktop = await evaluate('screensUI.measure()', true)
  assert.equal(report.sourcesDesktop.head, '书源')
  assert.equal(report.sourcesDesktop.sourceRows, 6)
  assert.equal(report.sourcesDesktop.subscriptionRows, 4)
  assert.equal(report.sourcesDesktop.refreshButtons, 3)
  assert.equal(report.sourcesDesktop.checkingTags, 1)
  assert.equal(report.sourcesDesktop.failedTags, 1)
  assert.equal(report.sourcesDesktop.unsubscribeButtons, 4)
  assert.equal(report.sourcesDesktop.pendingTags, 1)
  assert.equal(report.sourcesDesktop.pendingPermissions, 1)
  assert.match(await evaluate("document.querySelector('.mr-pending-permissions').textContent", true), /新增脚本/)
  assert.match(await evaluate("document.querySelector('.mr-pending-changes').textContent", true), /新增：新站甲/)
  assert.match(await evaluate("document.querySelector('.mr-subscription-copy > span').textContent", true), /检查 \d{4}/)
  assert.ok(report.sourcesDesktop.pendingCopyWidth >= report.sourcesDesktop.pendingRowWidth * 0.8)
  assert.ok(report.sourcesDesktop.pendingActionsWidth >= report.sourcesDesktop.pendingRowWidth * 0.8)
  assert.equal(report.sourcesDesktop.confirmButtons, 1)
  assert.equal(report.sourcesDesktop.rejectButtons, 1)
  assert.equal(report.sourcesDesktop.disabledRows, 1)
  assert.equal(report.sourcesDesktop.toggleButtons, 5)
  assert.equal(report.sourcesDesktop.columns, 2)
  assert.ok(report.sourcesDesktop.onlineHeight >= 36)
  assert.ok(report.sourcesDesktop.overflow <= 1280)
  await evaluate(`window.__refreshClicked = null; document.querySelector('.mr-subscription-actions [title="立即检查订阅更新"]').click(); true`)
  assert.equal(await evaluate('window.__refreshClicked'), 'sub-1')
  await evaluate(`window.__confirmClicked = null; window.__rejectClicked = null; document.querySelector('.mr-subscription-actions [title="应用已获取并等待确认的更新"]').click(); document.querySelector('.mr-subscription-actions [title="放弃这次候选更新，继续使用旧版"]').click(); true`)
  assert.equal(await evaluate('window.__confirmClicked'), 'sub-4')
  assert.equal(await evaluate('window.__rejectClicked'), 'sub-4')

  await viewport(390, 844, true)
  await evaluate('screensUI.sources(); true')
  await delay(200)
  report.sourcesMobile = await evaluate('screensUI.measure()', true)
  assert.equal(report.sourcesMobile.sourceRows, 6)
  assert.equal(report.sourcesMobile.subscriptionRows, 4)
  assert.equal(report.sourcesMobile.refreshButtons, 3)
  assert.equal(report.sourcesMobile.checkingTags, 1)
  assert.equal(report.sourcesMobile.failedTags, 1)
  assert.equal(report.sourcesMobile.unsubscribeButtons, 4)
  assert.equal(report.sourcesMobile.pendingTags, 1)
  assert.equal(report.sourcesMobile.pendingPermissions, 1)
  assert.ok(report.sourcesMobile.pendingCopyWidth >= report.sourcesMobile.pendingRowWidth * 0.8)
  assert.ok(report.sourcesMobile.pendingActionsWidth >= report.sourcesMobile.pendingRowWidth * 0.8)
  assert.equal(report.sourcesMobile.confirmButtons, 1)
  assert.equal(report.sourcesMobile.rejectButtons, 1)
  assert.equal(report.sourcesMobile.disabledRows, 1)
  assert.equal(report.sourcesMobile.toggleButtons, 5)
  assert.ok(report.sourcesMobile.onlineHeight >= 36)
  assert.ok(report.sourcesMobile.overflow <= 390)

  await viewport(1280, 800)
  await evaluate('screensUI.settings(); true')
  await delay(250)
  report.settingsDesktop = await evaluate('screensUI.measure()', true)
  assert.equal(report.settingsDesktop.head, '设置')
  assert.equal(report.settingsDesktop.panels, 12)
  assert.equal(report.settingsDesktop.display, 'grid')
  assert.equal(report.settingsDesktop.columns, 2)

  await viewport(390, 844, true)
  await evaluate('screensUI.settings(); true')
  await delay(250)
  report.settingsMobile = await evaluate('screensUI.measure()', true)
  assert.equal(report.settingsMobile.panels, 12)
  assert.equal(report.settingsMobile.display, 'flex')
  assert.ok(Math.abs(report.settingsMobile.panelWidth - report.settingsMobile.screenWidth) <= 2)
  assert.ok(report.settingsMobile.overflow <= 390)
  assert.deepEqual(pageErrors, [])
  console.log(JSON.stringify({ ok: true, report }, null, 2))
} finally {
  try { socket?.close() } catch {}
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

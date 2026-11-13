import { Worker } from 'node:worker_threads'
import { ReaderError } from './errors.js'
import { cleanHeaders, fetchRemote, parseRemoteUrl } from './http.js'

const WORKER_SOURCE = String.raw`
const { parentPort } = require('node:worker_threads')
const vm = require('node:vm')
const pending = new Map()
let sequence = 0

function hostFetch(url, optionsJson) {
  const id = ++sequence
  parentPort.postMessage({ type: 'fetch', id, url, optionsJson })
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

parentPort.on('message', async message => {
  if (message.type === 'fetch-result') {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(JSON.stringify(message.response))
    else request.reject(new Error(message.message))
    return
  }
  if (message.type !== 'run') return
  try {
    const document = message.document
    const sandbox = Object.create(null)
    sandbox.__hostFetch = hostFetch
    const context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    })
    const bootstrap = 'const document = JSON.parse(' + JSON.stringify(JSON.stringify(document.kind === 'json' ? document.value : null)) + ');\n' +
      'const html = ' + JSON.stringify(document.html || '') + ';\n' +
      'const fetch = ((request) => (url, options) => new Promise((resolve, reject) => {\n' +
      '  request(String(url), JSON.stringify(options || {})).then(text => {\n' +
      '    const raw = JSON.parse(text)\n' +
      '    resolve({ url: raw.url, status: raw.status, headers: raw.headers, text: raw.text, json() { return JSON.parse(raw.text) } })\n' +
      '  }, error => reject(new Error(String(error))))\n' +
      '}))(__hostFetch);\n' +
      'delete globalThis.__hostFetch;'
    const contextSetup = '((values, missing) => {\n' +
      '  for (const name of Object.keys(values)) Object.defineProperty(globalThis, name, { value: values[name], writable: false, configurable: true, enumerable: true });\n' +
      '  for (const name of missing) Object.defineProperty(globalThis, name, { configurable: true, enumerable: false, get() { throw new Error(name + " 未定义") } });\n' +
      '})(' + JSON.stringify(message.context || {}) + ', ' + JSON.stringify(message.missing || []) + ');'
    vm.runInContext(bootstrap, context, { timeout: 100 })
    vm.runInContext(contextSetup, context, { timeout: 100 })
    let script
    try {
      script = new vm.Script('(function () { return (' + message.code + '); })()')
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      script = new vm.Script(message.code)
    }
    let value = await script.runInContext(context, { timeout: 250 })
    if (message.rawValue && Array.isArray(value)) value = await Promise.all(value)
    parentPort.postMessage({ type: 'result', ok: true, value: message.rawValue ? value : (value == null ? undefined : String(value)) })
  } catch (error) {
    parentPort.postMessage({ type: 'result', ok: false, message: String(error?.message || error) })
  }
})
`

// Legado binds these names for every @js rule. We only provide the ones the reader
// can honour; the rest fail loudly instead of reading as an undefined global.
const KNOWN_CONTEXT_NAMES = [
  'result', 'baseUrl', 'src', 'page', 'key', 'source',
  'bookUrl', 'bookName', 'chapterUrl', 'chapterTitle',
  'title', 'chapter', 'nextChapterUrl', 'isFromBookInfo',
  'java', 'cookie', 'cache', 'book', 'rssArticle', 'loginInfo', 'userInfo',
]

export function runSourceScript(code, { document, source, fetch = fetchRemote, timeoutMs = 500, context = {}, rawValue = false } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, env: {}, execArgv: ['--permission'] })
    let settled = false
    const finish = async (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      await worker.terminate()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      void finish(new ReaderError('reader/js-timeout', '书源 JS 执行超时，已停止', { cause: null }))
    }, timeoutMs + 500)
    worker.on('message', message => {
      if (message.type === 'fetch') {
        void (async () => {
          try {
            if (!source?.bookSourceUrl) throw new ReaderError('reader/js-network-forbidden', 'JS 请求缺少书源 origin 限制', { cause: null })
            const base = parseRemoteUrl(source.bookSourceUrl, { allowHttp: source.allowHttp })
            const remote = parseRemoteUrl(new URL(String(message.url), base).href, { allowHttp: source.allowHttp })
            if (remote.origin !== base.origin) throw new ReaderError('reader/js-network-forbidden', 'JS 只能请求当前书源 origin', { cause: null })
            const options = message.optionsJson ? JSON.parse(message.optionsJson) : {}
            const method = String(options.method || 'GET').toUpperCase()
            if (!['GET', 'POST'].includes(method)) throw new ReaderError('reader/unsupported-rule', `JS 请求方法 ${method} 不受支持`, { cause: null })
            const response = await fetch(remote.href, {
              method,
              headers: cleanHeaders(options.headers || {}),
              form: options.body === undefined ? undefined : String(options.body),
              allowHttp: source.allowHttp,
              allowedOrigin: base.origin,
            })
            if (!settled) worker.postMessage({ type: 'fetch-result', id: message.id, ok: true, response: {
              url: response.url || remote.href,
              status: response.status || 200,
              headers: response.headers || {},
              text: response.text || '',
            } })
          } catch (error) {
            if (!settled) worker.postMessage({ type: 'fetch-result', id: message.id, ok: false, message: String(error?.message || error) })
          }
        })()
        return
      }
      if (message.type === 'result') void finish(message.ok ? null : new ReaderError('reader/js-rule-failed', `书源 JS 执行失败：${message.message}`, { cause: null }), message.value)
    })
    worker.once('error', error => {
      void finish(new ReaderError('reader/js-rule-failed', `书源 JS 执行失败：${error.message}`, { cause: error }))
    })
    worker.once('exit', code => {
      if (!settled && code !== 0) void finish(new ReaderError('reader/js-rule-failed', `书源 JS 进程异常退出（${code}）`, { cause: null }))
    })
    const html = document?.html ?? (document?.kind === 'html' ? document.$.html() : '')
    const values = {}
    for (const [name, value] of Object.entries(context ?? {})) if (value !== undefined) values[name] = value
    const missing = KNOWN_CONTEXT_NAMES.filter(name => values[name] === undefined)
    worker.postMessage({ type: 'run', code, rawValue, document: { kind: document?.kind, value: document?.value, html }, context: values, missing })
  })
}

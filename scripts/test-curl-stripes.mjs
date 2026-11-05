import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chromium = process.env.CHROMIUM || '/usr/bin/chromium';
const requestedSource = process.env.CURL_SRC || '/src/three-entry.js';
const source = `${requestedSource}${requestedSource.includes('?') ? '&' : '?'}v=${Date.now()}`;
const direction = process.env.CURL_DIRECTION || '1';
const width = process.env.CURL_WIDTH || '944';
const height = process.env.CURL_HEIGHT || '605';
const duration = process.env.CURL_DURATION || '680';
const freeze = process.env.CURL_PROGRESS === 'time' ? '' : process.env.CURL_PROGRESS || '0.65';
const requestedPath = new URL(requestedSource, 'http://localhost').pathname;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
let server;
let browser;
let profile;
let socket;

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

async function evaluate(send, sessionId, expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}

try {
  await stat(chromium);
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const path = resolve(root, `.${pathname}`);
      if (path !== root && !path.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end();
        return;
      }
      let body = await readFile(path);
      if (freeze && pathname === requestedPath) {
        const text = body.toString('utf8');
        const timer = 'const raw = Math.min(1, Math.max(0, (performance.now() - started) / duration))';
        if (!text.includes(timer)) throw new Error(`找不到卷曲计时语句：${requestedPath}`);
        body = Buffer.from(text.replace(timer, `const raw = ${Number(freeze)}`));
      }
      response.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const probeUrl = new URL(`http://127.0.0.1:${server.address().port}/docs/evidence/curl-20261105/probe.html`);
  probeUrl.searchParams.set('w', width);
  probeUrl.searchParams.set('h', height);
  probeUrl.searchParams.set('d', duration);
  probeUrl.searchParams.set('dir', direction);
  probeUrl.searchParams.set('src', source);

  profile = await mkdtemp(join(tmpdir(), 'mo-curl-stripes-'));
  browser = spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--window-size=1000,800', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const devtoolsUrl = await new Promise((resolveDevtools, rejectDevtools) => {
    const timeout = setTimeout(() => rejectDevtools(new Error('Chromium 未在 15 秒内提供 CDP 地址')), 15000);
    browser.once('error', rejectDevtools);
    browser.stderr.on('data', chunk => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolveDevtools(match[1]);
      }
    });
  });

  socket = new WebSocket(devtoolsUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', rejectOpen, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve: resolveCommand, reject: rejectCommand } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectCommand(new Error(JSON.stringify(message.error)));
    else resolveCommand(message.result || {});
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolveCommand, rejectCommand) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: probeUrl.href }, sessionId);

  const deadline = Date.now() + 10000;
  let result;
  while (Date.now() < deadline) {
    result = await evaluate(send, sessionId, `(() => {
      const p = window.__probe;
      return p ? { done: p.done, frames: p.stripeFrames || 0, maxScore: p.maxStripeScore || 0,
        worstFrame: p.worstStripeFrame ?? null, handle: p.handle || false } : null;
    })()`);
    if (freeze ? (result?.frames || 0) >= 10 : result?.done) break;
    await sleep(50);
  }
  await send('Target.closeTarget', { targetId });
  const minimumFrames = freeze ? 10 : 3;
  if ((!freeze && !result?.done) || !result?.handle || result.frames < minimumFrames) {
    console.log(JSON.stringify({ status: 'ERROR', source, direction, fixedProgress: freeze || null, ...result }, null, 2));
    process.exitCode = 2;
  } else {
    const failed = result.maxScore >= 6;
    console.log(JSON.stringify({ status: failed ? 'FAIL' : 'PASS', source, direction, fixedProgress: freeze || null, threshold: 6, ...result }, null, 2));
    process.exitCode = failed ? 1 : 0;
  }
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 2;
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM');
    await new Promise(resolveExit => {
      const timeout = setTimeout(resolveExit, 2000);
      browser.once('exit', () => { clearTimeout(timeout); resolveExit(); });
    });
  }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

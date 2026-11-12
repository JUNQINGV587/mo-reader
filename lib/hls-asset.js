import fs from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let script

export async function hlsAssetResponse(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  if (!script) script = await fs.readFile(require.resolve('hls.js/dist/hls.min.js'))
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': String(script.length),
    'cache-control': 'public, max-age=3600',
    'x-content-type-options': 'nosniff',
  }
  return new Response(request.method === 'HEAD' ? null : script, { status: 200, headers })
}

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import * as esbuild from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [pkg, threePkg] = await Promise.all([
  readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(root, 'node_modules/three/package.json'), 'utf8').then(JSON.parse),
])

const chunkFile = process.env.MO_READER_CHUNK || 'client.three.js'
const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/three-entry.js'],
  bundle: true,
  format: 'iife',
  globalName: '__MO_READER_THREE__',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  outfile: chunkFile,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `/* @local/mo-reader ${pkg.version} | three.js r${threePkg.version.split('.')[1]} | MIT License | https://threejs.org */`,
  },
  footer: {
    js: `window.__ModuleLoader__.load({id:'@local/mo-reader',chunk:'${chunkFile}',factory(){return window.__MO_READER_THREE__;}});`,
  },
})

if (result.errors?.length) {
  console.error(result.errors)
  process.exitCode = 1
} else {
  const output = path.join(root, chunkFile)
  const bytes = (await readFile(output)).byteLength
  console.log(`${chunkFile} ${(bytes / 1024).toFixed(1)} KiB (three r${threePkg.version})`)
}

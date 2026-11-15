import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, 'src/web/client.ts'),
      formats: ['cjs'],
      fileName: () => 'client.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'zod'],
    },
  },
})

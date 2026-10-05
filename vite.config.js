import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      // Directs Vite to use the 'events' polyfill you installed via npm
      events: 'events',
    },
  },
  define: {
    // Defines 'global' as 'globalThis' (the browser equivalent)
    // to prevent "global is not defined" errors in the thrift library
    global: 'globalThis',
  },
  optimizeDeps: {
    // This package ships a Web Worker via `new Worker(new URL('./worker.js',
    // import.meta.url))`. Vite's dep pre-bundling rewrites `import.meta.url`
    // into `.vite/deps/` where the worker file does not exist, so the decoder
    // worker fails to load and tiles never decode. Excluding it serves the
    // worker from source so Vite transforms it correctly.
    exclude: ['@developmentseed/geotiff'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  worker: {
    // The geotiff decoder worker is an ES module; Vite's default IIFE worker
    // output is not supported for code-splitting builds.
    format: 'es',
  },
  base: '/',
})

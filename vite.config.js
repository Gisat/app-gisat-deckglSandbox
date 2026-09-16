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
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Proxy the two TiTiler stacks through the same-origin Vite dev server.
    // The page is served under COEP require-corp, which blocks cross-origin
    // fetches to localhost:8000/:8001 (ERR_BLOCKED_BY_RESPONSE...Coep). Curl /
    // the benchmark scripts bypass this (no browser), so the cache worked there
    // but not in the app. Proxying makes the browser talk only to localhost:5173
    // (same-origin) -> no COEP block, no CORS. Both stacks stay selectable.
    proxy: {
      // ORDER MATTERS: Vite matches by URL-prefix, first match wins. The more
      // specific '/titiler-plain' MUST come before '/titiler', otherwise a
      // request to /titiler-plain/... would match '/titiler' and hit the wrong
      // (caching) stack.
      //
      // Each entry also REWRITES away its mount prefix before forwarding:
      // Vite proxies the full original path, so without rewrite a request like
      // /titiler/api/v1/titiler/healthz would be sent as
      // http://localhost:8001/titiler/api/v1/titiler/healthz, which nginx's
      // `location /api/v1/titiler/` does not match -> 404.
      // plain stack: /titiler-plain/healthz -> http://localhost:8000/healthz
      //              /titiler-plain/cog/...  -> http://localhost:8000/cog/...
      '/titiler-plain': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/titiler-plain/, ''),
      },
      // caching stack: /titiler/api/v1/titiler/healthz -> http://localhost:8001/api/v1/titiler/healthz
      //                /titiler/api/v1/titiler/cog/...  -> http://localhost:8001/api/v1/titiler/cog/...
      //
      // IMPORTANT: the prefix is '/titiler/api' — NOT '/titiler'. The SPA has
      // app routes that themselves begin with '/titiler' (e.g.
      // /titiler-demo-terrarium-terrain). A bare '/titiler' prefix would make
      // Vite proxy those app routes to nginx on hard reload (CTRL-SHIFT-R), which
      // answers `location / { return 404; }` -> 404 nginx. All real caching-stack
      // URLs live under /titiler/api, so narrowing to that kills the collision.
      '/titiler/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/titiler/, ''),
      },
    },
  },
  base: '/',
})

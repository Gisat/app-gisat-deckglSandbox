import { defineConfig, logger } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @developmentseed/affine and @developmentseed/geotiff publish sourcemaps whose
// `sources` point at .ts files that are stripped from the npm tarball; Vite's
// dev server logs noisy "points to missing source files" warnings on every
// startup. The packages work fine — the maps are just incomplete. Filter only
// those exact warnings so the terminal stays clean.
const quietMissingSourcemapSources = ['@developmentseed/affine', '@developmentseed/geotiff'];

// luma.gl's Texture class has `static defaultProps = { usage: Texture.SAMPLE |
// Texture.RENDER | Texture.COPY_DST }`, i.e. it references the class from within
// a static field initializer. Rollup 4 emits that class as an anonymous
// assignment (e.g. `er = class extends Resource { ... usage: er.SAMPLE ... }`),
// so the self-reference is still undefined while the static fields initialize
// and the production bundle crashes at startup with
// "Cannot read properties of undefined (reading 'SAMPLE')".
// The flags are immutable constants, so we inline their numeric values to
// remove the self-reference.
const LUMA_TEXTURE_FLAGS = {
  SAMPLE: '0x04',
  STORAGE: '0x08',
  RENDER: '0x10',
  COPY_SRC: '0x01',
  COPY_DST: '0x02',
  TEXTURE: '0x04',
  RENDER_ATTACHMENT: '0x10',
};

function patchLumaTexture() {
  return {
    name: 'patch-luma-texture-static-fields',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('@luma.gl/core') || !id.endsWith('/adapter/resources/texture.js')) {
        return null;
      }
      return code.replace(
        /\bTexture\.(SAMPLE|STORAGE|RENDER|COPY_SRC|COPY_DST|TEXTURE|RENDER_ATTACHMENT)\b/g,
        (_match, flag) => LUMA_TEXTURE_FLAGS[flag],
      );
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [patchLumaTexture(), react(), wasm(), topLevelAwait()],
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
    customLogger: {
      ...logger,
      warn(msg, options) {
        if (
          msg.includes('points to missing source files') &&
          quietMissingSourcemapSources.some((p) => msg.includes(p))
        ) {
          return; // @developmentseed packages publish incomplete sourcemaps
        }
        logger.warn(msg, options);
      },
    },
    // Proxy the caching TiTiler stack through the same-origin Vite dev server.
    // The page is served under COEP require-corp, which blocks cross-origin
    // fetches to localhost:8001 (ERR_BLOCKED_BY_RESPONSE...Coep). Curl /
    // the benchmark scripts bypass this (no browser), so the cache worked there
    // but not in the app. Proxying makes the browser talk only to localhost:5173
    // (same-origin) -> no COEP block, no CORS.
    proxy: {
      //
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
  worker: {
    // The geotiff decoder worker is an ES module; Vite's default IIFE worker
    // output is not supported for code-splitting builds.
    format: 'es',
  },
  base: '/',
})

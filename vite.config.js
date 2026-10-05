import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

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
  },
  worker: {
    // The geotiff decoder worker is an ES module; Vite's default IIFE worker
    // output is not supported for code-splitting builds.
    format: 'es',
  },
  base: '/',
})

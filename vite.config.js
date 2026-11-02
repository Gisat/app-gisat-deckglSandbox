/* global process */
import { defineConfig, createLogger } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// @developmentseed/affine and @developmentseed/geotiff publish sourcemaps whose
// `sources` point at .ts files that are stripped from the npm tarball; Vite's
// dev server logs noisy "points to missing source files" warnings on every
// startup. The packages work fine — the maps are just incomplete. Filter only
// those exact warnings so the terminal stays clean.
const quietMissingSourcemapSources = ['@developmentseed/affine', '@developmentseed/geotiff'];

// Vite has no public `logger` export; `createLogger()` is the supported entry
// point. Wrap its warn() so only the @developmentseed sourcemap noise is
// dropped and every other warning still reaches the terminal.
const logger = createLogger();
const originalWarn = logger.warn.bind(logger);
logger.warn = (msg, options) => {
  if (
    msg.includes('points to missing source files') &&
    quietMissingSourcemapSources.some((p) => msg.includes(p))
  ) {
    return; // @developmentseed packages publish incomplete sourcemaps
  }
  originalWarn(msg, options);
};

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

// --- Tileserver proxy instrumentation -------------------------------------
// The app reaches tileserver-rs (:8080) through this dev-server proxy. During
// low-zoom panning the app sometimes shows "tileserver-rs became unreachable"
// even though the server answers /health in ~0.04 ms. Hypothesis: the probe
// and the tile streams share the browser's ~6 sockets AND this proxy, so the
// probe queues (client-side or in the proxy) and times out before it is ever
// sent. This plugin makes that observable WITHOUT changing behaviour: it
// counts in-flight proxied requests, stamps each with a start time, and emits
// a one-line report on a fixed interval plus a WARN whenever a health probe
// had to wait behind other in-flight requests.
//
// Reading the output:
//   - "probe waited behind N in-flight"  -> the proxy queue delayed the probe.
//   - "inflight" climbing near/vlast the browser's per-host socket cap (~6 on
//     HTTP/1.1) -> browser socket exhaustion, not a server problem.
//   - steady "p50/p99" tile latency with low inflight -> the tileserver itself
//     is the slow part (look at its own log), not the proxy.
// Set TILESERVER_PROXY_INSTRUMENT=0 to disable, or =verbose for per-request
// lines. It is safe to leave on; it only reads counters and timestamps.
function tileserverProxyInstrumentation() {
    const enabled = process.env.TILESERVER_PROXY_INSTRUMENT !== '0';
    const verbose = process.env.TILESERVER_PROXY_INSTRUMENT === 'verbose';
    const isTile = (url) => /\/data\/io-lulc\//.test(url) || /\/data\/manila-rgb\//.test(url);
    const isProbe = (url) => /\/health(\?|$)/.test(url);
    let inflight = 0;
    let peakInflight = 0;
    let totalRequests = 0;
    let tileFinished = 0;
    let tileAborted = 0;
    let probeCount = 0;
    let probeWaited = 0;
    let probeMaxInflightAtStart = 0;
    const tileLatencies = [];
    return {
        name: 'tileserver-proxy-instrumentation',
        configureServer(server) {
            if (!enabled) return;
            server.middlewares.use((req, res, next) => {
                const url = req.url || '';
                if (!url.startsWith('/tileserver-api')) return next();
                const inFlightAtStart = inflight;
                inflight += 1;
                totalRequests += 1;
                if (inflight > peakInflight) peakInflight = inflight;
                // The probe is what the app uses to decide reachability. Record
                // how much other proxied work it started behind: that queue is
                // the leading candidate for the "became unreachable" banner.
                if (isProbe(url)) {
                    probeCount += 1;
                    if (inFlightAtStart > 0) {
                        probeWaited += 1;
                        if (inFlightAtStart > probeMaxInflightAtStart) {
                            probeMaxInflightAtStart = inFlightAtStart;
                        }
                        // eslint-disable-next-line no-console
                        console.warn(
                            `[ts-proxy] WARN health probe started while ${inFlightAtStart} proxied request(s) in flight (total inflight ${inflight})`,
                        );
                    }
                }
                const start = process.hrtime.bigint();
                let settled = false;
                const settle = (why) => {
                    if (settled) return;
                    settled = true;
                    inflight -= 1;
                    const ms = Number(process.hrtime.bigint() - start) / 1e6;
                    if (isTile(url)) tileLatencies.push(ms);
                    // Count WHY a request ended. `finish` = completed normally;
                    // `close` without finish = client aborted / socket dropped /
                    // proxy errored. A large aborted share is itself the finding.
                    if (why === 'finish') tileFinished += 1;
                    else tileAborted += 1;
                    if (verbose) {
                        // eslint-disable-next-line no-console
                        console.log(
                            `[ts-proxy] ${why} ${res.statusCode} ${ms.toFixed(0)}ms inflight@start=${inFlightAtStart} ${url}`,
                        );
                    }
                };
                res.on('finish', () => settle('finish'));
                res.on('close', () => settle('close'));
                next();
            });
            // Periodic one-line report so a long pan can be read at a glance.
            const report = setInterval(() => {
                if (totalRequests === 0 && inflight === 0) return;
                tileLatencies.sort((a, b) => a - b);
                const pct = (p) =>
                    tileLatencies.length
                        ? tileLatencies[Math.min(tileLatencies.length - 1, Math.floor(tileLatencies.length * p))].toFixed(0)
                        : 'n/a';
                const line =
                    `[ts-proxy] report total=${totalRequests} tileN=${tileLatencies.length} ` +
                    `tileP50=${pct(0.5)}ms tileP90=${pct(0.9)}ms tileP99=${pct(0.99)}ms ` +
                    `finished=${tileFinished} aborted=${tileAborted} ` +
                    `probes=${probeCount} probeWaited=${probeWaited} probeMaxBehind=${probeMaxInflightAtStart} ` +
                    `inflight=${inflight} peakInflight=${peakInflight}`;
                // eslint-disable-next-line no-console
                console.log(line);
                // Roll the window so the next report is a fresh interval.
                tileLatencies.length = 0;
                totalRequests = 0;
                tileFinished = 0;
                tileAborted = 0;
                probeCount = 0;
                probeWaited = 0;
                probeMaxInflightAtStart = 0;
                peakInflight = 0;
            }, 10000);
            // eslint-disable-next-line no-console
            console.log('[ts-proxy] instrumentation enabled (interval report every 10s; set TILESERVER_PROXY_INSTRUMENT=verbose for per-request lines, =0 to disable)');
            server.httpServer?.on('close', () => clearInterval(report));
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig({
  customLogger: logger,
  plugins: [patchLumaTexture(), tileserverProxyInstrumentation(), react(), wasm(), topLevelAwait()],
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
      // tileserver-rs stack (Tileserver-RS DEMO): '/tileserver-api/data/...'
      // -> http://localhost:8080/data/...
      //
      // WHY '/tileserver-api' AND NOT '/tileserver': the SPA has app routes
      // that begin with '/tileserver' (/tileserver-manila-rgb) — the
      // exact collision documented above
      // for '/titiler'. A bare '/tileserver' prefix would make Vite proxy
      // those app routes to the tile server on hard reload. All real stack
      // URLs live under /tileserver-api, so the narrow prefix kills the
      // collision.
      '/tileserver-api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/tileserver-api/, ''),
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

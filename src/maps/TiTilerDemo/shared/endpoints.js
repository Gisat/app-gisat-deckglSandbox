// TiTiler endpoint definitions + shared constants/helpers for the TiTiler DEMO
// category. One source of truth for the caching stack's API base, so the
// endpoint switcher and the error modal always agree on the resolved URL.

// Base prefix under which the TiTiler caching stack's nginx serves ALL three
// services (deploy/titiler-caching/docker-compose.yml): /titiler, /float32,
// /terrarium. Local default is the COEP-safe Vite proxy path (same-origin).
const DEFAULT_TITILER_API_BASE = '/titiler/api/v1';

// Resolve the effective TiTiler stack base. ONE source of truth, in order:
//   1. window.TITILER_API_BASE        — runtime, injected by serve_web.py from
//                                      the TITILER_API_BASE env var (deployment
//                                      path: no rebuild, wins).
//   2. import.meta.env.VITE_TITILER_API_BASE — build-time override.
//   3. import.meta.env.VITE_TITILER_URL      — legacy build-time override; a
//                                      full URL is normalized to the stack base
//                                      by stripping a trailing "/titiler" seg.
//   4. DEFAULT_TITILER_API_BASE       — local dev default.
// COG URLs are NOT affected: they stay demo-specific and unchanged.
function getTiTilerApiBase() {
    const runtime = typeof window !== 'undefined' && window.TITILER_API_BASE;
    if (runtime) return runtime;
    const built = import.meta.env.VITE_TITILER_API_BASE;
    if (built) return built;
    const legacy = import.meta.env.VITE_TITILER_URL;
    if (legacy) return legacy.replace(/\/titiler\/?$/, '').replace(/\/+$/, '');
    return DEFAULT_TITILER_API_BASE;
}

const CACHING_ENDPOINT = {
    label: 'TiTiler + cache',
    // '{base}/titiler/...' -> nginx :8001/api/v1/titiler/... in local dev.
    startCommand: 'docker compose -f deploy/titiler-caching/docker-compose.yml up -d',
};
// Resolved once at module init so every consumer sees the same base (runtime
// global, build-time override, or bundled default).
CACHING_ENDPOINT.baseUrl = `${getTiTilerApiBase()}/titiler`;

const DEFAULT_TITILER_ENDPOINTS = { caching: CACHING_ENDPOINT };
const TITILER_ENDPOINTS = DEFAULT_TITILER_ENDPOINTS;

const ENDPOINT_STORAGE_KEY = 'titiler-demo-endpoint';

function getInitialEndpointId() {
    // Remember the last choice across demos/reloads; stale ids (e.g. the
    // retired 'plain') and storage-absence all settle on the single 'caching'
    // endpoint, whose base is resolved by getTiTilerApiBase().
    try {
        const stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
        if (stored && TITILER_ENDPOINTS[stored]) return stored;
    } catch {
        /* storage unavailable (e.g. private mode) — use default */
    }
    return 'caching';
}

// Shared measurement/health constants (a single copy instead of per-file).
const HEALTH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const TILE_ERROR_GRACE_MS = 500;
const HEALTH_CHECK_INTERVAL_MS = 10000;
// Timing measurement: single tunable knob. Used BOTH as the viewport-settle
// debounce (wait for camera to stop before starting the clock) AND as the
// quiescence threshold (a window closes when no new tile load arrives for this
// long = "all tiles" for the settled viewport).
const TIMING_SETTLE_MS = 800;

function fetchWithTimeout(url, timeoutMs, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal, ...options }).finally(() => clearTimeout(timer));
}

/**
 * Reachability check that tolerates CORS-less servers and TiTiler builds
 * without a /healthz route (404): ANY HTTP response means the endpoint is up,
 * so only a total network failure (or timeout) counts as unreachable.
 * Real per-request problems surface later via onTileError + the z0 probe.
 */
async function isTiTilerReachable(healthUrl) {
    try {
        await fetchWithTimeout(healthUrl, HEALTH_TIMEOUT_MS);
        return true; // server answered (any status) -> reachable
    } catch {
        // CORS-blocked fetch rejects with TypeError even when the server is up —
        // retry in no-cors mode: resolves (opaque) whenever the server answers.
        try {
            await fetchWithTimeout(healthUrl, HEALTH_TIMEOUT_MS, { mode: 'no-cors' });
            return true;
        } catch {
            return false; // genuinely unreachable
        }
    }
}

export {
    DEFAULT_TITILER_ENDPOINTS,
    TITILER_ENDPOINTS,
    ENDPOINT_STORAGE_KEY,
    getInitialEndpointId,
    getTiTilerApiBase,
    HEALTH_TIMEOUT_MS,
    PROBE_TIMEOUT_MS,
    TILE_ERROR_GRACE_MS,
    HEALTH_CHECK_INTERVAL_MS,
    TIMING_SETTLE_MS,
    fetchWithTimeout,
    isTiTilerReachable,
};

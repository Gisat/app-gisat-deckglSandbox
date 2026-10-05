// TiTiler endpoint definitions + shared constants/helpers for the TiTiler DEMO
// category. One source of truth for the local caching stack and the custom
// override (VITE_TITILER_URL), so the endpoint switcher and the error modal
// always agree on which stack to start.

// Selectable TiTiler endpoints. 'caching' mirrors deploy/titiler-caching/docker-compose.yml
// (nginx :8001 -> TiTiler :8081, URL prefix /api/v1/titiler stripped by nginx); it is the
// only local stack since deploy/titiler (plain uvicorn :8000) was retired. The
// startCommand is shown by the error modal so it always tells you which
// stack to start for the currently selected endpoint.
const DEFAULT_TITILER_API_BASE = '/titiler/api/v1';

// Runtime-resolved base prefix of the TiTiler caching stack's API (one nginx
// serves titiler / float32 / terrarium under this prefix). Resolution order
// mirrors basemaps.js: injected runtime window global (serve_web.py, from
// TITILER_API_BASE env) -> Vite build-time env -> bundled local default.
// Same-origin default keeps the COEP-safe proxy working in local dev; set
// TITILER_API_BASE (or VITE_TITILER_API_BASE) to redeploy the app on other
// infrastructure without rebuilding.
function getTiTilerApiBase() {
    return (
        (typeof window !== 'undefined' && window.TITILER_API_BASE) ||
        import.meta.env.VITE_TITILER_API_BASE ||
        DEFAULT_TITILER_API_BASE
    );
}

const DEFAULT_TITILER_ENDPOINTS = {
    caching: {
        label: 'TiTiler + cache',
        // '/titiler/api/v1/titiler/...' -> http://localhost:8001/api/v1/titiler/...
        // (base resolved at runtime via getTiTilerApiBase())
        baseUrl: null, // filled in below from getTiTilerApiBase()
        startCommand: 'docker compose -f deploy/titiler-caching/docker-compose.yml up -d',
    },
};
// Fill the caching endpoint's baseUrl at module init so every consumer sees the
// same resolved runtime prefix (local default, VITE override, or injected global).
DEFAULT_TITILER_ENDPOINTS.caching.baseUrl = `${getTiTilerApiBase()}/titiler`;

// Optional override for a deployed/custom instance (see .env.example):
// VITE_TITILER_URL=https://your-deployed-titiler.example
const CUSTOM_TITILER_URL = import.meta.env.VITE_TITILER_URL;

// Presets plus the env override when it points somewhere else.
const TITILER_ENDPOINTS = (() => {
    const endpoints = { ...DEFAULT_TITILER_ENDPOINTS };
    if (CUSTOM_TITILER_URL && !Object.values(DEFAULT_TITILER_ENDPOINTS).some(ep => ep.baseUrl === CUSTOM_TITILER_URL)) {
        endpoints.custom = {
            label: 'Custom (env)',
            baseUrl: CUSTOM_TITILER_URL,
            startCommand: null, // deployment-specific, not a local compose stack
        };
    }
    return endpoints;
})();

const ENDPOINT_STORAGE_KEY = 'titiler-demo-endpoint';

function getInitialEndpointId() {
    // Remember the last choice across demos/reloads (comparison workflow);
    // fall back to the VITE_TITILER_URL override when configured, else caching.
    // A stale stored id (e.g. 'plain' after its retirement) is ignored here and
    // components fall back to 'caching'.
    try {
        const stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY);
        if (stored && TITILER_ENDPOINTS[stored]) return stored;
    } catch {
        /* storage unavailable (e.g. private mode) — use defaults */
    }
    if (!CUSTOM_TITILER_URL) return 'caching';
    const match = Object.keys(DEFAULT_TITILER_ENDPOINTS)
        .find(id => DEFAULT_TITILER_ENDPOINTS[id].baseUrl === CUSTOM_TITILER_URL);
    return match || 'custom';
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

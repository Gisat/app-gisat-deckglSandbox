// Tileserver-RS endpoint definitions + shared helpers for the Tileserver-RS
// DEMO category. One source of truth for the local stack, mirroring
// TiTilerDemo/shared/endpoints.js.
//
// The single local stack mirrors deploy/tileserver/docker-compose.yml
// (tileserver-rs on :8080, built from ../../../tileserver-rs — the sibling
// repo checkout on branch feat/identity-raster-cache, which adds identity
// raster-tile caching). The app reaches it same-origin through the Vite
// dev-server proxy '/tileserver-api/...' -> http://localhost:8080/...
// (COEP-safe, same pattern as the TiTiler stacks), so baseUrl is a path.
//
// WHY '/tileserver-api' AND NOT '/tileserver': the SPA has app routes that
// begin with '/tileserver' (/tileserver-manila-rgb). A bare
// '/tileserver' proxy prefix would
// make Vite proxy those routes to the tile server on hard reload — the exact
// collision documented for '/titiler' in vite.config.js. '/tileserver-api'
// is not a prefix of any app route.

// Generic timing/health helpers are shared with the TiTiler category (they
// are pure functions with no TiTiler-specific behavior). Re-exported here so
// the Tileserver-RS category has one local import surface and the two
// categories cannot drift apart.
export {
    HEALTH_TIMEOUT_MS,
    PROBE_TIMEOUT_MS,
    TILE_ERROR_GRACE_MS,
    HEALTH_CHECK_INTERVAL_MS,
    TIMING_SETTLE_MS,
    fetchWithTimeout,
    isTiTilerReachable as isTileServerReachable,
} from '../../TiTilerDemo/shared/endpoints';

// The one and only tileserver-rs endpoint (no switcher needed — unlike
// TiTiler there is a single local deployment).
const TILESERVER_ENDPOINT = {
    label: 'tileserver-rs',
    // Same-origin Vite proxy path (vite.config.js server.proxy):
    // '/tileserver-api/data/...' -> http://localhost:8080/data/...'
    baseUrl: '/tileserver-api',
    healthUrl: '/tileserver-api/health',
    startCommand: 'docker compose -f deploy/tileserver/docker-compose.yml up -d --build',
};

// Upstream origin of the local stack (deploy/tileserver/docker-compose.yml maps
// 8080:8080). Only used for the panel tooltip — never as a request target,
// because the browser must go through the same-origin proxy (COEP-safe).
const TILESERVER_UPSTREAM_ORIGIN = 'http://localhost:8080';

/**
 * Fully-qualified URL of the endpoint, for display and copy-to-clipboard.
 *
 * `baseUrl` above is same-origin (a bare proxy path), which is useless once
 * copied out of the browser — this adds protocol + host + port so the value can
 * be pasted into curl / Postman / another tool.
 *
 * Precedence mirrors the TiTiler knob (see public/config.js):
 *   1. window.TILESERVER_PUBLIC_URL       — runtime, injected by serve_web.py
 *      from the TILESERVER_PUBLIC_URL env var (no rebuild; per-deployment).
 *   2. import.meta.env.VITE_TILESERVER_PUBLIC_URL — build-time fallback for
 *      static hosts that cannot run serve_web.py.
 *   3. Default: `window.location.origin + '/tileserver-api'` — the endpoint the
 *      browser actually requests, fully qualified. Correct in `npm run dev`
 *      (Vite proxy) and for a same-origin deployment; set the knob for anything
 *      else (a tileserver on another host, a different prefix).
 *
 * Read once per page load, which is correct for a per-deployment knob.
 */
function getTileserverPublicUrl() {
    const trim = (v) => String(v).replace(/\/+$/, '');
    if (typeof window !== 'undefined' && window.TILESERVER_PUBLIC_URL) {
        return trim(window.TILESERVER_PUBLIC_URL);
    }
    if (import.meta.env.VITE_TILESERVER_PUBLIC_URL) {
        return trim(import.meta.env.VITE_TILESERVER_PUBLIC_URL);
    }
    if (typeof window !== 'undefined' && window.location) {
        return window.location.origin + TILESERVER_ENDPOINT.baseUrl;
    }
    return TILESERVER_ENDPOINT.baseUrl;
}

export { TILESERVER_ENDPOINT, TILESERVER_UPSTREAM_ORIGIN, getTileserverPublicUrl };

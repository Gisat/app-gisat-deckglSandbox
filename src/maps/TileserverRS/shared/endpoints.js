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
// begin with '/tileserver' (/tileserver-sentinel2-mosaic). A bare
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

export { TILESERVER_ENDPOINT };

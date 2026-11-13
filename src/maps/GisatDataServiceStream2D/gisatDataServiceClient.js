// Thin client for the Gisat be-gisdata data service.
//
// The dev server proxies /be-gisdata -> https://pantherbackoffice-dev.gisat.cz/be-gisdata
// (see vite.config.js) because the service sends no CORS headers and the page is
// served under COEP require-corp. Override with window.GISAT_BE_GISDATA_URL or
// VITE_GISAT_BE_GISDATA_URL when the service allows direct cross-origin access.
export const BASE_URL =
    (typeof window !== 'undefined' && window.GISAT_BE_GISDATA_URL) ||
    import.meta.env.VITE_GISAT_BE_GISDATA_URL ||
    '/be-gisdata';

// Single constant to swap when the full EGMS dataset is uploaded.
export const DOCUMENT_ID = 'egms_optimized_gisatdataservice_v3_subset';

// Manual trigger only (server-mutating); set true to prepare on app mount.
export const AUTO_PREPARE = false;

// Attributes always requested alongside the timeline columns.
export const BASE_ATTRIBUTES = [
    'pid',
    'fid',
    'height',
    'latitude',
    'longitude',
    'mean_velocity',
    'mean_velocity_std',
];

// The dev proxy serves the SPA index.html for unknown paths, so a missing
// /be-gisdata proxy (stale dev server) shows up as a 200 HTML response.
// Fail loudly instead of a confusing JSON parse error.
async function readJson(res, label) {
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`${label} ${res.status}`);
    if (contentType.includes('text/html')) {
        throw new Error(`${label}: got HTML — the /be-gisdata dev proxy is missing (restart the Vite dev server)`);
    }
    return res.json();
}

export async function fetchStats(documentId = DOCUMENT_ID) {
    const res = await fetch(`${BASE_URL}/query/stats/${documentId}`);
    return readJson(res, 'query/stats');
}

// The timeline is stored as regular `d_YYYYMMDD` attributes (attributesTimeseries
// is empty), so the date list comes from the stats attribute names.
export function extractTimeline(stats) {
    const names = (stats?.attributes || []).map((a) => a.name);
    const dateColumns = names.filter((n) => /^d_\d{8}$/.test(n)).sort();
    const dates = dateColumns.map((c) => `${c.slice(2, 6)}-${c.slice(6, 8)}-${c.slice(8, 10)}`);
    return { dateColumns, dates };
}

// One MVT tile can carry ALL timeline columns in a single request — that single
// tile per z/x/y is the animation prefetch. bypass_cache=true forces live SQL
// while no prepared tile variant exists (mvtPrepared:false); after a successful
// mvt-prepare, drop the flag to serve the prepared tiles.
export function mvtAttributesUrlTemplate(attributes, { documentId = DOCUMENT_ID, bypassCache = true } = {}) {
    const params = bypassCache ? 'bypass_cache=true&' : '';
    return `${BASE_URL}/query/mvt-attributes/${documentId}/{z}/{x}/{y}?${params}attributes=${attributes.join(',')}`;
}

export async function prepareMvt({ zMin = 0, zMax = 14, attributes, documentId = DOCUMENT_ID } = {}) {
    const params = `z_min=${zMin}&z_max=${zMax}` + (attributes ? `&attributes=${attributes.join(',')}` : '');
    const res = await fetch(`${BASE_URL}/query/mvt-prepare/${documentId}?${params}`, { method: 'POST' });
    return readJson(res, 'mvt-prepare');
}

// Feature IDs are the `pid` values (fid == pid in this dataset). The response is
// GeoJSON but may omit geometry (geometry: null) — callers fall back to
// client-side coordinates or to queryByGeometry.
export async function queryAttributesByIds(ids, attributes, documentId = DOCUMENT_ID) {
    const res = await fetch(`${BASE_URL}/query/attributes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, features: ids, attributes }),
    });
    return readJson(res, 'query/attributes');
}

export async function queryByGeometry(geometry, attributes, documentId = DOCUMENT_ID) {
    const res = await fetch(`${BASE_URL}/query/by-geometry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, geometry, attributes }),
    });
    return readJson(res, 'query/by-geometry');
}

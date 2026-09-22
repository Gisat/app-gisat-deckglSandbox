// Centralized basemap (background layer) URL helpers.
//
// Carto basemaps expect the API key as a `key` query parameter. The key is resolved at
// runtime from `window.CARTO_API_KEY` (injected via config.js / serve_web.py in
// deployments), falling back to the Vite env var `VITE_CARTO_API_KEY` for local dev.
// When the key is missing, tiles are still requested without authentication
// (rate-limited).
const CARTO_API_KEY =
    (typeof window !== 'undefined' && window.CARTO_API_KEY) ||
    import.meta.env.VITE_CARTO_API_KEY;

/**
 * Builds a Carto basemap XYZ tile URL with the optional API key appended.
 *
 * @param {string} [style] - Carto style name, e.g. 'light_all' or 'dark_all'.
 * @returns {string} XYZ tile URL template.
 */
export const getCartoBasemapUrl = (style = 'light_all') => {
    const key = CARTO_API_KEY ? `?key=${CARTO_API_KEY}` : '';
    return `https://a.basemaps.cartocdn.com/${style}/{z}/{x}/{y}.png${key}`;
};

export const cartoLightBasemapUrl = getCartoBasemapUrl('light_all');
export const cartoDarkBasemapUrl = getCartoBasemapUrl('dark_all');

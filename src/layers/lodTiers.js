/**
 * Shared LOD tier mapping for the Arrow LOD stream maps.
 *
 * The tile layer's sampling, the point size, and the arrow radius must all use
 * the same thresholds; this module is the single source of truth.
 */

/**
 * Maps a zoom level to the data tier rendered by `ArrowLODTileLayer`.
 *
 * @param {number} zoom - Current view zoom.
 * @returns {number} LOD tier: 0 = overview (5 %), 1 = mid (35 %), 2 = detail (100 %).
 */
export function getLodTier(zoom) {
    if (zoom >= 15) return 2;
    if (zoom >= 13) return 1;
    return 0;
}

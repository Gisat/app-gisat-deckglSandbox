/**
 * Poláky/Hradec v3 — one COG terrain sample per pylon.
 *
 * The rig has to be anchored on the *displayed* ground, and the only truthful
 * source for that is the terrain COG the map drapes. Sampling it once per tower
 * is enough: rings and vectors are rigid, so they need one elevation, not a
 * terrain-following surface (per-vertex terrain offsets bent the old ribbons and were
 * removed).
 *
 * Why this is not `_median` / `H_dem`: those InSAR heights live on a different
 * vertical datum. At the 18 towers the draped COG sits a smooth 43.9–46.1 m
 * below `_median`, so using it as an absolute z floats the rig ~45 m above the
 * steel.
 *
 * Reads the COG through `CogTiles` (the same reader the terrain layer uses) and
 * indexes the pixel the same way `CogTerrainKernel` does from a picked tile:
 * `raw[y * width + x]`. At zoom 15 the tile grid matches the COG's finest
 * overview (~4.8 m/px), which is why the sample equals a direct geotiff read.
 */

import { CogTiles } from '@gisatcz/deckgl-geolib';

/** Terrain COG; must stay the same source the map drapes. */
export const TERRAIN_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/EL-GRID_COGeoN.tif';

/** Sample zoom: the map's terrain maxZoom and the COG's finest overview. */
export const TERRAIN_SAMPLE_ZOOM = 15;
const TILE_SIZE = 256;

/** COG reader options matching the map's terrain layer (elevation, 1 channel). */
const COG_OPTIONS = {
  type: 'terrain',
  useSingleColor: true,
  color: [200, 200, 200, 255],
  disableLighting: true,
  noDataValue: 0,
  // Pixel reads never touch the terrain worker pool, so don't spawn one.
  disableWorkerPool: true,
};

/**
 * Web Mercator tile index and in-tile fraction for a lon/lat.
 *
 * @param {number} lon
 * @param {number} lat
 * @param {number} zoom
 * @returns {{ x: number, y: number, fx: number, fy: number }}
 */
function tileFraction(lon, lat, zoom) {
  const scale = 2 ** zoom;
  const xf = ((lon + 180) / 360) * scale;
  const rad = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { x, y, fx: xf - x, fy: yf - y };
}

/**
 * Samples the COG elevation at a single point.
 *
 * @param {CogTiles} cog Initialized reader.
 * @param {number} lon
 * @param {number} lat
 * @param {AbortSignal} [signal]
 * @returns {Promise<number|null>} Metres, or null when the pixel is nodata.
 */
async function sampleOne(cog, lon, lat, signal) {
  const { x, y, fx, fy } = tileFraction(lon, lat, TERRAIN_SAMPLE_ZOOM);
  const [buffer] = await cog.getTileFromImage(x, y, TERRAIN_SAMPLE_ZOOM, TILE_SIZE, signal);
  if (!buffer) return null;
  const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fx * TILE_SIZE)));
  const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fy * TILE_SIZE)));
  const value = Number(buffer[py * TILE_SIZE + px]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

/**
 * Samples terrain elevation for several points, sharing one COG reader (so
 * towers in the same tile reuse one fetch).
 *
 * @param {Array<{ key: string, lon: number, lat: number }>} points
 * @param {AbortSignal} [signal]
 * @param {string} [url]
 * @returns {Promise<Map<string, number|null>>} Key → metres above sea level.
 */
export async function sampleTerrainElevations(points, signal, url = TERRAIN_URL) {
  const out = new Map();
  if (!Array.isArray(points) || points.length === 0) return out;

  const cog = new CogTiles(COG_OPTIONS);
  await cog.initializeCog(url);

  for (const point of points) {
    if (signal?.aborted) break;
    const lon = Number(point?.lon);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      out.set(point.key, null);
      continue;
    }
    out.set(point.key, await sampleOne(cog, lon, lat, signal));
  }

  cog.clearTileResultCache();
  return out;
}

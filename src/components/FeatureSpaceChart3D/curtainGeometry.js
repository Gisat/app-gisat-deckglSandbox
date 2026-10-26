/**
 * Geometry for the map-side 3D "curtain": a vertical wall that rises from the
 * ground (`z = 0`) to each line-profile sample's active Z-attribute value, at
 * that sample's `lon/lat`. It is the geographic counterpart of the chart's
 * Lon/Lat profile view.
 *
 * Pure module (mirrors `profileGeometry.js`): imports only the attribute
 * registry, no React / three / deck.gl. The host map turns the returned
 * `quads`/`path`/`base`/`nodes` into `SolidPolygonLayer` / `PathLayer` /
 * `ScatterplotLayer` data.
 *
 * `samples` is the app-owned ordered line-profile list (see
 * `buildProfileSamples`). `lon`/`lat` are the sample's **perpendicular foot**
 * reflected onto the drawn line (not the point's own coordinates), so the
 * curtain hugs the selection.
 */

import { ATTRIBUTES } from './attributes';

/** On-map curtain height (metres) for attributes without a metric unit. */
export const CURTAIN_MAX_HEIGHT = 300;

/** @param {unknown} v */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Shared Z domain across several attribute keys, over the samples that sit on
 * the line. Used so multiple curtains (e.g. the trend windows or settlement steps) share one
 * height scale and stay comparable. Returns null when no finite value exists.
 *
 * @param {Array<Record<string, any>>} samples
 * @param {string[]} zKeys
 * @returns {[number, number]|null}
 */
export function curtainZDomain(samples, zKeys) {
  if (!Array.isArray(samples) || !Array.isArray(zKeys) || zKeys.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (!s || !isNum(s.lon) || !isNum(s.lat)) continue;
    for (const k of zKeys) {
      const v = s[k];
      if (isNum(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
  }
  return Number.isFinite(min) ? [min, max] : null;
}

/**
 * Build the render-ready curtain geometry.
 *
 * Z scaling: height attributes (`unit === 'm'`) use their literal value; every
 * other attribute is linearly normalised from its domain to
 * `[0, CURTAIN_MAX_HEIGHT]` (a degenerate domain collapses to the mid-height).
 * The domain defaults to the key's own sample `[min, max]`; pass `options.domain`
 * (from `curtainZDomain`) to share one scale across several curtains.
 *
 * @param {Array<{ id?: any, lon?: number, lat?: number, [key: string]: any }>} samples
 * @param {string|null|undefined} zKey
 * @param {{ domain?: [number, number] }} [options]
 * @returns {{
 *   quads: Array<{ polygon:number[][], value:number }>,
 *   path: number[][],
 *   base: number[][],
 *   nodes: Array<{ id:any, position:number[], value:number }>,
 * }}
 */
export function buildCurtainGeometry(samples, zKey, options = {}) {
  const empty = { quads: [], path: [], base: [], nodes: [] };
  if (!Array.isArray(samples) || !zKey || samples.length < 2) return empty;

  const rows = [];
  for (const s of samples) {
    if (!s) continue;
    if (!isNum(s.lon) || !isNum(s.lat) || !isNum(s[zKey])) continue;
    rows.push({ id: s.id, lon: s.lon, lat: s.lat, value: s[zKey] });
  }
  if (rows.length < 2) return empty;

  let min;
  let max;
  if (Array.isArray(options.domain) && options.domain.length === 2) {
    [min, max] = options.domain;
  } else {
    min = Infinity;
    max = -Infinity;
    for (const r of rows) {
      if (r.value < min) min = r.value;
      if (r.value > max) max = r.value;
    }
  }

  const literal = ATTRIBUTES[zKey]?.unit === 'm';
  const toZ = literal
    ? (v) => v
    : max === min
      ? () => CURTAIN_MAX_HEIGHT / 2
      : (v) => ((v - min) / (max - min)) * CURTAIN_MAX_HEIGHT;

  const nodes = rows.map((r) => ({
    id: r.id,
    position: [r.lon, r.lat, toZ(r.value)],
    value: r.value,
  }));

  const quads = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    quads.push({
      polygon: [
        [a.lon, a.lat, 0],
        [b.lon, b.lat, 0],
        [b.lon, b.lat, toZ(b.value)],
        [a.lon, a.lat, toZ(a.value)],
      ],
      value: (a.value + b.value) / 2,
    });
  }

  return {
    quads,
    path: nodes.map((n) => n.position),
    // Ground trace of the same line (z = 0), so the curtain reads as a wall
    // standing on the surface rather than a floating ribbon.
    base: nodes.map((n) => [n.position[0], n.position[1], 0]),
    nodes,
  };
}

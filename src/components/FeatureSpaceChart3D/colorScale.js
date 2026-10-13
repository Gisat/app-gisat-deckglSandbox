/**
 * Chroma-based colour scales for the 3D feature-space chart.
 *
 * The `vel_rel` channel reuses the exact scale used for the map markers so the
 * chart and map colours agree. Every other attribute uses a generic perceptually
 * spaced palette with an auto/fixed domain.
 *
 * Pure module (chroma-js only) so it can be lifted unchanged.
 */

import chroma from 'chroma-js';

/** Same stops/domain as SelectionDrawing3D's map colour scale. */
export const MAP_VELOCITY_COLORS = [[65, 182, 196], [254, 254, 191], [215, 25, 28]];
export const MAP_VELOCITY_DOMAIN = [-5, 5];

/** Viridis, for non-velocity attributes. */
const GENERIC_PALETTE = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

/** Per-point pixel-radius range for the size channel. */
export const SIZE_PIXEL_RANGE = [3, 14];

/**
 * Domain to map colour values over. `vel_rel` is pinned to the map's [-5, 5]
 * so colours stay comparable; other attributes auto-fit their data.
 *
 * @param {string} key
 * @param {Array<Record<string, number|null>>} points
 * @returns {[number, number]}
 */
export function getColorDomain(key, points) {
  if (key === 'vel_rel') return [...MAP_VELOCITY_DOMAIN];

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const v = p[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [0, 1];
  return [min, max];
}

/**
 * @param {string} key
 * @param {[number, number]} domain
 * @returns {import('chroma-js').Scale}
 */
export function buildColorScale(key, domain) {
  if (key === 'vel_rel') {
    // Exact match with the map scale (default rgb interpolation).
    return chroma.scale(MAP_VELOCITY_COLORS).domain(domain);
  }
  return chroma.scale(GENERIC_PALETTE).mode('lab').domain(domain);
}

/**
 * @param {import('chroma-js').Scale} scale
 * @param {number} value
 * @returns {[number, number, number, number]} rgba 0-255
 */
export function colorToRgba(scale, value) {
  const [r, g, b] = scale(value).rgb();
  return [r, g, b, 255];
}

/**
 * @param {import('chroma-js').Scale} scale
 * @param {number} value
 * @returns {string} hex
 */
export function colorToHex(scale, value) {
  return scale(value).hex();
}

/**
 * Build a Plotly-compatible colorscale by sampling the chroma scale.
 * Used for scatter3d, whose marker colors cannot be raw hex arrays.
 *
 * @param {import('chroma-js').Scale} scale
 * @param {[number, number]} domain
 * @param {number} [steps]
 * @returns {Array<[number, string]>}
 */
export function buildPlotlyColorscale(scale, domain, steps = 12) {
  const [min, max] = domain;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    out.push([t, scale(min + t * (max - min)).hex()]);
  }
  return out;
}

/**
 * Size channel domain. Coherence uses a fixed [0, 1]; other attributes fit data.
 *
 * @param {string} key
 * @param {Array<Record<string, number|null>>} points
 * @returns {[number, number]}
 */
export function getSizeDomain(key, points) {
  if (key === 'coh') return [0, 1];
  return getColorDomain(key, points);
}

/**
 * Map a value to a pixel radius within `range` over `domain`.
 *
 * @param {number} value
 * @param {[number, number]} domain
 * @param {[number, number]} range
 */
export function sizeForValue(value, domain, range) {
  const [lo, hi] = domain;
  const [rMin, rMax] = range;
  if (!Number.isFinite(value) || hi === lo) return (rMin + rMax) / 2;
  const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  return rMin + t * (rMax - rMin);
}

/**
 * GeoJSON feature -> normalized feature-space point.
 *
 * Pure module (no React / chart-library imports) so it can be lifted into
 * another repository unchanged.
 */

import { ATTRIBUTES } from './attributes';

/**
 * @typedef {Object} FeatureSpacePoint
 * @property {string} id            ID (fallback fid / feature.id)
 * @property {string|number|null} idOrig  fid
 * @property {[number, number]|null} coords  [lon, lat]
 * @property {number|null} VEL_REL
 * @property {number|null} VEL_LAST
 * @property {number|null} LT_365
 * @property {number|null} VEL_AVG
 * @property {number|null} VEL_SD
 * @property {number|null} SVEL_LAST
 * @property {number|null} LTS_365
 * @property {number|null} TD_90
 * @property {number|null} TD_180
 * @property {number|null} TD_365
 * @property {number|null} TD_730
 * @property {number|null} STD_90
 * @property {number|null} STD_180
 * @property {number|null} STD_365
 * @property {number|null} STD_730
 * @property {number|null} H
 * @property {number|null} H_SD
 * @property {number|null} H_REF
 * @property {number|null} COH
 * @property {number|null} COH_MOD
 * @property {number|null} INC_ANG
 * @property {number|null} az_ang
 * @property {number|null} REL_LEN
 * @property {number|null} ACCEL
 * @property {number|null} SEASONAL
 * @property {number|null} VACC
 */

/** @param {unknown} v */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Numeric attribute keys carried on every normalized point (excludes lon/lat). */
const NUMERIC_KEYS = Object.keys(ATTRIBUTES).filter((key) => !ATTRIBUTES[key].coordinate);

/**
 * Transform a single GeoJSON feature into a normalized point.
 * @param {any} feature
 * @returns {FeatureSpacePoint}
 */
export function transformFeature(feature) {
  const p = (feature && feature.properties) || {};
  const coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
    ? feature.geometry.coordinates
    : null;

  /** @type {Record<string, number|null>} */
  const values = {};
  for (const key of NUMERIC_KEYS) values[key] = toNumber(p[key]);

  const id = p.ID ?? p.fid ?? (feature && feature.id) ?? null;

  return {
    id: id == null ? null : String(id),
    idOrig: p.fid ?? null,
    coords,
    ...values,
  };
}

/**
 * @param {FeatureSpacePoint} point
 * @param {string[]} activeFields attribute keys that must be finite
 */
function isComplete(point, activeFields) {
  for (const key of activeFields) {
    const v = point[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

/**
 * Transform a GeoJSON FeatureCollection (or plain feature array) into points,
 * dropping any point whose value is null/undefined for an active field.
 *
 * @param {any} featureCollection
 * @param {string[]} [activeFields] attribute keys; only these gate skipping
 * @returns {{ points: FeatureSpacePoint[], skipped: number, total: number }}
 */
export function transformPoints(featureCollection, activeFields = []) {
  const features = Array.isArray(featureCollection)
    ? featureCollection
    : (featureCollection && featureCollection.features) || [];

  const points = [];
  let skipped = 0;

  for (const feature of features) {
    const point = transformFeature(feature);
    if (activeFields.length > 0 && !isComplete(point, activeFields)) {
      skipped += 1;
      continue;
    }
    points.push(point);
  }

  return { points, skipped, total: features.length };
}

/** Unique list of attribute keys referenced by an axis bundle. */
export function activeFieldsFor(axes) {
  return [...new Set([axes.x, axes.y, axes.z, axes.color, axes.size])];
}

/**
 * Per-axis min/max over the point set, keyed by the chart axis slot x/y/z.
 * Degenerate axes are widened so normalisation never divides by zero.
 *
 * @param {Array<Record<string, number|null>>} points
 * @param {import('./attributes').PresetAxes} axes
 * @returns {Record<'x'|'y'|'z', { key: string, min: number, max: number }>}
 */
export function computeAxisDomains(points, axes) {
  /** @type {any} */
  const domains = {};
  for (const slot of ['x', 'y', 'z']) {
    const key = axes[slot];
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      const v = p[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    } else if (min === max) {
      const pad = Math.abs(min) || 1;
      min -= pad * 0.5;
      max += pad * 0.5;
    }
    domains[slot] = { key, min, max };
  }
  return domains;
}

/**
 * Project a point into a centred cube [-scale, scale]^3, one axis per slot.
 * Returns [x, y, z] in chart-attribute order (x, y, z).
 *
 * @param {Record<string, number|null>} point
 * @param {import('./attributes').PresetAxes} axes
 * @param {ReturnType<typeof computeAxisDomains>} domains
 * @param {number} [scale]
 * @returns {[number, number, number]}
 */
export function projectToCube(point, axes, domains, scale = 1) {
  const out = [0, 0, 0];
  ['x', 'y', 'z'].forEach((slot, i) => {
    const { key, min, max } = domains[slot];
    const v = point[key];
    const t = max === min ? 0.5 : ((v ?? min) - min) / (max - min);
    out[i] = (Math.max(0, Math.min(1, t)) - 0.5) * 2 * scale;
  });
  return out;
}

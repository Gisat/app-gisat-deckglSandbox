/**
 * GeoJSON feature -> normalized feature-space point.
 *
 * Pure module (no React / chart-library imports) so it can be lifted into
 * another repository unchanged.
 */

import { ATTRIBUTES } from './attributes';

/**
 * @typedef {Object} FeatureSpacePoint
 * @property {string} id            id_global (fallback id_orig / feature.id)
 * @property {string|number|null} idOrig
 * @property {[number, number]|null} coords  [lon, lat]
 * @property {number|null} vel_rel
 * @property {number|null} vel_last
 * @property {number|null} coh
 * @property {number|null} inc_ang
 * @property {number|null} az_ang
 * @property {number|null} h
 * @property {number|null} h_dtm
 * @property {number|null} rel_len
 * @property {number} h_struct       derived as (h ?? 0) - (h_dtm ?? 0)
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

/** Numeric attribute keys carried on every normalized point. */
const NUMERIC_KEYS = Object.keys(ATTRIBUTES).filter((k) => k !== 'h_struct');

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

  // Plan-locked derivation. h_struct stays defined even when one side is null.
  values.h_struct = (values.h ?? 0) - (values.h_dtm ?? 0);

  const id = p.id_global ?? p.id_orig ?? (feature && feature.id) ?? null;

  return {
    id: id == null ? null : String(id),
    idOrig: p.id_orig ?? null,
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

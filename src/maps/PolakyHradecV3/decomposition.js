/**
 * Poláky/Hradec v3 — per-band ΔU/ΔE least squares from three LOS tracks.
 *
 * Pure module: no React, no deck.gl, no three.
 *
 * ## Geometry and sign convention
 *
 * The repo's arrow convention (`src/layers/velocity/velocitySymbols.ts`) fixes
 * the toward-sensor bearings: `FIXED_HEADING_TOWARD_DESC = 100` for the
 * descending track and `FIXED_HEADING_TOWARD_ASC = 260` for both ascending ones.
 * Positive `VEL_*` is motion **toward** the sensor, so subsidence is negative.
 * `TRACK_TOWARD_DEG` reuses those same headings, so the least-squares row and
 * the ring shift follow one source of truth.
 *
 * LOS displacement for a motion vector is the dot product with the unit vector
 * pointing from the ground toward the sensor:
 *
 *     d_los = ΔE · sinθ · sinφ + ΔN · sinθ · cosφ + ΔU · cosθ
 *
 * where θ is the incidence angle and φ the toward-sensor azimuth, clockwise
 * from north.
 *
 * **North is dropped** (assumed 0): three tracks cannot separate three
 * unknowns, and the residual reported with every solution is what that
 * assumption costs. Treat ΔE/ΔU as horizontal-east and vertical, not as a full
 * 3D motion vector.
 *
 * The row for `[ΔE, ΔU]` is therefore `[sinθ · sinφ, cosθ]`.
 */

import {
  TRACK_TOWARD_DEG,
  LOW_CONFIDENCE_SCATTERERS,
  LOW_CONFIDENCE_RESIDUAL_MM,
  LOW_CONFIDENCE_CONDITION,
  MIN_SCATTERERS_PER_BAND,
} from './tracks';

/** Fixed solver order, so reports and debug output are stable. */
export const SOLVER_TRACK_IDS = ['95D', '44A', '146A'];

/** Track id → `solveBand` argument name. */
export const SOLVER_ARG_BY_TRACK = { '95D': 'd95', '44A': 'd44', '146A': 'd146' };

/**
 * Toward-sensor azimuth (degrees clockwise from north) for a track.
 *
 * @param {string} trackId
 * @returns {number}
 */
export function towardDeg(trackId) {
  const toward = TRACK_TOWARD_DEG[trackId];
  if (!Number.isFinite(toward)) return NaN;
  return (((toward % 360) + 360) % 360);
}

/**
 * One least-squares row for `[ΔE, ΔU]`.
 *
 * @param {number} incidenceDeg Incidence angle from nadir (degrees).
 * @param {number} towardAzimuthDeg Toward-sensor azimuth (degrees from north).
 * @returns {[number, number]}
 */
export function losRow(incidenceDeg, towardAzimuthDeg) {
  const theta = (incidenceDeg * Math.PI) / 180;
  const phi = (towardAzimuthDeg * Math.PI) / 180;
  return [Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
}

/** Inverse of a symmetric 2×2 [[a, b], [b, c]]; null when singular. */
function invert2(a, b, c) {
  const det = a * c - b * b;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [[c / det, -b / det], [-b / det, a / det]];
}

/**
 * Condition estimate of the 2×2 normal matrix: square root of the eigenvalue
 * ratio, i.e. the condition number of the 3×2 system it came from.
 */
function normalMatrixCondition(a, b, c) {
  const mean = (a + c) / 2;
  const spread = Math.sqrt(((a - c) / 2) ** 2 + b ** 2);
  const max = mean + spread;
  const min = mean - spread;
  if (!Number.isFinite(max) || !Number.isFinite(min) || min <= 1e-12) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.sqrt(max / min);
}

/**
 * Weighted least squares for one band.
 *
 * Each usable track contributes one row. Weights are the band's scatterer
 * counts, so a band supported by 20 points moves the solution more than one
 * supported by four. The condition number is computed from weights normalised
 * to mean 1, so it reports the geometry rather than the weight magnitudes.
 *
 * A track is unusable when its smoothed band median is missing, its incidence
 * angle is missing, or the band has fewer than `MIN_SCATTERERS_PER_BAND`
 * scatterers in it.
 *
 * @param {{
 *   d95?: number|null, d44?: number|null, d146?: number|null,
 *   inc?: Record<string, number|null>, weights?: Record<string, number|null>,
 * }} input
 * @returns {{
 *   ok: boolean, dE: number|null, dU: number|null, residualMm: number|null,
 *   condition: number, lowConfidence: boolean, used: string[],
 *   skipped: string[], matrix: number[][], targets: number[],
 * }}
 */
export function solveBand({ d95 = null, d44 = null, d146 = null, inc = {}, weights = {} } = {}) {
  const values = { d95, d44, d146 };
  const rows = [];
  const used = [];
  const skipped = [];

  for (const trackId of SOLVER_TRACK_IDS) {
    const value = values[SOLVER_ARG_BY_TRACK[trackId]];
    const count = Number(weights?.[trackId] ?? 0);
    const rawIncidence = inc?.[trackId];
    const incidence = rawIncidence == null || rawIncidence === ''
      ? NaN
      : Number(rawIncidence);
    if (!Number.isFinite(value)) {
      skipped.push(trackId);
      continue;
    }
    if (!Number.isFinite(incidence)) {
      skipped.push(trackId);
      continue;
    }
    if (!Number.isFinite(count) || count < MIN_SCATTERERS_PER_BAND) {
      skipped.push(trackId);
      continue;
    }
    rows.push({ trackId, value, count, row: losRow(incidence, towardDeg(trackId)) });
    used.push(trackId);
  }

  const base = {
    ok: false,
    dE: null,
    dU: null,
    residualMm: null,
    condition: Number.POSITIVE_INFINITY,
    lowConfidence: true,
    used,
    skipped,
    matrix: rows.map(r => r.row),
    targets: rows.map(r => r.value),
  };
  // Two unknowns need at least two independent rows.
  if (rows.length < 2) return base;

  const meanWeight = rows.reduce((sum, r) => sum + r.count, 0) / rows.length;
  let a = 0;
  let b = 0;
  let c = 0;
  let r0 = 0;
  let r1 = 0;
  for (const { row, value, count } of rows) {
    const w = meanWeight > 0 ? count / meanWeight : 1;
    a += w * row[0] * row[0];
    b += w * row[0] * row[1];
    c += w * row[1] * row[1];
    r0 += w * row[0] * value;
    r1 += w * row[1] * value;
  }

  const condition = normalMatrixCondition(a, b, c);
  const inverse = invert2(a, b, c);
  if (!inverse) return { ...base, condition };

  const dE = inverse[0][0] * r0 + inverse[0][1] * r1;
  const dU = inverse[1][0] * r0 + inverse[1][1] * r1;

  let sumSquares = 0;
  for (const { row, value } of rows) {
    const predicted = row[0] * dE + row[1] * dU;
    sumSquares += (predicted - value) ** 2;
  }
  const residualMm = Math.sqrt(sumSquares / rows.length);

  const lowConfidence =
    residualMm > LOW_CONFIDENCE_RESIDUAL_MM ||
    rows.length < SOLVER_TRACK_IDS.length ||
    rows.some(r => r.count < LOW_CONFIDENCE_SCATTERERS) ||
    condition > LOW_CONFIDENCE_CONDITION;

  return {
    ok: true,
    dE,
    dU,
    residualMm,
    condition,
    lowConfidence,
    used,
    skipped,
    matrix: rows.map(r => r.row),
    targets: rows.map(r => r.value),
  };
}

/**
 * Cardinal label for a horizontal east component.
 *
 * @param {number|null} dE
 * @returns {string}
 */
export function eastLabel(dE) {
  if (!Number.isFinite(dE) || Math.abs(dE) < 0.05) return '–';
  return dE > 0 ? 'E' : 'W';
}

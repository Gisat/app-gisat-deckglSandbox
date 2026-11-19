/**
 * Poláky/Hradec v3 — pure time-series and ring-stack geometry.
 *
 * Pure module (same convention as `FeatureSpaceChart3D/curtainGeometry.js`):
 * no React, no deck.gl, no three. The map host turns the returned circles into
 * `PathLayer` data.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **Every window is expressed in days.** Acquisitions are irregular (6–24 d),
 *    so a sample-count window would be a different time span on each track.
 * 2. **Smoothing happens on each track's own dates, interpolation afterwards.**
 *    Interpolating first and smoothing on the union grid would weight densely
 *    sampled periods more than sparse ones.
 * 3. **No carry-forward.** A window averages only the samples that fall inside
 *    it; an empty window yields null instead of the last known value (carrying
 *    the last value forward biases the mean and flattens real steps).
 */

import { towardDeg } from './decomposition';
import {
  BAND_LABELS,
  METRES_PER_DEG_LAT,
  RING_ALPHA_RAW,
  RING_ALPHA_SMOOTHED,
  RING_RADIUS_M,
  RING_RAW_COUNT,
  RING_SEGMENTS,
  RING_SMOOTHED_COUNT,
  SECTION_Z_FRACTIONS,
  metresPerDegLon,
  viridisColor,
} from './tracks';

const DAY_MS = 86400000;

/**
 * Parses a `d_YYYYMMDD` property key into UTC epoch milliseconds.
 *
 * @param {string} key
 * @returns {number} Epoch ms, or NaN when the key is not a timeline key.
 */
export function epochKeyToMs(key) {
  if (typeof key !== 'string' || !key.startsWith('d_')) return NaN;
  const raw = key.slice(2);
  if (raw.length !== 8) return NaN;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return NaN;
  return Date.UTC(year, month - 1, day);
}

/**
 * Every `d_*` sample of one feature as sorted parallel arrays.
 *
 * Cached per feature object: the same scatterers are read again on every window
 * or scale change, and re-parsing ~450 keys each time is the only expensive
 * part of the pipeline.
 *
 * @param {any} feature
 * @returns {{ dates: number[], values: number[] }}
 */
export function featureSeries(feature) {
  const cached = seriesCache.get(feature);
  if (cached) return cached;

  const dates = [];
  const values = [];
  for (const [key, raw] of Object.entries(feature?.properties ?? {})) {
    if (!key.startsWith('d_')) continue;
    const ms = epochKeyToMs(key);
    if (!Number.isFinite(ms)) continue;
    const value = raw == null || raw === '' ? NaN : Number(raw);
    dates.push(ms);
    values.push(Number.isFinite(value) ? value : NaN);
  }

  const order = dates.map((_, i) => i).sort((a, b) => dates[a] - dates[b]);
  const sortedDates = order.map(i => dates[i]);
  const sortedValues = order.map(i => values[i]);
  const result = { dates: sortedDates, values: sortedValues };
  seriesCache.set(feature, result);
  return result;
}

/** @type {WeakMap<object, { dates: number[], values: number[] }>} */
const seriesCache = new WeakMap();

/**
 * Sorted, de-duplicated date lists for all three tracks plus their union.
 *
 * The union is the ring time axis: one vertex per acquisition of any track, so
 * each curve shows the dates its own track actually observed and nothing is
 * decimated away.
 *
 * @param {Record<string, Array<any>>} featuresByTrack
 * @returns {{ grid: number[], byTrack: Record<string, number[]> }}
 */
export function unionGrid(featuresByTrack = {}) {
  const byTrack = {};
  const all = new Set();
  for (const [trackId, features] of Object.entries(featuresByTrack)) {
    const dates = new Set();
    for (const feature of features ?? []) {
      for (const key of Object.keys(feature?.properties ?? {})) {
        if (!key.startsWith('d_')) continue;
        const ms = epochKeyToMs(key);
        if (Number.isFinite(ms)) dates.add(ms);
      }
    }
    const sorted = [...dates].sort((a, b) => a - b);
    byTrack[trackId] = sorted;
    for (const ms of sorted) all.add(ms);
  }
  return { grid: [...all].sort((a, b) => a - b), byTrack };
}

/** First index with `dates[i] >= value`. */
function lowerBound(dates, value) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with `dates[i] > value`. */
function upperBound(dates, value) {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Centred rolling mean over real dates.
 *
 * Prefix sums plus parallel sample counts give O(n log n) on sorted dates; each
 * window averages only finite samples that actually fall inside it.
 *
 * @param {number[]} values Samples aligned with `dates`; non-finite = missing.
 * @param {number[]} dates Sorted epoch ms, same length as `values`.
 * @param {number} windowDays Full window width in days.
 * @returns {Array<number|null>} Smoothed value per input sample.
 */
export function smoothSeries(values, dates, windowDays) {
  const n = Math.min(values?.length ?? 0, dates?.length ?? 0);
  if (n === 0) return [];

  const half = (Math.max(1, windowDays) * DAY_MS) / 2;
  const sum = new Float64Array(n + 1);
  const count = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const value = values[i];
    const present = Number.isFinite(value);
    sum[i + 1] = sum[i] + (present ? value : 0);
    count[i + 1] = count[i] + (present ? 1 : 0);
  }

  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const centre = dates[i];
    const from = lowerBound(dates, centre - half);
    const to = upperBound(dates, centre + half);
    const samples = count[to] - count[from];
    out[i] = samples > 0 ? (sum[to] - sum[from]) / samples : null;
  }
  return out;
}

/**
 * Linear interpolation of a series at one instant, no extrapolation.
 *
 * A target outside the series range — or bracketed by a null sample — yields
 * null. Never carries the nearest value outward.
 *
 * @param {number} targetMs
 * @param {number[]} dates Sorted epoch ms.
 * @param {Array<number|null>} values
 * @returns {number|null}
 */
export function interpolateAt(targetMs, dates, values) {
  const n = Math.min(dates?.length ?? 0, values?.length ?? 0);
  if (n === 0) return null;
  if (targetMs < dates[0] || targetMs > dates[n - 1]) return null;

  const i = upperBound(dates, targetMs) - 1;
  if (dates[i] === targetMs) {
    const value = values[i];
    return Number.isFinite(value) ? value : null;
  }
  const j = i + 1;
  if (j >= n) return null;
  const a = values[i];
  const b = values[j];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const span = dates[j] - dates[i];
  if (span <= 0) return a;
  const t = (targetMs - dates[i]) / span;
  return a + (b - a) * t;
}

/**
 * Interpolates a whole series onto a target grid.
 *
 * @param {number[]} targets Sorted epoch ms.
 * @param {number[]} dates Sorted epoch ms of the source series.
 * @param {Array<number|null>} values
 * @returns {Array<number|null>} One value per target.
 */
export function interpolateSeries(targets, dates, values) {
  const out = new Array(targets.length);
  for (let i = 0; i < targets.length; i++) {
    out[i] = interpolateAt(targets[i], dates, values);
  }
  return out;
}

/** Median of the finite entries; null when there are none. */
export function median(values) {
  const finite = [];
  for (const value of values ?? []) {
    if (Number.isFinite(value)) finite.push(value);
  }
  if (finite.length === 0) return null;
  finite.sort((a, b) => a - b);
  const mid = finite.length >> 1;
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

/**
 * Smoothed band median on the union grid: smooth every scatterer on its own
 * dates, interpolate the *smoothed* series onto `grid`, then take the pointwise
 * median across the band.
 *
 * @param {Array<any>} scatterers Features assigned to one band of one track.
 * @param {number} windowDays
 * @param {number[]} grid Union date grid.
 * @returns {Array<number|null>} One value per grid epoch.
 */
export function bandMedianSeries(scatterers, windowDays, grid) {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const columns = [];
  for (const feature of scatterers ?? []) {
    const { dates, values } = featureSeries(feature);
    if (dates.length === 0) continue;
    const smoothed = smoothSeries(values, dates, windowDays);
    columns.push(interpolateSeries(grid, dates, smoothed));
  }
  if (columns.length === 0) return grid.map(() => null);

  const out = new Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    let acc = null;
    for (const column of columns) {
      const value = column[i];
      if (!Number.isFinite(value)) continue;
      if (acc === null) acc = [];
      acc.push(value);
    }
    out[i] = acc === null ? null : median(acc);
  }
  return out;
}

/**
 * Band median at a single instant (no union grid needed).
 *
 * Same pipeline as `bandMedianSeries`, evaluated only at `epochMs`; used for the
 * per-band decomposition of every pylon, where only one number is needed.
 *
 * @param {Array<any>} scatterers
 * @param {number} epochMs
 * @param {number} windowDays
 * @returns {number|null}
 */
export function bandMedianAt(scatterers, epochMs, windowDays) {
  const samples = [];
  for (const feature of scatterers ?? []) {
    const { dates, values } = featureSeries(feature);
    if (dates.length === 0) continue;
    const smoothed = smoothSeries(values, dates, windowDays);
    const value = interpolateAt(epochMs, dates, smoothed);
    if (Number.isFinite(value)) samples.push(value);
  }
  return median(samples);
}

/**
 * Resamples a smoothed series onto `count` uniform steps in *time*.
 *
 * The ring maps time linearly to angle around the tower, so a uniform time grid
 * is also a uniform angular grid. This runs after smoothing (never before) so the
 * resampling cannot shift the window weights, and it keeps the drawn curve
 * smooth: ~1300 union epochs would otherwise become sub-pixel segments.
 *
 * @param {Array<number|null>} series Values on `grid`.
 * @param {number[]} grid Sorted epoch ms.
 * @param {number} count Target vertex count.
 * @returns {{ series: Array<number|null>, grid: number[] }}
 */
export function resampleSeries(series, grid, count) {
  const n = Math.min(series?.length ?? 0, grid?.length ?? 0);
  if (n < 2 || !(count >= 2)) return { series: [], grid: [] };

  const dates = grid.slice(0, n);
  const values = series.slice(0, n);
  const first = dates[0];
  const last = dates[n - 1];
  const outSeries = new Array(count);
  const outGrid = new Array(count);
  for (let i = 0; i < count; i++) {
    const ms = Math.round(first + ((last - first) * i) / (count - 1));
    outGrid[i] = ms;
    outSeries[i] = interpolateAt(ms, dates, values);
  }
  return { series: outSeries, grid: outGrid };
}

/**
 * The scatterer whose smoothed value at `epochMs` is the median of the band.
 *
 * Used by the ring click to open a concrete 2D timeline without inventing an
 * "average point" the dataset does not contain.
 *
 * @param {Array<any>} scatterers
 * @param {number} epochMs
 * @param {number} windowDays
 * @returns {any|null}
 */
export function medianScatterer(scatterers, epochMs, windowDays) {
  const candidates = [];
  for (const feature of scatterers ?? []) {
    const { dates, values } = featureSeries(feature);
    if (dates.length === 0) continue;
    const smoothed = smoothSeries(values, dates, windowDays);
    const value = interpolateAt(epochMs, dates, smoothed);
    if (Number.isFinite(value)) candidates.push({ feature, value });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.value - b.value);
  return candidates[candidates.length >> 1].feature;
}

/**
 * Human label for a band index.
 *
 * @param {number} bandIndex
 * @returns {string}
 */
export function bandLabel(bandIndex) {
  return BAND_LABELS[bandIndex] ?? `band ${bandIndex}`;
}


/**
 * Pointwise median of the **raw** acquisition values on the union grid.
 *
 * Same reduction as `bandMedianSeries`, but it skips `smoothSeries` so the
 * per-acquisition centres are preserved. Raw mode exists to show where the
 * measurements actually are, not a 90-day average of them.
 *
 * @param {Array<any>} scatterers
 * @param {number[]} grid Union date grid.
 * @returns {Array<number|null>} One value per grid epoch.
 */
export function rawBandMedianSeries(scatterers, grid) {
  if (!Array.isArray(grid) || grid.length === 0) return [];
  const columns = [];
  for (const feature of scatterers ?? []) {
    const { dates, values } = featureSeries(feature);
    if (dates.length === 0) continue;
    columns.push(interpolateSeries(grid, dates, values));
  }
  if (columns.length === 0) return grid.map(() => null);

  const out = new Array(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const samples = [];
    for (const column of columns) {
      const value = column[i];
      if (Number.isFinite(value)) samples.push(value);
    }
    out[i] = samples.length === 0 ? null : median(samples);
  }
  return out;
}

/**
 * Closed horizontal circle of `RING_RADIUS_M` around a centre, in `[lon, lat, z]`.
 */
function ringPath(center, mPerDegLon, z, radiusM = RING_RADIUS_M, segments = RING_SEGMENTS) {
  const path = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    path.push([
      center.lon + (Math.sin(angle) * radiusM) / mPerDegLon,
      center.lat + (Math.cos(angle) * radiusM) / METRES_PER_DEG_LAT,
      z,
    ]);
  }
  return path;
}

/**
 * Separated 3-section ring stack for one tower and one track.
 *
 * Three vertical slots, each bracketed by a white 0 mm reference ring at its
 * floor (2014) and ceiling (2026). Inside a slot, one bold horizontal ring per
 * timestep: height encodes time, centre shift encodes LOS displacement along the
 * track's toward-sensor bearing, colour is Viridis over the same time axis. The
 * ring radius is constant, so a shift of +8 mm at ×1 moves the whole circle 8 m
 * — no radius change, no vertical exaggeration of the values themselves.
 *
 * @param {{
 *   pylon: any, activeTrackId: string, grid: number[],
 *   rawMode?: boolean, windowDays?: number, scaleMPerMm?: number,
 * }} options
 * @returns {{
 *   stacks: Array<{
 *     path: number[][], color: number[], bandIndex: number, trackId: string,
 *     dateMs: number, valueMm: number, pylonId: any, pylonKey: string, count: number,
 *   }>,
 *   references: Array<{ path: number[][], bandIndex: number, kind: 'floor'|'ceiling' }>,
 * }}
 */
export function buildSectionRingStacks({
  pylon,
  activeTrackId,
  grid,
  rawMode = false,
  windowDays = 90,
  scaleMPerMm = 1,
}) {
  const empty = { stacks: [], references: [] };
  if (!pylon || !Array.isArray(grid) || grid.length < 2) return empty;

  const base = pylon.terrainElevation;
  if (!Number.isFinite(base) || !Number.isFinite(pylon.height)) return empty;

  const mPerDegLon = metresPerDegLon(pylon.lat);
  const towardRad = (towardDeg(activeTrackId) * Math.PI) / 180;
  const count = rawMode ? RING_RAW_COUNT : RING_SMOOTHED_COUNT;
  const alpha = rawMode ? RING_ALPHA_RAW : RING_ALPHA_SMOOTHED;

  const stacks = [];
  const references = [];

  for (let bandIndex = 0; bandIndex < SECTION_Z_FRACTIONS.length; bandIndex++) {
    const [startFraction, endFraction] = SECTION_Z_FRACTIONS[bandIndex];
    const zStart = base + startFraction * pylon.height;
    const zEnd = base + endFraction * pylon.height;

    // 0 mm references: the floor is 2014, the ceiling is 2026.
    references.push({ path: ringPath(pylon, mPerDegLon, zStart), bandIndex, kind: 'floor' });
    references.push({ path: ringPath(pylon, mPerDegLon, zEnd), bandIndex, kind: 'ceiling' });

    const scatterers = pylon.bands?.[activeTrackId]?.[bandIndex] ?? [];
    if (scatterers.length === 0) continue;

    const dense = rawMode
      ? rawBandMedianSeries(scatterers, grid)
      : bandMedianSeries(scatterers, windowDays, grid);
    const display = resampleSeries(dense, grid, count);
    if (display.series.length < 2) continue;

    for (let i = 0; i < display.series.length; i++) {
      const value = display.series[i];
      if (!Number.isFinite(value)) continue;

      const u = i / (display.series.length - 1);
      const z = zStart + u * (zEnd - zStart);
      const shiftM = value * scaleMPerMm;
      const center = {
        lon: pylon.lon + (shiftM * Math.sin(towardRad)) / mPerDegLon,
        lat: pylon.lat + (shiftM * Math.cos(towardRad)) / METRES_PER_DEG_LAT,
      };

      stacks.push({
        path: ringPath(center, mPerDegLon, z),
        color: [...viridisColor(u), alpha],
        bandIndex,
        trackId: activeTrackId,
        dateMs: display.grid[i],
        valueMm: value,
        pylonId: pylon.id,
        pylonKey: pylon.key,
        count: scatterers.length,
      });
    }
  }

  return { stacks, references };
}

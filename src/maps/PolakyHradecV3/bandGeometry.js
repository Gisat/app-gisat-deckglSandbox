/**
 * Poláky/Hradec v3 — pure time-series and fin geometry.
 *
 * Pure module (same convention as `FeatureSpaceChart3D/curtainGeometry.js`):
 * no React, no deck.gl, no three. The map host turns `quads` / `curve` /
 * `baseline` into `SolidPolygonLayer` / `PathLayer` data.
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

import {
  BAND_LABELS,
  FIN_INNER_M,
  FIN_LENGTH_M,
  DEFAULT_SCALE_M_PER_MM,
  METRES_PER_DEG_LAT,
  metresPerDegLon,
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
 * The union is the fin time axis: one vertex per acquisition of any track, so
 * each ribbon shows the dates its own track actually observed and nothing is
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
 * The scatterer whose smoothed value at `epochMs` is the median of the band.
 *
 * Used by the fin click to open a concrete 2D timeline without inventing an
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
 * Fin wall geometry for one ribbon (one track × one band).
 *
 * Time runs outward from the tower: vertex 0 sits `innerM` from the tower on the
 * requested side, the last vertex `innerM + lengthM` away. Z is
 * `base + bandZ + value × scale` in metres *above the terrain under each
 * vertex* — the map adds the COG height through the terrain extension, exactly
 * as it does for the tower meshes and the point symbols. `base` is an extra lift
 * and stays 0 on this map: the InSAR `_median` / `H_dem` datum is ~45 m above
 * the draped COG surface, so it must not be used as an absolute elevation here.
 *
 * Metre offsets are converted with *both* degrees factors, so east/west and
 * north/south distances stay true at this latitude.
 *
 * Each quad is the area between the 0 mm baseline and the smoothed value, i.e. a
 * vertical, planar wall — planar by construction, so it stays planar when the
 * camera tilts.
 *
 * @param {{
 *   series: Array<number|null>, grid: number[], side: 'east'|'west',
 *   laneOffsetM?: number, bandZ: number, bandIndex?: number, trackId?: string,
 *   lengthM?: number, innerM?: number, scaleMPerMm?: number,
 *   pylon: { lon: number, lat: number }, base?: number,
 * }} options `base` is an extra lift above the terrain frame and defaults to 0.
 * @returns {{
 *   quads: Array<{ polygon:number[][], value:number, dateMs:number, index:number }>,
 *   curve: number[][][], baseline: number[][][],
 * }}
 */
export function buildFinGeometry({
  series,
  grid,
  side,
  laneOffsetM = 0,
  bandZ,
  bandIndex = 0,
  trackId = '',
  lengthM = FIN_LENGTH_M,
  innerM = FIN_INNER_M,
  scaleMPerMm = DEFAULT_SCALE_M_PER_MM,
  pylon,
  base = 0,
}) {
  const empty = { quads: [], curve: [], baseline: [] };
  if (!Array.isArray(grid) || grid.length < 2 || !Array.isArray(series)) return empty;
  if (!pylon || !Number.isFinite(pylon.lon) || !Number.isFinite(pylon.lat)) return empty;

  const direction = side === 'west' ? -1 : 1;
  const mPerDegLon = metresPerDegLon(pylon.lat);
  const lat = pylon.lat + laneOffsetM / METRES_PER_DEG_LAT;
  const zBase = base + bandZ;
  const count = Math.min(grid.length, series.length);
  if (count < 2) return empty;

  // One vertex per grid epoch; x grows outward with time.
  const vertices = [];
  for (let i = 0; i < count; i++) {
    const value = series[i];
    const t = count === 1 ? 0 : i / (count - 1);
    const offsetM = innerM + t * lengthM;
    const lon = pylon.lon + (direction * offsetM) / mPerDegLon;
    const z = zBase + (Number.isFinite(value) ? value * scaleMPerMm : 0);
    vertices.push({ lon, lat, z, value, dateMs: grid[i] });
  }

  const quads = [];
  const curve = [];
  const baseline = [];
  let run = null;
  let baseRun = null;

  for (let i = 0; i < vertices.length; i++) {
    const v = vertices[i];
    const present = Number.isFinite(v.value);
    if (present) {
      if (!run) {
        run = [];
        baseRun = [];
        curve.push(run);
        baseline.push(baseRun);
      }
      run.push([v.lon, v.lat, v.z]);
      baseRun.push([v.lon, v.lat, zBase]);
    } else {
      run = null;
      baseRun = null;
    }
  }

  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) continue;
    quads.push({
      polygon: [
        [a.lon, a.lat, zBase],
        [b.lon, b.lat, zBase],
        [b.lon, b.lat, b.z],
        [a.lon, a.lat, a.z],
      ],
      value: (a.value + b.value) / 2,
      dateMs: a.dateMs,
      index: i,
      bandIndex,
      trackId,
    });
  }

  return { quads, curve, baseline };
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

/**
 * Poláky/Hradec v3 — pure time-series and halo-ring geometry.
 *
 * Pure module (same convention as `FeatureSpaceChart3D/curtainGeometry.js`):
 * no React, no deck.gl, no three. The map host turns the returned polygons and
 * paths into `SolidPolygonLayer` / `PathLayer` / `ScatterplotLayer` data.
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
  HALO_ARC_DEG,
  HALO_EAST_START_DEG,
  HALO_INNER_RADIUS_M,
  HALO_OUTER_RADIUS_M,
  HALO_RADIAL_SCALE_M_PER_MM,
  HALO_SEGMENTS,
  HALO_WEST_START_DEG,
  HALO_ZERO_RADIUS_M,
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
 * Euler orientation for the arrow-head cone in deck.gl's `[pitch, yaw, roll]`
 * convention, pointing the cone's local +Z along `(eastM, 0, upM)`.
 *
 * Derivation, from `@deck.gl/mesh-layers/dist/utils/matrix.js`
 * (`calculateTransformMatrix`, roll = 0): the local +Z axis maps to
 *
 *     col2 = (cos yaw · sin pitch,  sin yaw · sin pitch,  cos pitch)
 *
 * in world metres (x east, y north, z up). So yaw stays 0/180 (east/west) and
 * pitch = atan2(|east|, up) gives the elevation angle. Adding ±90° to yaw would
 * rotate the axis into ±Y, i.e. make the heads point north/south — see
 * `coneAxis`, which recomputes col2 so the debug block can assert the match.
 *
 * @param {number} eastM East component, metres.
 * @param {number} upM Vertical component, metres.
 * @returns {[number, number, number]}
 */
export function coneOrientation(eastM, upM) {
  if (!Number.isFinite(eastM) || !Number.isFinite(upM)) return [0, 0, 0];
  if (eastM === 0 && upM === 0) return [0, 0, 0];
  return [
    (Math.atan2(Math.abs(eastM), upM) * 180) / Math.PI,
    eastM < 0 ? 180 : 0,
    0,
  ];
}

/**
 * World-space local +Z axis produced by a deck.gl mesh orientation.
 *
 * Mirrors the library matrix so orientation maths can be asserted instead of
 * eyeballed. Same convention as `coneOrientation`.
 *
 * @param {[number, number, number]} orientation `[pitch, yaw, roll]` in degrees.
 * @returns {[number, number, number]}
 */
export function coneAxis([pitchDeg = 0, yawDeg = 0, rollDeg = 0]) {
  const pitch = (pitchDeg * Math.PI) / 180;
  const yaw = (yawDeg * Math.PI) / 180;
  const roll = (rollDeg * Math.PI) / 180;
  const sr = Math.sin(roll);
  const sp = Math.sin(pitch);
  const sw = Math.sin(yaw);
  const cr = Math.cos(roll);
  const cp = Math.cos(pitch);
  const cw = Math.cos(yaw);
  return [
    sw * sr + cw * sp * cr,
    -cw * sr + sw * sp * cr,
    cp * cr,
  ];
}


/**
 * Smoothed band series prepared for one ring.
 *
 * The band median is smoothed on the union grid and resampled to `count` uniform
 * steps in time; every individual scatterer is smoothed on its own dates and
 * interpolated onto those same steps, so faint scatterer curves and the bold
 * median share one time→angle mapping.
 *
 * @param {Array<any>} scatterers Features assigned to this band of this track.
 * @param {number[]} grid Union date grid.
 * @param {number} windowDays
 * @param {number} count Display vertices per curve.
 * @returns {{
 *   median: Array<number|null>,
 *   times: number[],
 *   scatterers: Array<Array<number|null>>,
 * }}
 */
export function haloBandSeries(scatterers, grid, windowDays, count = 120) {
  const empty = { median: [], times: [], scatterers: [] };
  if (!Array.isArray(scatterers) || !Array.isArray(grid) || grid.length < 2) return empty;

  const dense = bandMedianSeries(scatterers, windowDays, grid);
  const display = resampleSeries(dense, grid, count);
  if (display.series.length < 2) return empty;

  const perScatterer = [];
  for (const feature of scatterers) {
    const { dates, values } = featureSeries(feature);
    if (dates.length < 2) continue;
    const smoothed = smoothSeries(values, dates, windowDays);
    perScatterer.push(interpolateSeries(display.grid, dates, smoothed));
  }

  return { median: display.series, times: display.grid, scatterers: perScatterer };
}

/**
 * Flat polar point on a ring: `radiusM` at `angleDeg`, clockwise from north.
 *
 * Both degrees factors are used, so east–west and north–south distances stay
 * true at this latitude.
 */
function haloPoint(pylon, mPerDegLon, z, radiusM, angleDeg) {
  const angle = (angleDeg * Math.PI) / 180;
  return [
    pylon.lon + (radiusM * Math.sin(angle)) / mPerDegLon,
    pylon.lat + (radiusM * Math.cos(angle)) / METRES_PER_DEG_LAT,
    z,
  ];
}

/**
 * One band's polar frame: the two semicircular glass discs, the 0 mm circle and
 * the north–south divider.
 *
 * The annulus is split at the divider into a west and an east half instead of
 * being emitted as a single ring with a hole: each half is a simple closed
 * polygon (outer arc, radial seam on the divider, inner arc back), so
 * `getPolygon(...).flat()` + `_normalize: false` tessellates without holes or
 * degenerate seams. The seams sit exactly under the divider line.
 *
 * @param {{
 *   pylon: { lon: number, lat: number }, base: number, bandZ: number,
 *   segments?: number,
 * }} options
 * @returns {{
 *   discs: Array<{ side: 'west'|'east', polygon: number[][] }>,
 *   zeroCircle: number[][],
 *   divider: number[][],
 * }}
 */
export function buildHaloRingFrame({ pylon, base, bandZ, segments = HALO_SEGMENTS }) {
  const empty = { discs: [], zeroCircle: [], divider: [] };
  if (!pylon || !Number.isFinite(pylon.lon) || !Number.isFinite(pylon.lat)) return empty;
  if (!Number.isFinite(base) || !Number.isFinite(bandZ)) return empty;

  const z = base + bandZ;
  const mPerDegLon = metresPerDegLon(pylon.lat);
  const half = Math.max(2, Math.round(segments / 2));
  const outer = (deg) => haloPoint(pylon, mPerDegLon, z, HALO_OUTER_RADIUS_M, deg);
  const inner = (deg) => haloPoint(pylon, mPerDegLon, z, HALO_INNER_RADIUS_M, deg);

  // West: outer 180° → 360° (south → west → north), then inner back to 180°.
  const west = [];
  for (let i = 0; i <= half; i++) west.push(outer(180 + (180 * i) / half));
  for (let i = half; i >= 0; i--) west.push(inner(180 + (180 * i) / half));

  // East: outer 0° → 180° (north → east → south), then inner back to 0°.
  const east = [];
  for (let i = 0; i <= half; i++) east.push(outer((180 * i) / half));
  for (let i = half; i >= 0; i--) east.push(inner((180 * i) / half));

  const steps = Math.max(8, Math.round(segments));
  const zeroCircle = [];
  for (let i = 0; i <= steps; i++) {
    zeroCircle.push(haloPoint(pylon, mPerDegLon, z, HALO_ZERO_RADIUS_M, (360 * i) / steps));
  }

  return {
    discs: [
      { side: 'west', polygon: west },
      { side: 'east', polygon: east },
    ],
    zeroCircle,
    divider: [outer(0), outer(180)],
  };
}

/**
 * One track's polar timeline curve on a ring.
 *
 * Time runs clockwise from north: 95D sweeps the west semicircle from 345° (2014)
 * through 270° (due west, mid-record) to 195° (2026); both ascending tracks sweep
 * the east semicircle from 15° through 90° to 165°. Displacement is radial:
 *
 *     r = clamp(HALO_ZERO + value × scale, HALO_INNER, HALO_OUTER)
 *
 * so negative LOS bends inward toward the pylon and positive bends outward.
 *
 * @param {{
 *   pylon: { lon: number, lat: number }, base: number, bandZ: number,
 *   bandIndex?: number, trackId?: string, side: 'west'|'east',
 *   series: Array<number|null>, scatterers?: Array<Array<number|null>>,
 *   times?: number[],
 * }} options
 * @returns {{
 *   curve: number[][][],
 *   scatterers: number[][][],
 *   anchors: number[][],
 * }}
 */
export function buildHaloRingGeometry({
  pylon,
  base,
  bandZ,
  bandIndex = 0,
  trackId = '',
  side,
  series,
  scatterers = [],
  times,
}) {
  const empty = { curve: [], scatterers: [], anchors: [] };
  if (!Array.isArray(series) || !Array.isArray(times) || series.length < 2) return empty;
  if (!pylon || !Number.isFinite(pylon.lon) || !Number.isFinite(pylon.lat)) return empty;
  if (!Number.isFinite(base) || !Number.isFinite(bandZ)) return empty;

  const z = base + bandZ;
  const mPerDegLon = metresPerDegLon(pylon.lat);
  const startDeg = side === 'west' ? HALO_WEST_START_DEG : HALO_EAST_START_DEG;
  const sweepDeg = side === 'west' ? -HALO_ARC_DEG : HALO_ARC_DEG;
  const count = series.length;

  const vertexAt = (value, index) => {
    const u = count === 1 ? 0 : index / (count - 1);
    const angle = startDeg + sweepDeg * u;
    const radius = Math.min(
      HALO_OUTER_RADIUS_M,
      Math.max(
        HALO_INNER_RADIUS_M,
        HALO_ZERO_RADIUS_M + value * HALO_RADIAL_SCALE_M_PER_MM,
      ),
    );
    return haloPoint(pylon, mPerDegLon, z, radius, angle);
  };

  const buildRuns = (values) => {
    const runs = [];
    let run = null;
    for (let i = 0; i < count; i++) {
      const value = values?.[i];
      if (Number.isFinite(value)) {
        if (!run) {
          run = [];
          runs.push(run);
        }
        run.push(vertexAt(value, i));
      } else {
        run = null;
      }
    }
    return runs;
  };

  const curve = buildRuns(series);
  const anchors = [];
  for (const run of curve) {
    if (run.length === 0) continue;
    anchors.push(run[0]);
    if (run.length > 1) anchors.push(run[run.length - 1]);
  }

  return {
    curve,
    scatterers: scatterers.map((values) => buildRuns(values)),
    anchors,
    bandIndex,
    trackId,
  };
}

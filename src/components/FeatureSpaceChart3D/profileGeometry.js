/**
 * Shared geometry for the 3D line-profile mode of the feature-space chart.
 *
 * Pure module apart from the attribute registry (no React / three / deck.gl).
 * Renderers hand it the `profile` prop the chart builds from the app's
 * `buildProfileSamples` output and get back cube-normalised positions (for
 * deck.gl/three.js) alongside the raw values (for Plotly, which has real 3D
 * axes and wants real units).
 *
 * Profile shape: `{ view, yKey, zKey, trendLines, samples: [{ id, distance, lon,
 * lat, <ATTRIBUTES keys…> }] }`. Three views, all emitting a `curves` array:
 *
 * - `attributes`: one curve. X = distance, Y = `yKey`, Z = `zKey`, with a
 *   translucent `z ± std` ribbon on Z when `zKey` declares a paired `stdKey`.
 *   When `profile.breakAtGaps` is set, a segment is dropped where the along-line
 *   spacing exceeds `GAP_FACTOR ×` the median spacing (so a straight line is not
 *   drawn across a sparse stretch), and each sample carries `offsetT` (its
 *   perpendicular offset normalised by `bufferDistance`) for size encoding.
 * - `aggregate`: one curve from `aggregateSamples`, binning `distance` into
 *   `profile.step`-metre bins and plotting the per-bin median with an IQR band.
 *   Empty bins are gaps; `profile.interpolate` bridges them (flagged).
 * - `trend` / `windows`: the original reading. One curve per `TREND_WINDOWS`
 *   entry. X = distance, Y = the window's evenly spaced band, Z = that window's
 *   `TD_*`, with its paired `STD_*` band on Z. This is the only shape whose
 *   uncertainty is genuinely per-series.
 * - `trend` / `profiles`: one cumulative-settlement profile per `TREND_TIMELINE`
 *   step. X = distance, Y = the step's evenly spaced band, Z = the cumulative
 *   settlement (`TD_730 - TD_x`, see `settlement.js`); no band.
 * - `trend` / `points`: one settlement-vs-time curve per point, stepping across
 *   the timeline bands (Y) against that point's cumulative settlement (Z); no
 *   ribbon.
 */

import { ATTRIBUTES, axisTitle, TREND_TIMELINE, TREND_WINDOWS, trendWindowLabel } from './attributes';
import { settlementOf } from './settlement';

/** Colour used for the attribute curve and the (uniform) per-point curves. */
export const PROFILE_COLOR = '#1f77b4';

/**
 * Sequential ramp used to colour points by their cumulative settlement (the
 * Trend ▸ points shape). Ordered low -> high as red -> yellow -> teal, so that
 * negative / downward settlement reads red and upward reads teal. Matches the
 * map marker scale (`MAP_VELOCITY_COLORS`), which is flipped to the same
 * orientation.
 */
export const DISPLACEMENT_RAMP = ['#d7191c', '#fefebf', '#41b6c4'];

/**
 * Fixed colour domain for the settlement ramp, matching the map's velocity
 * colour domain (`MAP_VELOCITY_DOMAIN`) so point colours are comparable across
 * selections. Values outside are clamped.
 */
export const DISPLACEMENT_DOMAIN = [-3, 3];

/** `#rrggbb` -> [r, g, b] (0-255). */
function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const n = parseInt(h, 16);
  if (!Number.isFinite(n)) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const DISPLACEMENT_RGB = DISPLACEMENT_RAMP.map(hexToRgb);

/**
 * Sample the displacement ramp at `t` in [0,1] (clamped).
 * @param {number} t
 * @returns {[number, number, number]} rgb 0-255
 */
export function displacementRgb(t) {
  const c = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0.5));
  const scaled = c * (DISPLACEMENT_RGB.length - 1);
  const i = Math.min(DISPLACEMENT_RGB.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = DISPLACEMENT_RGB[i];
  const b = DISPLACEMENT_RGB[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Displacement colour as a `#rrggbb` string. */
export function displacementColor(t) {
  return `#${displacementRgb(t).map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Plotly-compatible colorscale for the displacement ramp. */
export const DISPLACEMENT_COLORSCALE = DISPLACEMENT_RAMP.map((hex, i) => [
  i / (DISPLACEMENT_RAMP.length - 1),
  hex,
]);

/** @param {unknown} v */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Widen a degenerate/empty domain so normalisation never divides by zero. */
function resolveDomain(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    return [min - pad * 0.5, max + pad * 0.5];
  }
  return [min, max];
}

function normalize(value, [lo, hi], cube) {
  const t = hi === lo ? 0.5 : (value - lo) / (hi - lo);
  return (Math.max(0, Math.min(1, t)) - 0.5) * 2 * cube;
}

/** Evenly spaced Y position (cube units) for ordered band `i` of `count`. */
function bandY(i, count, cube) {
  if (count <= 1) return 0;
  return (i / (count - 1) - 0.5) * 2 * cube;
}

/**
 * Multiplier on the median consecutive-distance spacing beyond which the drawn
 * Attribute polyline is broken instead of bridging a sparse stretch. A heuristic
 * (no break when fewer than 3 rows or the median spacing is 0).
 */
export const GAP_FACTOR = 4;

/**
 * Linear-interpolated quantile (R type 7) of an already-sorted numeric array.
 * @param {number[]} sorted
 * @param {number} q  quantile in [0,1]
 * @returns {number|null}
 */
function quantile(sorted, q) {
  const n = sorted.length;
  if (n === 0) return null;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Round a raw step to a "nice" 1/2/5 × 10^n value, used as the auto aggregate
 * bin size (`niceStep(maxDistance / 50)`).
 * @param {number} raw
 * @returns {number}
 */
export function niceStep(raw) {
  if (!isNum(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * base;
}

/**
 * Bin the raw line samples by `distance` and summarise each bin. Pure: it only
 * reads `s.distance` and `s[valueKey]`, so it stays portable.
 *
 * Per non-empty bin: `{ binIndex, id, distance: binCenter, binStart, binEnd,
 * value: median, iqrLo, iqrHi, n, interpolated: false }`. Empty bins are omitted
 * (they read as gaps). When `interpolate` is set, empty bins strictly *between*
 * the first and last non-empty bin are filled by linear interpolation of the
 * median (`iqrLo/iqrHi = null`, `n = 0`, `interpolated: true`) — never before the
 * first or after the last measured bin.
 *
 * @param {Array<any>} samples
 * @param {string} valueKey
 * @param {number} stepMeters
 * @param {boolean} interpolate
 * @returns {Array<{ binIndex:number, id:string, distance:number, binStart:number,
 *   binEnd:number, value:number, iqrLo:number|null, iqrHi:number|null,
 *   n:number, lon:number|null, lat:number|null, interpolated:boolean }>}
 */
export function aggregateSamples(samples, valueKey, stepMeters, interpolate) {
  const step = Number(stepMeters);
  if (!isNum(step) || step <= 0 || !Array.isArray(samples) || samples.length === 0) return [];

  let maxDistance = -Infinity;
  for (const s of samples) {
    if (isNum(s.distance) && s.distance > maxDistance) maxDistance = s.distance;
  }
  if (!isNum(maxDistance)) return [];

  const binCount = Math.floor(maxDistance / step) + 1;
  const buckets = Array.from({ length: binCount }, () => []);
  for (const s of samples) {
    const v = s[valueKey];
    if (!isNum(s.distance) || !isNum(v)) continue;
    const idx = Math.max(0, Math.min(binCount - 1, Math.floor(s.distance / step)));
    // Keep each member's foot position so the bin can emit a geographic centroid
    // (used to place the map-side curtain).
    buckets[idx].push({ v, lon: s.lon, lat: s.lat });
  }

  const entries = [];
  for (let i = 0; i < binCount; i += 1) {
    const members = buckets[i];
    if (members.length === 0) continue;
    const vals = members.map((m) => m.v).sort((a, b) => a - b);
    let lonSum = 0;
    let latSum = 0;
    let posN = 0;
    for (const m of members) {
      if (isNum(m.lon) && isNum(m.lat)) {
        lonSum += m.lon;
        latSum += m.lat;
        posN += 1;
      }
    }
    entries.push({
      binIndex: i,
      id: `bin-${i}`,
      distance: (i + 0.5) * step,
      binStart: i * step,
      binEnd: Math.min((i + 1) * step, maxDistance),
      value: quantile(vals, 0.5),
      iqrLo: quantile(vals, 0.25),
      iqrHi: quantile(vals, 0.75),
      n: vals.length,
      lon: posN > 0 ? lonSum / posN : null,
      lat: posN > 0 ? latSum / posN : null,
      interpolated: false,
    });
  }

  if (!interpolate || entries.length < 2) return entries;

  const filled = [];
  for (let k = 0; k < entries.length; k += 1) {
    const cur = entries[k];
    filled.push(cur);
    const next = entries[k + 1];
    if (!next) break;
    for (let b = cur.binIndex + 1; b < next.binIndex; b += 1) {
      const t = (b - cur.binIndex) / (next.binIndex - cur.binIndex);
      filled.push({
        binIndex: b,
        id: `bin-${b}`,
        distance: (b + 0.5) * step,
        binStart: b * step,
        binEnd: Math.min((b + 1) * step, maxDistance),
        value: cur.value + (next.value - cur.value) * t,
        iqrLo: null,
        iqrHi: null,
        n: 0,
        lon: isNum(cur.lon) && isNum(next.lon) ? cur.lon + (next.lon - cur.lon) * t : null,
        lat: isNum(cur.lat) && isNum(next.lat) ? cur.lat + (next.lat - cur.lat) * t : null,
        interpolated: true,
      });
    }
  }
  return filled;
}

/**
 * Split a curve's frame samples into drawable runs, breaking at any row whose
 * `linkedToPrev` is false (a sparse gap in the Attribute view, or a skipped empty
 * bin in the Aggregate view). When `breakAtGaps` is false the whole list is a
 * single run, so the line is drawn continuously.
 *
 * @param {Array<any>} samples
 * @param {boolean} [breakAtGaps]
 * @returns {Array<Array<any>>}
 */
export function splitRuns(samples, breakAtGaps = true) {
  if (!Array.isArray(samples) || samples.length === 0) return [];
  if (!breakAtGaps) return [samples];
  const runs = [];
  let run = [samples[0]];
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i].linkedToPrev) {
      run.push(samples[i]);
    } else {
      runs.push(run);
      run = [samples[i]];
    }
  }
  runs.push(run);
  return runs;
}

/**
 * Mark `linkedToPrev` on an Attribute curve's rows from the along-line spacing:
 * a row is linked only when the `distance` gap to the previous row does not
 * exceed `GAP_FACTOR ×` the median spacing. With fewer than 3 rows, or a
 * zero/undefined median spacing, every row is linked (no breaks).
 */
function markAttributeLinks(rows) {
  const d = rows.map((r) => (isNum(r.s?.distance) ? r.s.distance : NaN));
  const gaps = [];
  for (let i = 1; i < d.length; i += 1) {
    if (isNum(d[i]) && isNum(d[i - 1])) gaps.push(d[i] - d[i - 1]);
  }
  let threshold = Infinity;
  if (rows.length >= 3 && gaps.length >= 2) {
    const med = quantile([...gaps].sort((a, b) => a - b), 0.5);
    if (isNum(med) && med > 0) threshold = GAP_FACTOR * med;
  }
  rows.forEach((r, i) => {
    if (i === 0) {
      r.linkedToPrev = false;
      return;
    }
    const diff = isNum(d[i]) && isNum(d[i - 1]) ? d[i] - d[i - 1] : Infinity;
    r.linkedToPrev = diff <= threshold;
  });
}

/** Mark `linkedToPrev` on an Aggregate curve's rows from bin adjacency. */
function markBinLinks(rows) {
  rows.forEach((r, i) => {
    r.linkedToPrev = i > 0 && r.bin.binIndex === rows[i - 1].bin.binIndex + 1;
  });
}

/**
 * Attribute view: one curve. `along` basis: X = distance along the line,
 * Y = `yKey`, Z = `zKey`. `plan` basis: X = longitude, Y = latitude on an equal
 * ground scale, Z = `zKey`. A `z ± std` band is added when `zKey` declares a
 * paired `stdKey` and that sample's std is finite.
 */
function attributeCurves(yKey, zKey, samples, basis) {
  const stdKey = ATTRIBUTES[zKey]?.stdKey ?? null;
  const plan = basis === 'plan';

  const rows = [];
  for (const s of samples) {
    const z = s[zKey];
    if (!isNum(z)) continue;
    if (plan) {
      if (!isNum(s.lon) || !isNum(s.lat)) continue;
    } else if (!isNum(s.distance) || !isNum(s[yKey])) {
      continue;
    }
    // A missing standard deviation stays "unknown": mark the row unbanded so no
    // ribbon is drawn rather than asserting a zero-width (zero-uncertainty) band.
    const std = stdKey && isNum(s[stdKey]) ? Math.abs(s[stdKey]) : null;
    rows.push({
      s,
      z,
      lo: std != null ? z - std : z,
      hi: std != null ? z + std : z,
      std,
      banded: std != null,
      // `x`/`y` are the cube-normalisation coordinates (`xRaw`/`yRaw` are the
      // values the axes are labelled with: distance/attribute, or real lon/lat).
      ...(plan
        ? { x: 0, y: 0, xRaw: s.lon, yRaw: s.lat }
        : { x: s.distance, y: s[yKey], xRaw: s.distance, yRaw: s[yKey] }),
    });
  }

  if (plan && rows.length > 0) {
    // Equal ground scale: longitude degrees shrink by cos(lat), and both axes
    // share one symmetric half-extent so the plan keeps its true aspect instead
    // of being stretched into a square.
    const lat0 = rows.reduce((a, r) => a + r.yRaw, 0) / rows.length;
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const gx = rows.map((r) => r.xRaw * kx);
    const gy = rows.map((r) => r.yRaw);
    const cx = (Math.min(...gx) + Math.max(...gx)) / 2;
    const cy = (Math.min(...gy) + Math.max(...gy)) / 2;
    for (let i = 0; i < rows.length; i++) {
      rows[i].x = gx[i] - cx;
      rows[i].y = gy[i] - cy;
    }
  }

  // Connect the samples in along-line order in both bases: `distance` grows
  // monotonically along the drawn line, so the polyline traces it. Sorting the
  // Plan basis by its display X (longitude) would scramble a transect that runs
  // mostly north-south into a zig-zag instead of following the line.
  rows.sort((a, b) => {
    const da = isNum(a.s.distance) ? a.s.distance : a.x;
    const db = isNum(b.s.distance) ? b.s.distance : b.x;
    return da - db;
  });
  markAttributeLinks(rows);
  return [{ key: 'profile', label: 'Profile', color: PROFILE_COLOR, stdKey, banded: !!stdKey, rows }];
}

/**
 * Aggregate view: bin `distance` into `stepMeters` bins and plot each bin's
 * median on Z (X = distance, Y pinned flat), with the IQR (25-75 pct) as the Z
 * ribbon. Empty bins are gaps; `interpolate` bridges them (flagged). Rows carry
 * their bin entry on `s` so the tooltip can read `n`/`iqrLo`/`iqrHi`.
 */
function aggregateCurve(samples, valueKey, stepMeters, interpolate) {
  const entries = aggregateSamples(samples, valueKey, stepMeters, interpolate);
  const rows = entries.map((e) => ({
    s: e,
    bin: e,
    x: e.distance,
    y: 0,
    z: e.value,
    lo: e.iqrLo ?? e.value,
    hi: e.iqrHi ?? e.value,
    std: null,
    banded: e.iqrLo != null && e.iqrHi != null,
    interpolated: e.interpolated,
  }));
  if (rows.length === 0) return [];
  markBinLinks(rows);
  return [{ key: 'aggregate', label: 'Median', color: PROFILE_COLOR, stdKey: null, banded: true, rows }];
}

/**
 * Trend / windows: the original reading. One curve per `TREND_WINDOWS` entry at
 * an even Y band, carrying that window's `TD_*` on Z and its paired `STD_*` band.
 * A curve needs ≥ 2 finite samples. The band is the raw per-window uncertainty
 * (the one place it varies meaningfully between series).
 */
function windowCurves(samples, cube) {
  const count = TREND_WINDOWS.length;
  const curves = [];
  TREND_WINDOWS.forEach((w, i) => {
    const y = bandY(i, count, cube);
    const rows = [];
    for (const s of samples) {
      const x = s.distance;
      const z = s[w.key];
      if (!isNum(x) || !isNum(z)) continue;
      const std = isNum(s[w.stdKey]) ? Math.abs(s[w.stdKey]) : null;
      rows.push({
        s,
        x,
        y,
        z,
        lo: std != null ? z - std : z,
        hi: std != null ? z + std : z,
        std,
        banded: std != null,
        stepKey: w.key,
        stepLabel: trendWindowLabel(w.days),
      });
    }
    rows.sort((a, b) => a.x - b.x);
    if (rows.length >= 2) {
      curves.push({
        key: w.key,
        label: trendWindowLabel(w.days),
        color: w.color,
        stdKey: w.stdKey,
        banded: !!w.stdKey,
        rows,
      });
    }
  });
  return curves;
}

/**
 * Trend / profiles: one cumulative-settlement profile per timeline step at an
 * even Y band, carrying the settlement `TD_730 - TD_x` on Z. No uncertainty band
 * (the per-window ±σ lives on the `windows` shape instead — a propagated σ here
 * is dominated by the shared reference term and barely varies between steps).
 * A curve needs ≥ 2 finite samples.
 */
function settlementProfiles(samples, cube) {
  const count = TREND_TIMELINE.length;
  const curves = [];
  TREND_TIMELINE.forEach((step, i) => {
    const y = bandY(i, count, cube);
    const rows = [];
    for (const s of samples) {
      const x = s.distance;
      const z = settlementOf(s, step);
      if (!isNum(x) || !isNum(z)) continue;
      rows.push({
        s,
        x,
        y,
        z,
        lo: z,
        hi: z,
        std: null,
        banded: false,
        stepKey: step.label,
        stepLabel: step.label,
      });
    }
    rows.sort((a, b) => a.x - b.x);
    if (rows.length >= 2) {
      curves.push({
        key: step.label,
        label: step.label,
        color: step.color,
        stdKey: null,
        banded: false,
        rows,
      });
    }
  });
  return curves;
}

/**
 * Trend / points: one cumulative-settlement curve per point, stepping across the
 * timeline bands in ascending time order against that point's settlement values.
 * No ribbon. A curve needs ≥ 2 finite steps; samples are grouped by `id` (one
 * sample per feature in practice, each carrying all its `TD_*` values).
 */
function settlementPoints(samples, cube) {
  const count = TREND_TIMELINE.length;
  const groups = new Map();
  for (const s of samples) {
    const key = s.id == null ? `__point_${groups.size}` : String(s.id);
    if (!groups.has(key)) groups.set(key, { id: s.id, samples: [] });
    groups.get(key).samples.push(s);
  }

  const curves = [];
  let index = 0;
  for (const group of groups.values()) {
    const rows = [];
    TREND_TIMELINE.forEach((step, i) => {
      const s = group.samples.find((sm) => settlementOf(sm, step) != null);
      if (!s) return;
      const z = settlementOf(s, step);
      rows.push({
        s,
        x: s.distance,
        y: bandY(i, count, cube),
        z,
        lo: z,
        hi: z,
        std: null,
        banded: false,
        stepKey: step.label,
        stepLabel: step.label,
      });
    });
    if (rows.length >= 2) {
      const label = group.id == null ? `point ${index + 1}` : String(group.id);
      curves.push({ key: `point-${index}`, label, color: PROFILE_COLOR, stdKey: null, banded: false, rows });
    }
    index += 1;
  }
  return curves;
}

/**
 * Build the render-ready profile frame (one or more curves).
 *
 * @param {{view?:'attributes'|'trend'|'aggregate', basis?:'along'|'plan',
 *   yKey?:string, zKey?:string, trendLines?:'windows'|'profiles'|'points',
 *   valueKey?:string, step?:number, interpolate?:boolean,
 *   bufferDistance?:number, breakAtGaps?:boolean, sizeByOffset?:boolean,
 *   samples?:Array<any>}} profile
 * @param {number} [cube] half-extent of the normalised cube
 * @returns {{
 *   view:'attributes'|'trend'|'aggregate', shape:'windows'|'profiles'|'points'|null,
 *   basis:'along'|'plan', yKey:string|null, zKey:string|null,
 *   valueKey:string|null, binCount:number|null,
 *   breakAtGaps:boolean, sizeByOffset:boolean,
 *   titles:{x:string,y:string,z:string},
 *   domains:{x:[number,number],y:[number,number],z:[number,number]},
 *   axisDomains:{x:[number,number],y:[number,number],z:[number,number]},
 *   colorDomain:[number,number]|null,
 *   yTicks:Array<{value:number,label:string}>|null,
 *   curves:Array<{ key:string, label:string, color:string, stdKey:string|null,
 *     banded:boolean, colored:boolean,
 *     samples:Array<{
 *       id:any, position:[number,number,number],
 *       ribbon:{lo:[number,number,number],hi:[number,number,number]}|null,
 *       raw:{x:number,y:number,z:number,lo:number,hi:number,std:number|null},
 *       color:string|null, linkedToPrev:boolean, interpolated:boolean,
 *       offsetT:number|null,
 *       stepKey:string|null, stepLabel:string|null, sample:any }> }>,
 * }}
 */
export function buildProfileFrame(profile, cube = 1) {
  const view =
    profile?.view === 'aggregate' ? 'aggregate' : profile?.view === 'trend' ? 'trend' : 'attributes';
  const samples = profile?.samples ?? [];
  const yKey = profile?.yKey ?? 'H';
  const zKey = profile?.zKey ?? 'VEL_REL';
  const basis = profile?.basis === 'plan' ? 'plan' : 'along';
  const isPlan = view === 'attributes' && basis === 'plan';
  const shape = view === 'trend' ? (profile?.trendLines ?? 'profiles') : null;

  // Aggregate reads one attribute on Z; the Attribute view breaks the polyline
  // at sparse gaps unless disabled, and always carries a normalised offset.
  const aggValueKey = profile?.valueKey ?? zKey;
  const aggStep = profile?.step;
  const aggInterpolate = profile?.interpolate === true;
  // Polyline stays connected by default (opt in to gap breaks with
  // `profile.breakAtGaps === true`). The Aggregate view is always a single
  // connected line through its bins, so it never breaks.
  const breakAtGaps = profile?.breakAtGaps === true;
  const sizeByOffset = profile?.sizeByOffset !== false;

  // Offset normaliser (Attribute/Trend views): the corridor half-width when
  // known, else the selection's own max |offset| so the encoding still spans the
  // sample set.
  let offsetDenom = isNum(profile?.bufferDistance) && profile.bufferDistance > 0
    ? profile.bufferDistance
    : null;
  if (view !== 'aggregate' && offsetDenom == null) {
    let maxOff = 0;
    for (const s of samples) {
      if (isNum(s.offset)) maxOff = Math.max(maxOff, Math.abs(s.offset));
    }
    offsetDenom = maxOff > 0 ? maxOff : null;
  }

  const rawCurves =
    view === 'aggregate'
      ? aggregateCurve(samples, aggValueKey, aggStep, aggInterpolate)
      : view === 'trend'
        ? shape === 'windows'
          ? windowCurves(samples, cube)
          : shape === 'points'
            ? settlementPoints(samples, cube)
            : settlementProfiles(samples, cube)
        : attributeCurves(yKey, zKey, samples, basis);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let xRawMin = Infinity;
  let xRawMax = -Infinity;
  let yRawMin = Infinity;
  let yRawMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (const c of rawCurves) {
    for (const r of c.rows) {
      if (r.x < xMin) xMin = r.x;
      if (r.x > xMax) xMax = r.x;
      if (r.y < yMin) yMin = r.y;
      if (r.y > yMax) yMax = r.y;
      const xr = r.xRaw ?? r.x;
      const yr = r.yRaw ?? r.y;
      if (xr < xRawMin) xRawMin = xr;
      if (xr > xRawMax) xRawMax = xr;
      if (yr < yRawMin) yRawMin = yr;
      if (yr > yRawMax) yRawMax = yr;
      // Z domain must cover the full band, else normalisation clamps the ribbon.
      if (r.lo < zMin) zMin = r.lo;
      if (r.hi > zMax) zMax = r.hi;
    }
  }

  let xd;
  let yd;
  if (isPlan) {
    // One shared, symmetric half-extent for X and Y keeps the ground aspect.
    // The plan rows are already centred, so this only picks the larger half.
    const half = Math.max(Math.abs(xMin), Math.abs(xMax), Math.abs(yMin), Math.abs(yMax)) || 1e-9;
    xd = [-half, half];
    yd = [-half, half];
  } else if (view === 'trend') {
    xd = resolveDomain(xMin, xMax);
    // Trend Y is an ordered categorical axis: pin the domain to the band range so
    // the bands keep fixed, even spacing regardless of which steps are present.
    yd = [-cube, cube];
  } else {
    xd = resolveDomain(xMin, xMax);
    yd = resolveDomain(yMin, yMax);
  }
  const zd = resolveDomain(zMin, zMax);

  // Display tick domains (what the axes are labelled with): distance/attribute,
  // or real lon/lat in the Plan basis.
  const axisDomains = {
    x: resolveDomain(xRawMin, xRawMax),
    y: resolveDomain(yRawMin, yRawMax),
    z: zd,
  };

  // The Trend ▸ points shape colours each point by its own cumulative settlement;
  // every other curve keeps its fixed colour. The colour domain is pinned to the
  // map's [-3, 3] (not the data range), so curve colours stay comparable.
  const colorByDisplacement = view === 'trend' && shape === 'points';
  const [cLo, cHi] = DISPLACEMENT_DOMAIN;

  const curves = rawCurves.map((c) => ({
    key: c.key,
    label: c.label,
    color: c.color,
    stdKey: c.stdKey ?? null,
    banded: c.banded ?? !!c.stdKey,
    colored: colorByDisplacement,
    samples: c.rows.map((r, i) => {
      const xn = normalize(r.x, xd, cube);
      const yn = normalize(r.y, yd, cube);
      const zn = normalize(r.z, zd, cube);
      const ribbon = r.banded
        ? {
            lo: [xn, yn, normalize(r.lo, zd, cube)],
            hi: [xn, yn, normalize(r.hi, zd, cube)],
          }
        : null;
      const zt = cHi === cLo ? 0.5 : (r.z - cLo) / (cHi - cLo);
      const offset = r.s?.offset;
      const offsetT = isNum(offset) && offsetDenom
        ? Math.max(0, Math.min(1, Math.abs(offset) / offsetDenom))
        : null;
      return {
        id: r.s.id,
        position: [xn, yn, zn],
        ribbon,
        raw: { x: r.xRaw ?? r.x, y: r.yRaw ?? r.y, z: r.z, lo: r.lo, hi: r.hi, std: r.std ?? null },
        color: colorByDisplacement ? displacementColor(zt) : null,
        stepKey: r.stepKey ?? null,
        stepLabel: r.stepLabel ?? null,
        // Whether the segment from the previous emitted row may be drawn, and
        // whether this row is inferred rather than measured.
        linkedToPrev: r.linkedToPrev ?? i > 0,
        interpolated: r.interpolated === true || r.s?.interpolated === true,
        // Perpendicular offset normalised to [0,1] (Attribute view only); the
        // renderers map it to marker/sphere size. `null` when not applicable.
        offsetT,
        sample: r.s,
      };
    }),
  }));

  // The `windows` shape reads the raw per-window displacement; the cumulative
  // shapes read settlement from the initial state.
  const titles =
    view === 'aggregate'
      ? { x: 'Distance along profile [m]', y: '', z: axisTitle(aggValueKey) }
      : view === 'trend'
        ? shape === 'windows'
          ? { x: 'Distance along profile [m]', y: 'Trend window', z: 'Trend displacement [mm]' }
          : { x: 'Distance along profile [m]', y: 'Time', z: 'Cumulative settlement [mm]' }
        : isPlan
          ? { x: 'Longitude [\u00b0]', y: 'Latitude [\u00b0]', z: axisTitle(zKey) }
          : { x: 'Distance along profile [m]', y: axisTitle(yKey), z: axisTitle(zKey) };

  // Trend Y is categorical: label each band position with its window/timeline
  // step, else the numeric -1..1 band coordinate is meaningless.
  const yTicks =
    view === 'trend'
      ? shape === 'windows'
        ? TREND_WINDOWS.map((w, i) => ({
            value: bandY(i, TREND_WINDOWS.length, cube),
            label: trendWindowLabel(w.days),
          }))
        : TREND_TIMELINE.map((step, i) => ({
            value: bandY(i, TREND_TIMELINE.length, cube),
            label: step.label,
          }))
      : null;

  return {
    view,
    shape,
    basis,
    yKey: view === 'attributes' ? (isPlan ? 'lat' : yKey) : null,
    zKey: view === 'attributes' ? zKey : null,
    valueKey: view === 'aggregate' ? aggValueKey : null,
    binCount: view === 'aggregate' ? (curves[0]?.samples.length ?? 0) : null,
    breakAtGaps,
    sizeByOffset,
    titles,
    domains: { x: xd, y: yd, z: zd },
    axisDomains,
    colorDomain: colorByDisplacement ? [...DISPLACEMENT_DOMAIN] : null,
    yTicks,
    curves,
  };
}

/** Compact numeric tick/tooltip formatter for raw profile values. */
export function formatTick(v) {
  if (!isNum(v)) return '\u2014';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

/** `#rgb`/`#rrggbb` -> [r, g, b, a] rgba tuple. */
export function hexToRgba(hex, alpha = 255) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n)) return [128, 128, 128, alpha];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

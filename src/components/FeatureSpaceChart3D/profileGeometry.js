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
 * lat, <ATTRIBUTES keys…> }] }`. Two views, both emitting a `curves` array:
 *
 * - `attributes`: one curve. X = distance, Y = `yKey`, Z = `zKey`, with a
 *   translucent `z ± std` ribbon on Z when `zKey` declares a paired `stdKey`.
 * - `trend` / `windows`: one curve per `TREND_WINDOWS` entry. X = distance,
 *   Y = the window's evenly spaced band, Z = that window's `TD_*`, with a
 *   `TD ± STD` band on Z when the paired `STD_*` is finite.
 * - `trend` / `windows-plain`: same as `windows` but with the uncertainty band
 *   omitted, so its Z range matches the `points` shape.
 * - `trend` / `points`: one curve per point, stepping across the window bands
 *   (Y) against that point's `TD_*` (Z); no ribbon.
 */

import { ATTRIBUTES, axisTitle, TREND_WINDOWS, trendWindowLabel } from './attributes';

/** Colour used for the attribute curve and the (uniform) per-point curves. */
export const PROFILE_COLOR = '#1f77b4';

/**
 * Sequential ramp used to colour points by their trend displacement. Mirrors
 * the map's default colour scale (`MAP_VELOCITY_COLORS`: blue -> yellow -> red,
 * rgb interpolation) so the chart agrees with the map. Ordered low -> high.
 */
export const DISPLACEMENT_RAMP = ['#41b6c4', '#fefebf', '#d7191c'];

/**
 * Fixed colour domain for the displacement ramp, matching the map's velocity
 * colour domain (`MAP_VELOCITY_DOMAIN`) so point colours are comparable across
 * selections and agree with the map scale. Values outside are clamped.
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
  return [{ key: 'profile', label: 'Profile', color: PROFILE_COLOR, stdKey, rows }];
}

/**
 * Trend / windows: one curve per trend window at an even Y band, carrying that
 * window's `TD_*` on Z and (when `withStd`) its `STD_*` band. A curve needs ≥ 2
 * finite samples. Without `withStd` the band is omitted, so the curve's Z range
 * (and thus the frame's Z domain) matches the points shape.
 */
function windowCurves(samples, cube, withStd) {
  const count = TREND_WINDOWS.length;
  const curves = [];
  TREND_WINDOWS.forEach((w, i) => {
    const y = bandY(i, count, cube);
    const rows = [];
    for (const s of samples) {
      const x = s.distance;
      const z = s[w.key];
      if (!isNum(x) || !isNum(z)) continue;
      const std = withStd && isNum(s[w.stdKey]) ? Math.abs(s[w.stdKey]) : null;
      rows.push({
        s,
        x,
        y,
        z,
        lo: std != null ? z - std : z,
        hi: std != null ? z + std : z,
        banded: std != null,
        windowKey: w.key,
        windowLabel: trendWindowLabel(w.days),
      });
    }
    rows.sort((a, b) => a.x - b.x);
    if (rows.length >= 2) {
      curves.push({
        key: w.key,
        label: trendWindowLabel(w.days),
        color: w.color,
        stdKey: withStd ? w.stdKey : null,
        rows,
      });
    }
  });
  return curves;
}

/**
 * Trend / points: one curve per point, stepping across the window bands in
 * ascending window order against that point's `TD_*` values. No ribbon. A curve
 * needs ≥ 2 finite windows; samples are grouped by `id` (one sample per feature
 * in practice, each carrying all its `TD_*` values).
 */
function pointCurves(samples, cube) {
  const count = TREND_WINDOWS.length;
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
    TREND_WINDOWS.forEach((w, i) => {
      const s = group.samples.find((sm) => isNum(sm[w.key]));
      if (!s) return;
      const z = s[w.key];
      rows.push({
        s,
        x: s.distance,
        y: bandY(i, count, cube),
        z,
        lo: z,
        hi: z,
        banded: false,
        windowKey: w.key,
        windowLabel: trendWindowLabel(w.days),
      });
    });
    if (rows.length >= 2) {
      const label = group.id == null ? `point ${index + 1}` : String(group.id);
      curves.push({ key: `point-${index}`, label, color: PROFILE_COLOR, stdKey: null, rows });
    }
    index += 1;
  }
  return curves;
}

/**
 * Build the render-ready profile frame (one or more curves).
 *
 * @param {{view?:'attributes'|'trend', basis?:'along'|'plan', yKey?:string,
 *   zKey?:string, trendLines?:'windows'|'windows-plain'|'points',
 *   samples?:Array<any>}} profile
 * @param {number} [cube] half-extent of the normalised cube
 * @returns {{
 *   view:'attributes'|'trend', shape:'windows'|'windows-plain'|'points'|null,
 *   basis:'along'|'plan', yKey:string|null, zKey:string|null,
 *   titles:{x:string,y:string,z:string},
 *   domains:{x:[number,number],y:[number,number],z:[number,number]},
 *   axisDomains:{x:[number,number],y:[number,number],z:[number,number]},
 *   colorDomain:[number,number]|null,
 *   yTicks:Array<{value:number,label:string}>|null,
 *   curves:Array<{ key:string, label:string, color:string, stdKey:string|null,
 *     colored:boolean,
 *     samples:Array<{
 *       id:any, position:[number,number,number],
 *       ribbon:{lo:[number,number,number],hi:[number,number,number]}|null,
 *       raw:{x:number,y:number,z:number,lo:number,hi:number},
 *       color:string|null,
 *       windowKey:string|null, windowLabel:string|null, sample:any }> }>,
 * }}
 */
export function buildProfileFrame(profile, cube = 1) {
  const view = profile?.view === 'trend' ? 'trend' : 'attributes';
  const samples = profile?.samples ?? [];
  const yKey = profile?.yKey ?? 'H';
  const zKey = profile?.zKey ?? 'VEL_REL';
  const trendLines = profile?.trendLines;
  const basis = profile?.basis === 'plan' ? 'plan' : 'along';
  const isPlan = view === 'attributes' && basis === 'plan';

  const rawCurves =
    view === 'trend'
      ? trendLines === 'points'
        ? pointCurves(samples, cube)
        : windowCurves(samples, cube, trendLines === 'windows')
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
    // the bands keep fixed, even spacing regardless of which windows are present.
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

  // The Trend ▸ points shape colours each point by its own displacement; every
  // other curve keeps its fixed colour. The colour domain is pinned to the map's
  // [-3, 3] (not the data range), so point colours stay comparable.
  const colorByDisplacement = view === 'trend' && trendLines === 'points';
  const [cLo, cHi] = DISPLACEMENT_DOMAIN;

  const curves = rawCurves.map((c) => ({
    key: c.key,
    label: c.label,
    color: c.color,
    stdKey: c.stdKey ?? null,
    colored: colorByDisplacement,
    samples: c.rows.map((r) => {
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
      return {
        id: r.s.id,
        position: [xn, yn, zn],
        ribbon,
        raw: { x: r.xRaw ?? r.x, y: r.yRaw ?? r.y, z: r.z, lo: r.lo, hi: r.hi },
        color: colorByDisplacement ? displacementColor(zt) : null,
        windowKey: r.windowKey ?? null,
        windowLabel: r.windowLabel ?? null,
        sample: r.s,
      };
    }),
  }));

  const titles =
    view === 'trend'
      ? { x: 'Distance along profile [m]', y: 'Trend window', z: 'Trend displacement [mm]' }
      : isPlan
        ? { x: 'Longitude [\u00b0]', y: 'Latitude [\u00b0]', z: axisTitle(zKey) }
        : { x: 'Distance along profile [m]', y: axisTitle(yKey), z: axisTitle(zKey) };

  // Trend Y is categorical: label each band position with its window, else the
  // numeric -1..1 band coordinate is meaningless.
  const yTicks =
    view === 'trend'
      ? TREND_WINDOWS.map((w, i) => ({
          value: bandY(i, TREND_WINDOWS.length, cube),
          label: trendWindowLabel(w.days),
        }))
      : null;

  return {
    view,
    shape: view === 'trend' ? (trendLines ?? 'windows') : null,
    basis,
    yKey: view === 'attributes' ? (isPlan ? 'lat' : yKey) : null,
    zKey: view === 'attributes' ? zKey : null,
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

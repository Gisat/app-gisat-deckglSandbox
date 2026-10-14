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
 * Attribute view: a single curve of `yKey` over distance with `zKey` up, plus a
 * `z ± std` band on Z when `zKey` declares a paired `stdKey`.
 */
function attributeCurves(yKey, zKey, samples) {
  const stdKey = ATTRIBUTES[zKey]?.stdKey ?? null;
  const rows = [];
  for (const s of samples) {
    const x = s.distance;
    const y = s[yKey];
    const z = s[zKey];
    if (!isNum(x) || !isNum(y) || !isNum(z)) continue;
    const std = stdKey && isNum(s[stdKey]) ? Math.abs(s[stdKey]) : 0;
    rows.push({
      s,
      x,
      y,
      z,
      lo: stdKey ? z - std : z,
      hi: stdKey ? z + std : z,
      banded: stdKey != null,
    });
  }
  rows.sort((a, b) => a.x - b.x);
  return [{ key: 'profile', label: 'Profile', color: PROFILE_COLOR, stdKey, rows }];
}

/**
 * Trend / windows: one curve per trend window at an even Y band, carrying that
 * window's `TD_*` on Z and its `STD_*` band when present. A curve needs ≥ 2
 * finite samples.
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
        stdKey: w.stdKey,
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
 * @param {{view?:'attributes'|'trend', yKey?:string, zKey?:string,
 *   trendLines?:'windows'|'points', samples?:Array<any>}} profile
 * @param {number} [cube] half-extent of the normalised cube
 * @returns {{
 *   view:'attributes'|'trend', yKey:string|null, zKey:string|null,
 *   titles:{x:string,y:string,z:string},
 *   domains:{x:[number,number],y:[number,number],z:[number,number]},
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

  const rawCurves =
    view === 'trend'
      ? profile?.trendLines === 'points'
        ? pointCurves(samples, cube)
        : windowCurves(samples, cube)
      : attributeCurves(yKey, zKey, samples);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (const c of rawCurves) {
    for (const r of c.rows) {
      if (r.x < xMin) xMin = r.x;
      if (r.x > xMax) xMax = r.x;
      if (r.y < yMin) yMin = r.y;
      if (r.y > yMax) yMax = r.y;
      // Z domain must cover the full band, else normalisation clamps the ribbon.
      if (r.lo < zMin) zMin = r.lo;
      if (r.hi > zMax) zMax = r.hi;
    }
  }

  const xd = resolveDomain(xMin, xMax);
  // Trend Y is an ordered categorical axis: pin the domain to the band range so
  // the bands keep fixed, even spacing regardless of which windows are present.
  const yd = view === 'trend' ? [-cube, cube] : resolveDomain(yMin, yMax);
  const zd = resolveDomain(zMin, zMax);

  // Trend points are coloured by their own displacement; every other curve
  // keeps its fixed colour. The colour domain is pinned to the map's [-3, 3]
  // (not the data range), so point colours stay comparable across selections.
  const colorByDisplacement = view === 'trend' && profile?.trendLines === 'points';
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
        raw: { x: r.x, y: r.y, z: r.z, lo: r.lo, hi: r.hi },
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
    yKey: view === 'attributes' ? yKey : null,
    zKey: view === 'attributes' ? zKey : null,
    titles,
    domains: { x: xd, y: yd, z: zd },
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

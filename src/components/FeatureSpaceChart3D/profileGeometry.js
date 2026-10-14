/**
 * Shared geometry for the 3D line-profile mode of the feature-space chart.
 *
 * Pure module (no React / three / deck.gl). Renderers hand it the `profile`
 * prop the chart builds from the app's `buildProfileSeries` output and get back
 * cube-normalised positions (for deck.gl/three.js) alongside the raw values
 * (for Plotly, which has real 3D axes and wants real units).
 *
 * Profile shape: `{ mode: 'along' | 'geo', activeSeriesKey, series: [{ key, label,
 * color, unit, samples: [{ id, distance, lon, lat, height, value, std }] }] }`.
 *
 * - `along`: X = distance along the drawn line (m), Y = series value, Z = elevation (H).
 * - `geo`:   X = lon, Y = lat, Z = elevation (H); a single series, no ribbon.
 */

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

/** Raw X for a sample under the active profile mode. */
function sampleX(sample, along) {
  return along ? sample.distance : sample.lon;
}

/** Raw Y for a sample under the active profile mode. */
function sampleY(sample, along) {
  return along ? sample.value : sample.lat;
}

function valueAxisTitle(series) {
  if (series.length === 1) {
    const s = series[0];
    return s.unit ? `${s.label} [${s.unit}]` : s.label;
  }
  const units = new Set(series.map((s) => s.unit).filter(Boolean));
  if (units.size === 1) return `Value [${[...units][0]}]`;
  return 'Value';
}

/**
 * Build the render-ready profile frame.
 *
 * @param {{mode?:string, series?:Array<any>}} profile
 * @param {number} [cube] half-extent of the normalised cube
 * @returns {{
 *   mode:'along'|'geo', along:boolean,
 *   titles:{x:string,y:string,z:string},
 *   domains:{x:[number,number],y:[number,number],z:[number,number]},
 *   series:Array<{key:string,label:string,color:string,unit:string,samples:Array<{
 *     id:any, position:[number,number,number],
 *     ribbon:{lo:[number,number,number],hi:[number,number,number]}|null,
 *     raw:{x:number,y:number,z:number,lo:number,hi:number},
 *     sample:any }>}>,
 * }}
 */
export function buildProfileFrame(profile, cube = 1) {
  const mode = profile?.mode === 'geo' ? 'geo' : 'along';
  const along = mode === 'along';
  const series = profile?.series ?? [];

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (const s of series) {
    for (const p of s.samples) {
      const x = sampleX(p, along);
      if (isNum(x)) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
      }
      if (isNum(p.height)) {
        if (p.height < zMin) zMin = p.height;
        if (p.height > zMax) zMax = p.height;
      }
      if (along) {
        if (isNum(p.value)) {
          const std = isNum(p.std) ? Math.abs(p.std) : 0;
          const lo = p.value - std;
          const hi = p.value + std;
          if (lo < yMin) yMin = lo;
          if (hi > yMax) yMax = hi;
        }
      } else if (isNum(p.lat)) {
        if (p.lat < yMin) yMin = p.lat;
        if (p.lat > yMax) yMax = p.lat;
      }
    }
  }

  const xd = resolveDomain(xMin, xMax);
  const yd = resolveDomain(yMin, yMax);
  const zd = resolveDomain(zMin, zMax);

  const frameSeries = series.map((s) => ({
    key: s.key,
    label: s.label,
    color: s.color,
    unit: s.unit || '',
    samples: s.samples.map((p) => {
      const x = sampleX(p, along);
      const y = sampleY(p, along);
      const z = p.height;
      const position = [
        isNum(x) ? normalize(x, xd, cube) : 0,
        isNum(y) ? normalize(y, yd, cube) : 0,
        isNum(z) ? normalize(z, zd, cube) : 0,
      ];
      const std = isNum(p.std) ? Math.abs(p.std) : 0;
      const raw = {
        x,
        y,
        z,
        lo: isNum(p.value) ? p.value - std : y,
        hi: isNum(p.value) ? p.value + std : y,
      };
      const ribbon = along && isNum(p.value)
        ? {
            lo: [position[0], normalize(p.value - std, yd, cube), position[2]],
            hi: [position[0], normalize(p.value + std, yd, cube), position[2]],
          }
        : null;
      return { id: p.id, position, ribbon, raw, sample: p };
    }),
  }));

  const titles = along
    ? { x: 'Distance along profile [m]', y: valueAxisTitle(series), z: 'Elevation [m]' }
    : { x: 'Longitude', y: 'Latitude', z: 'Elevation [m]' };

  return { mode, along, titles, domains: { x: xd, y: yd, z: zd }, series: frameSeries };
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

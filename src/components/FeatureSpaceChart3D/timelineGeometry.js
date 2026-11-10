/**
 * GeoJSON displacement timeline -> flat sample list.
 *
 * Pure module (no React / chart-library imports) so it can be lifted into
 * another repository unchanged. The Poláky InSAR features carry one property per
 * epoch named `d_YYYYMMDD` (displacement in mm, the first epoch is 0). The chart
 * reduces those dense epochs to a few smoothed trend steps per point.
 *
 * Sample contract: `{ id, pointKey, t, d, lon, lat, velAvg }` where `id` is the
 * raw point ID (string, or null when the feature has none), `pointKey` is the
 * stable grouping key (the ID, or a synthetic key for ID-less features), `t` is
 * the epoch in UTC milliseconds, `d` is the displacement, `lon`/`lat` come from
 * the geometry (falling back to `LON`/`LAT`) and `velAvg` is `VEL_AVG` when
 * finite. Only finite epochs are emitted.
 */

/** Anchored so unrelated numeric properties are never read as an epoch. */
const TIMELINE_KEY_RE = /^d_(\d{4})(\d{2})(\d{2})$/;

/**
 * `d_YYYYMMDD` -> UTC milliseconds at midnight (UTC, not local, so year ticks
 * never shift by a day).
 * @param {string} key
 * @returns {number} epoch ms, or NaN when the key is not an epoch
 */
export function epochKeyToUtc(key) {
  const m = TIMELINE_KEY_RE.exec(String(key));
  if (!m) return NaN;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  const t = Date.UTC(y, mo - 1, d);
  return Number.isFinite(t) ? t : NaN;
}

/** @param {unknown} v */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Collect the timeline samples across a FeatureCollection (or a feature array).
 *
 * @param {any} featureCollection
 * @returns {{ samples: Array<{ id: string|null, pointKey: string, t: number,
 *   d: number, lon: number|null, lat: number|null, velAvg: number|null }>,
 *   pointCount: number, epochCount: number }}
 *   `pointCount` counts distinct points with ≥1 finite sample; `epochCount`
 *   counts distinct epochs that produced ≥1 finite sample.
 */
export function extractTimelineSamples(featureCollection) {
  const features = Array.isArray(featureCollection)
    ? featureCollection
    : (featureCollection && featureCollection.features) || [];

  // Union of epoch keys across the selection, sorted chronologically.
  const epochKeys = new Set();
  for (const feature of features) {
    const props = (feature && feature.properties) || {};
    for (const key of Object.keys(props)) {
      if (TIMELINE_KEY_RE.test(key)) epochKeys.add(key);
    }
  }
  const epochs = [...epochKeys]
    .map((key) => ({ key, t: epochKeyToUtc(key) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const samples = [];
  const pointKeys = new Set();
  const usedEpochs = new Set();

  features.forEach((feature, index) => {
    const props = (feature && feature.properties) || {};
    const coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates)
      ? feature.geometry.coordinates
      : null;
    const lon = toNumber(coords?.[0]) ?? toNumber(props.LON);
    const lat = toNumber(coords?.[1]) ?? toNumber(props.LAT);
    const rawId = props.ID ?? props.point_id ?? (feature && feature.id) ?? null;
    const id = rawId == null ? null : String(rawId);
    const pointKey = id ?? `__point_${index}`;
    const velAvg = toNumber(props.VEL_AVG);

    for (const epoch of epochs) {
      const d = toNumber(props[epoch.key]);
      if (d == null) continue;
      samples.push({ id, pointKey, t: epoch.t, d, lon, lat, velAvg });
      pointKeys.add(pointKey);
      usedEpochs.add(epoch.key);
    }
  });

  return { samples, pointCount: pointKeys.size, epochCount: usedEpochs.size };
}

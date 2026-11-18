/**
 * Poláky/Hradec v3 — three-track rig data.
 *
 * Golden rule this module exists to enforce: **the rig is additive**. v2's point
 * cloud keeps loading one track at a time (point IDs are unique only within a
 * track, so three point layers at once would break selection); the rig store
 * loads all three tracks eagerly and indexes them by pylon join key. Nothing in
 * the store is fed back into the point-cloud state machine.
 *
 * Base elevation comes from the `_median` ground statistic that every linked
 * point carries (the pylon's own DEM median, which matches the displayed
 * terrain); `H_dem` and finally `0` are the fallbacks. There is no datum
 * constant and no COG sampling here.
 */

import { unionGrid } from './bandGeometry';
import {
  BAND_FRACTIONS,
  BAND_ASSIGN_FRACTIONS,
  BAND_COUNT,
  METRES_PER_DEG_LAT,
  metresPerDegLon,
  TRACKS,
} from './tracks';

/** Linked points farther than this from the pylon centroid are reported. */
export const JOIN_DISTANCE_WARN_M = 35;

// Pylon <-> InSAR join. The pylon GeoJSON spells the join property `index_righ`
// (no trailing "t"), while the points use `index_right`; support both.
export function getPylonJoinKey(feature) {
  const raw = feature?.properties?.index_right ?? feature?.properties?.index_righ;
  return raw == null || raw === '' ? null : String(raw);
}

export function getPointJoinKey(feature) {
  const raw = feature?.properties?.index_right;
  return raw == null || raw === '' ? null : String(raw);
}

// Pick callbacks receive a raw feature from the pylon mesh layers and a
// {feature, height, radius} wrapper from the invisible hit-volume layer, so
// unwrap before reading join keys or tooltip properties.
export function getPylonPickFeature(object) {
  return object?.feature ?? object ?? null;
}

/** Tower height in metres, or null. */
export function getPylonHeight(feature) {
  const height = Number(feature?.properties?.height);
  return Number.isFinite(height) && height > 0 ? height : null;
}

/**
 * Structural band index from a scatterer's height above ground: below
 * `BAND_ASSIGN_FRACTIONS[0]` of the tower height → base, below the second
 * threshold → mid, everything else (including conductors above the tower top)
 * → top.
 *
 * @param {number} hRef `H_REF` of the scatterer, metres.
 * @param {number} height Tower height, metres.
 * @returns {number} 0..BAND_COUNT-1
 */
export function bandIndexOf(hRef, height) {
  if (!Number.isFinite(height) || height <= 0) return BAND_COUNT - 1;
  const ratio = Number.isFinite(hRef) ? hRef / height : 1;
  for (let i = 0; i < BAND_ASSIGN_FRACTIONS.length; i++) {
    if (ratio < BAND_ASSIGN_FRACTIONS[i]) return i;
  }
  return BAND_COUNT - 1;
}

/** Median of a numeric list, or null. */
function medianOf(values) {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = finite.length >> 1;
  return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
}

/** East/north distance in metres between two lon/lat pairs at this latitude. */
function offsetMetres(lonA, latA, lonB, latB) {
  const dEast = (lonB - lonA) * metresPerDegLon((latA + latB) / 2);
  const dNorth = (latB - latA) * METRES_PER_DEG_LAT;
  return Math.hypot(dEast, dNorth);
}

/**
 * Builds the rig store from the already-loaded GeoJSON features.
 *
 * Pure: the caller owns fetching. `pylons` is keyed by join key and holds, per
 * pylon, the linked features of all three tracks, the band partition, the DTM
 * base elevation and the band heights in metres above that base.
 *
 * @param {{
 *   pylonFeatures: Array<any>,
 *   featuresByTrack: Record<string, Array<any>>,
 *   terrainElevations?: Map<string, number|null>,
 * }} input `terrainElevations` is the per-pylon COG sample (see
 *   `terrainElevation.js`). It is the rig's z anchor; `baseElevation` below is
 *   the DTM median and is kept for reporting only, because the two datums differ
 *   by ~45 m at this site.
 * @returns {{
 *   pylons: Map<string, any>,
 *   grid: number[],
 *   trackDates: Record<string, number[]>,
 *   incidence: Record<string, number|null>,
 *   commonEpochMs: number|null,
 *   warnings: string[],
 * }}
 */
export function buildRigStore({
  pylonFeatures = [],
  featuresByTrack = {},
  terrainElevations = null,
}) {
  const warnings = [];

  const pointsByKey = new Map();
  for (const track of TRACKS) {
    const keyed = new Map();
    for (const feature of featuresByTrack[track.id] ?? []) {
      const key = getPointJoinKey(feature);
      if (!key) continue;
      if (!keyed.has(key)) keyed.set(key, []);
      keyed.get(key).push(feature);
    }
    pointsByKey.set(track.id, keyed);
  }

  const incidence = {};
  for (const track of TRACKS) {
    const angles = [];
    for (const feature of featuresByTrack[track.id] ?? []) {
      const angle = Number(feature?.properties?.INC_ANG);
      if (Number.isFinite(angle)) angles.push(angle);
    }
    const median = medianOf(angles);
    incidence[track.id] = median;
    if (median == null) warnings.push(`${track.id}: no INC_ANG values`);
  }

  // One vertex per acquisition of any track: the union grid is the ring time axis.
  const { grid, byTrack: trackDates } = unionGrid(featuresByTrack);

  // All three tracks report the same end of record only approximately (95D stops
  // 2026-02-17, 44A 2026-03-03, 146A 2026-03-04). Decomposition is evaluated at
  // the earliest of the track end dates so no series is extrapolated.
  const trackLast = TRACKS
    .map(track => trackDates[track.id]?.at(-1) ?? null)
    .filter(Number.isFinite);
  const commonEpochMs = trackLast.length ? Math.min(...trackLast) : null;

  const pylons = new Map();
  let dropped = 0;

  for (const pylonFeature of pylonFeatures) {
    const key = getPylonJoinKey(pylonFeature);
    if (key == null) {
      dropped += 1;
      continue;
    }
    const coordinates = pylonFeature?.geometry?.coordinates;
    const lon = Number(coordinates?.[0]);
    const lat = Number(coordinates?.[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      dropped += 1;
      continue;
    }

    const height = getPylonHeight(pylonFeature) ?? 0;
    const byTrack = {};
    const bands = {};
    const counts = {};
    const allLinked = [];

    for (const track of TRACKS) {
      const linked = pointsByKey.get(track.id)?.get(key) ?? [];
      byTrack[track.id] = linked;
      const bandLists = Array.from({ length: BAND_COUNT }, () => []);
      for (const feature of linked) {
        const band = bandIndexOf(Number(feature?.properties?.H_REF), height);
        bandLists[band].push(feature);
        const props = feature?.properties ?? {};
        const distance = offsetMetres(lon, lat, Number(props.LON), Number(props.LAT));
        if (Number.isFinite(distance) && distance > JOIN_DISTANCE_WARN_M) {
          warnings.push(
            `pylon ${pylonFeature?.properties?.id ?? key} / ${track.id}: `
            + `point ${props.ID ?? '?'} is ${distance.toFixed(1)} m from the tower`,
          );
        }
      }
      bands[track.id] = bandLists;
      counts[track.id] = bandLists.map(list => list.length);
      allLinked.push(...linked);
    }

    // Decision 4: the pylon's own DEM median, then the median of the linked
    // points' H_dem, then 0. No datum constant: `_median` already describes the
    // surface the point symbols and tower meshes are drawn on.
    const medians = allLinked
      .map(feature => Number(feature?.properties?._median))
      .filter(Number.isFinite);
    const hDems = allLinked
      .map(feature => Number(feature?.properties?.H_dem))
      .filter(Number.isFinite);
    const baseElevation = medianOf(medians) ?? medianOf(hDems) ?? 0;
    const terrainElevation = terrainElevations?.get(key) ?? null;

    pylons.set(key, {
      key,
      id: pylonFeature?.properties?.id ?? null,
      typ: pylonFeature?.properties?.typ ?? null,
      height,
      lon,
      lat,
      /** DTM median of the linked points (reported, not used for z). */
      baseElevation,
      /** Draped COG ground elevation — the rig's absolute z anchor. */
      terrainElevation,
      /** Band centre heights above the terrain anchor, metres. */
      bandZ: BAND_FRACTIONS.map(fraction => fraction * height),
      byTrack,
      bands,
      /** `nByBandTrack[trackId][bandIndex]`, the LSQ weights. */
      nByBandTrack: counts,
      counts,
    });
  }

  if (dropped) warnings.push(`${dropped} pylon feature(s) dropped: no join key or coordinates`);

  if (terrainElevations === null) {
    warnings.push('terrain not sampled: the rig cannot be anchored');
  } else {
    const missing = [...pylons.values()].filter(p => !Number.isFinite(p.terrainElevation));
    if (missing.length) {
      warnings.push(`${missing.length} pylon(s) without a terrain sample: ${missing.map(p => p.id).join(', ')}`);
    }
  }

  return { pylons, grid, trackDates, incidence, commonEpochMs, warnings };
}

/**
 * Eagerly loads all three tracks, one abortable request each.
 *
 * @param {AbortSignal} [signal]
 * @returns {Promise<Record<string, Array<any>>>}
 */
export async function loadRigTracks(signal) {
  const entries = await Promise.all(TRACKS.map(async (track) => {
    const response = await fetch(track.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${track.url}`);
    const data = await response.json();
    const features = Array.isArray(data) ? data : (data.features || []);
    return [track.id, features];
  }));
  return Object.fromEntries(entries);
}


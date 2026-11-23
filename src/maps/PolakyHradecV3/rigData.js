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

import { median, unionGrid } from './bandGeometry';
import {
  BAND_ASSIGN_FRACTIONS,
  METRES_PER_DEG_LAT,
  PYLON_NATIVE_HEIGHTS,
  getSectionLayout,
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

/** Native OBJ height for a pylon type, or null for unknown / inherited keys. */
export function getPylonNativeHeight(typ) {
  return Object.hasOwn(PYLON_NATIVE_HEIGHTS, typ) ? PYLON_NATIVE_HEIGHTS[typ] : null;
}

/**
 * Mean height per pylon type over the features that carry a valid height.
 *
 * Shared by the rig store and the map's mesh/hit-volume sizing, so the two
 * height fallbacks cannot drift apart. Types without any valid height are
 * absent from the result.
 *
 * @param {Array<any>} [pylonFeatures]
 * @returns {Record<string, number>}
 */
export function meanHeightByTyp(pylonFeatures = []) {
  const sums = new Map();
  const counts = new Map();
  for (const feature of pylonFeatures) {
    const typ = feature?.properties?.typ;
    const height = getPylonHeight(feature);
    if (!typ || height == null) continue;
    sums.set(typ, (sums.get(typ) ?? 0) + height);
    counts.set(typ, (counts.get(typ) ?? 0) + 1);
  }
  // Null prototype: `typ` is external data, so a key like `constructor` must
  // read as "no mean", not as an inherited Object member.
  const means = Object.create(null);
  for (const [typ, count] of counts) {
    means[typ] = sums.get(typ) / count;
  }
  return means;
}

/**
 * Structural section index from a scatterer's height above ground: below the
 * first threshold → section 0, below the second → section 1, everything else
 * (including conductors above the tower top) → the last section. The thresholds
 * come from the tower type's layout (`getSectionLayout`); the default is the
 * dunaj pair.
 *
 * @param {number} hRef `H_REF` of the scatterer, metres.
 * @param {number} height Tower height, metres.
 * @param {number[]} [assignFractions] Per-layout thresholds, ascending.
 * @returns {number} 0..`assignFractions.length`
 */
export function bandIndexOf(hRef, height, assignFractions = BAND_ASSIGN_FRACTIONS) {
  const sectionCount = Math.max(1, assignFractions.length + 1);
  if (!Number.isFinite(height) || height <= 0) return sectionCount - 1;
  const ratio = Number.isFinite(hRef) ? hRef / height : 1;
  for (let i = 0; i < assignFractions.length; i++) {
    if (ratio < assignFractions[i]) return i;
  }
  return sectionCount - 1;
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
 * pylon, the linked features of all three tracks, the per-type section partition
 * and layout, the DTM base elevation and the section heights in metres above
 * that base.
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
    const incidenceMedian = median(angles);
    incidence[track.id] = incidenceMedian;
    if (incidenceMedian == null) warnings.push(`${track.id}: no INC_ANG values`);
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

  // Per-type mean height of the features that carry one, used as the second
  // fallback when a tower's own `height` is missing.
  const meanHeights = meanHeightByTyp(pylonFeatures);

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

    const typ = pylonFeature?.properties?.typ ?? null;
    const layout = getSectionLayout(typ);
    const sectionCount = layout.labels.length;
    const height =
      getPylonHeight(pylonFeature)
      ?? meanHeights[typ]
      ?? getPylonNativeHeight(typ)
      ?? null;

    if (height == null) {
      dropped += 1;
      warnings.push(`pylon ${pylonFeature?.properties?.id ?? key}: no resolvable height, rig skipped`);
      continue;
    }
    const byTrack = {};
    const bands = {};
    const counts = {};
    const allLinked = [];

    for (const track of TRACKS) {
      const linked = pointsByKey.get(track.id)?.get(key) ?? [];
      byTrack[track.id] = linked;
      const bandLists = Array.from({ length: sectionCount }, () => []);
      for (const feature of linked) {
        const rawHRef = feature?.properties?.H_REF;
        const band = bandIndexOf(
          rawHRef == null || rawHRef === '' ? NaN : Number(rawHRef),
          height,
          layout.assignFractions,
        );
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
    const baseElevation = median(medians) ?? median(hDems) ?? 0;
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
      /** Per-type section names, lowercase (`base` / `mid` / …). */
      sectionLabels: layout.labels,
      /** Per-type vertical slots for the ring stacks, fractions of height. */
      sectionSlots: layout.zSlots,
      /** Section centre heights above the terrain anchor, metres. */
      bandZ: layout.bandFractions.map(fraction => fraction * height),
      byTrack,
      bands,
      /** `nByBandTrack[trackId][bandIndex]`, the LSQ weights. */
      nByBandTrack: counts,
      counts,
    });
  }

  if (dropped) warnings.push(`${dropped} pylon feature(s) dropped: no join key, coordinates, or valid height`);

  // `null` means the COG sample is still in flight; only report an attempted
  // sample that came back incomplete.
  if (terrainElevations) {
    const missing = [...pylons.values()].filter(p => !Number.isFinite(p.terrainElevation));
    if (missing.length) {
      warnings.push(`${missing.length} pylon(s) without a terrain sample: ${missing.map(p => p.id).join(', ')}`);
    }
  }

  return { pylons, grid, trackDates, incidence, commonEpochMs, warnings };
}

/**
 * Eagerly loads all three tracks. The caller may pass a shared loader so the
 * point cloud and the rig reuse one request/parse per track.
 *
 * @param {AbortSignal} [signal]
 * @param {(trackId: string) => Promise<Array<any>>} [loadFeatures]
 * @returns {Promise<Record<string, Array<any>>>}
 */
export async function loadRigTracks(signal, loadFeatures = null) {
  const entries = await Promise.all(TRACKS.map(async (track) => {
    if (loadFeatures) return [track.id, await loadFeatures(track.id)];
    const response = await fetch(track.url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${track.url}`);
    const data = await response.json();
    const features = Array.isArray(data) ? data : (data.features || []);
    return [track.id, features];
  }));
  return Object.fromEntries(entries);
}


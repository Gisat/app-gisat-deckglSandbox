/**
 * Poláky/Hradec v3 — `?debugRig=1` acceptance block.
 *
 * Prints the numeric gates for pylon 10 (the default focus) and a no-NaN sweep
 * over the shortest and tallest towers. Enabled only by the query parameter; the
 * other routes ignore it entirely.
 *
 * Each check logs as `console.info('[rig] PASS/FAIL ...')` so a failing gate is
 * visible without opening the console details.
 */

import {
  bandMedianAt,
  buildHaloRingFrame,
  buildHaloRingGeometry,
  coneAxis,
  coneOrientation,
  haloBandSeries,
} from './bandGeometry';
import { SOLVER_TRACK_IDS, losRow, solveBand, towardDeg } from './decomposition';
import {
  BAND_FRACTIONS,
  BAND_LABELS,
  HALO_ARC_DEG,
  HALO_EAST_START_DEG,
  HALO_INNER_RADIUS_M,
  HALO_OUTER_RADIUS_M,
  HALO_RADIAL_SCALE_M_PER_MM,
  HALO_SAMPLE_COUNT,
  HALO_SEGMENTS,
  HALO_WEST_START_DEG,
  HALO_ZERO_RADIUS_M,
  METRES_PER_DEG_LAT,
  TRACK_HALO_SIDE,
  TRACK_IDS,
  metresPerDegLon,
} from './tracks';

export const DEBUG_PYLON_ID = 10;
export const SPOT_PYLON_IDS = [1, 18];

const DEG = 180 / Math.PI;
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '—');
const fmtDate = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—');

function conditionOf(matrix) {
  if (matrix.length < 2) return NaN;
  let a = 0;
  let b = 0;
  let c = 0;
  for (const row of matrix) {
    a += row[0] * row[0];
    b += row[0] * row[1];
    c += row[1] * row[1];
  }
  const mean = (a + c) / 2;
  const spread = Math.sqrt(((a - c) / 2) ** 2 + b ** 2);
  const min = mean - spread;
  return min > 0 ? Math.sqrt((mean + spread) / min) : Number.POSITIVE_INFINITY;
}

function findPylonById(store, id) {
  for (const pylon of store.pylons.values()) {
    if (Number(pylon.id) === id) return pylon;
  }
  return null;
}

/** East/north offset in metres from a pylon to a ring vertex. */
function offsetFrom(pylon, point, mPerDegLon) {
  return {
    east: (point[0] - pylon.lon) * mPerDegLon,
    north: (point[1] - pylon.lat) * METRES_PER_DEG_LAT,
  };
}

/** Compass azimuth of a ring vertex, degrees clockwise from north. */
function azimuthOf(pylon, point, mPerDegLon) {
  const { east, north } = offsetFrom(pylon, point, mPerDegLon);
  return ((Math.atan2(east, north) * DEG) + 360) % 360;
}

/** Radius of a ring vertex, metres. */
function radiusOf(pylon, point, mPerDegLon) {
  const { east, north } = offsetFrom(pylon, point, mPerDegLon);
  return Math.hypot(east, north);
}

const clampRadius = (value) => Math.min(
  HALO_OUTER_RADIUS_M,
  Math.max(HALO_INNER_RADIUS_M, HALO_ZERO_RADIUS_M + value * HALO_RADIAL_SCALE_M_PER_MM),
);

/**
 * Runs the debug block.
 *
 * @param {{ store: any, windowDays: number }} input
 * @returns {number} Number of failed checks.
 */
export function logRigDebug({ store, windowDays }) {
  const log = (message) => console.info(`[rig] ${message}`);
  let failures = 0;
  const must = (name, ok, detail) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  log(`window ${windowDays} d · union grid ${store.grid.length} epochs`);
  log(`common decomposition epoch ${fmtDate(store.commonEpochMs)}`);

  const pylon = findPylonById(store, DEBUG_PYLON_ID);
  if (!pylon) {
    log(`FAIL pylon ${DEBUG_PYLON_ID} is not in the rig store`);
    return failures + 1;
  }

  const mPerDegLon = metresPerDegLon(pylon.lat);

  // ---- Frame ---------------------------------------------------------------
  log(`pylon ${pylon.id} (${pylon.typ ?? '?'}) at ${fmt(pylon.lon, 5)}, ${fmt(pylon.lat, 5)}`);
  log(`  terrainElevation ${fmt(pylon.terrainElevation)} m (COG, the z anchor)`);
  log(`  baseElevation ${fmt(pylon.baseElevation)} m (DTM _median, reported only)`);
  log(`  _median - COG offset ${fmt(pylon.baseElevation - pylon.terrainElevation)} m`);
  log(`  height ${fmt(pylon.height, 1)} m · bandZ ${pylon.bandZ.map((z) => fmt(z)).join(' / ')} m`);
  for (const trackId of TRACK_IDS) {
    log(`  ${trackId} band counts ${pylon.nByBandTrack[trackId].join(' / ')}`);
  }
  must(
    'terrain elevation sampled for pylon 10',
    Number.isFinite(pylon.terrainElevation) && pylon.terrainElevation > 0,
    `${fmt(pylon.terrainElevation)} m`,
  );
  must(
    'bandZ equals the band fractions of the tower height',
    pylon.bandZ.every((z, i) => Math.abs(z - BAND_FRACTIONS[i] * pylon.height) < 1e-6),
    pylon.bandZ.map((z) => fmt(z, 2)).join(' / '),
  );
  must(
    'band heights increase',
    pylon.bandZ.every((z, i) => i === 0 || z > pylon.bandZ[i - 1]),
    pylon.bandZ.map((z) => fmt(z, 1)).join(' < '),
  );
  must(
    'every pylon has three bands',
    store.pylons.size === 18
      && [...store.pylons.values()].every((p) => p.bandZ.length === BAND_LABELS.length),
    `${store.pylons.size} pylons`,
  );

  // ---- Ring frames ---------------------------------------------------------
  const base = pylon.terrainElevation;
  const halfSegments = Math.max(2, Math.round(HALO_SEGMENTS / 2));
  const discVertices = 2 * (halfSegments + 1);

  for (let band = 0; band < pylon.bandZ.length; band++) {
    const frame = buildHaloRingFrame({
      pylon,
      base,
      bandZ: pylon.bandZ[band],
      segments: HALO_SEGMENTS,
    });
    const radii = frame.discs.flatMap((disc) => disc.polygon.map((p) => radiusOf(pylon, p, mPerDegLon)));
    const zeroRadii = frame.zeroCircle.map((p) => radiusOf(pylon, p, mPerDegLon));
    const dividerAzimuths = frame.divider.map((p) => azimuthOf(pylon, p, mPerDegLon));
    const dividerRadii = frame.divider.map((p) => radiusOf(pylon, p, mPerDegLon));

    log(
      `  ring ${BAND_LABELS[band]}: discs=${frame.discs.length} `
      + `vertices=${frame.discs.map((d) => d.polygon.length).join('+')} `
      + `radii ${fmt(Math.min(...radii))}–${fmt(Math.max(...radii))} m`,
    );

    must(`${BAND_LABELS[band]} has a west and an east disc`, frame.discs.length === 2);
    must(
      `${BAND_LABELS[band]} discs use ${discVertices} vertices`,
      frame.discs.every((disc) => disc.polygon.length === discVertices),
      `${discVertices}`,
    );
    must(
      `${BAND_LABELS[band]} disc radii stay on the inner/outer bounds`,
      radii.every((r) => r >= HALO_INNER_RADIUS_M - 1e-6 && r <= HALO_OUTER_RADIUS_M + 1e-6),
    );
    must(
      `${BAND_LABELS[band]} 0 mm circle is ${HALO_ZERO_RADIUS_M} m`,
      zeroRadii.every((r) => Math.abs(r - HALO_ZERO_RADIUS_M) < 1e-6),
      `${fmt(Math.min(...zeroRadii))}–${fmt(Math.max(...zeroRadii))} m`,
    );
    must(
      `${BAND_LABELS[band]} divider runs north to south`,
      Math.abs(dividerAzimuths[0]) < 1e-6
        && Math.abs(dividerAzimuths[1] - 180) < 1e-6
        && dividerRadii.every((r) => Math.abs(r - HALO_OUTER_RADIUS_M) < 1e-6),
      `${fmt(dividerAzimuths[0], 3)}° / ${fmt(dividerAzimuths[1], 3)}°`,
    );

    // ---- Polar curves ------------------------------------------------------
    for (const trackId of TRACK_IDS) {
      const scatterers = pylon.bands[trackId][band];
      if (scatterers.length === 0) {
        log(`  ${trackId}/${BAND_LABELS[band]} ring: no scatterers, not drawn`);
        continue;
      }

      const prepared = haloBandSeries(scatterers, store.grid, windowDays, HALO_SAMPLE_COUNT);
      if (prepared.median.length < 2) {
        must(`${trackId}/${BAND_LABELS[band]} has a resampled median`, false);
        continue;
      }

      const side = TRACK_HALO_SIDE[trackId];
      const geometry = buildHaloRingGeometry({
        pylon,
        base,
        bandZ: pylon.bandZ[band],
        bandIndex: band,
        trackId,
        side,
        series: prepared.median,
        scatterers: prepared.scatterers,
        times: prepared.times,
      });

      const vertices = geometry.curve.flat();
      const azimuths = vertices.map((p) => azimuthOf(pylon, p, mPerDegLon));
      const radiiCurve = vertices.map((p) => radiusOf(pylon, p, mPerDegLon));

      const startDeg = side === 'west' ? HALO_WEST_START_DEG : HALO_EAST_START_DEG;
      const endDeg = side === 'west'
        ? HALO_WEST_START_DEG - HALO_ARC_DEG
        : HALO_EAST_START_DEG + HALO_ARC_DEG;
      const minAzimuth = Math.min(startDeg, endDeg) - 1e-6;
      const maxAzimuth = Math.max(startDeg, endDeg) + 1e-6;
      const inArc = azimuths.every((a) => a >= minAzimuth && a <= maxAzimuth);

      // Radii must reproduce clamp(18 + v × 0.8) vertex by vertex.
      let cursor = 0;
      let radiusMatch = true;
      for (let i = 0; i < prepared.median.length; i++) {
        const value = prepared.median[i];
        if (!Number.isFinite(value)) continue;
        if (Math.abs(radiiCurve[cursor] - clampRadius(value)) > 1e-6) radiusMatch = false;
        cursor += 1;
      }

      const firstVertex = vertices[0];
      const firstAzimuth = firstVertex ? azimuthOf(pylon, firstVertex, mPerDegLon) : NaN;

      log(
        `  ${trackId}/${BAND_LABELS[band]} ring: n=${scatterers.length} `
        + `vertices=${vertices.length} runs=${geometry.curve.length} `
        + `scatterer curves=${geometry.scatterers.reduce((sum, runs) => sum + runs.length, 0)} `
        + `azimuth ${fmt(Math.min(...azimuths), 1)}…${fmt(Math.max(...azimuths), 1)}° `
        + `radius ${fmt(Math.min(...radiiCurve))}…${fmt(Math.max(...radiiCurve))} m`,
      );

      must(
        `${trackId}/${BAND_LABELS[band]} curve stays inside ${fmt(minAzimuth, 0)}–${fmt(maxAzimuth, 0)}°`,
        inArc,
      );
      must(
        `${trackId}/${BAND_LABELS[band]} radius = clamp(18 + v × 0.8)`,
        radiusMatch,
      );
      must(
        `${trackId}/${BAND_LABELS[band]} radii stay on the ring bounds`,
        radiiCurve.every((r) => r >= HALO_INNER_RADIUS_M - 1e-6 && r <= HALO_OUTER_RADIUS_M + 1e-6),
      );
      // A track whose record starts after the union grid begins is clipped at the
      // first resampled step, so assert its first vertex sits at or past the arc
      // start rather than exactly on it.
      const startsOnOrAfterArc = side === 'west'
        ? firstAzimuth <= startDeg + 1e-3
        : firstAzimuth >= startDeg - 1e-3;
      must(
        `${trackId}/${BAND_LABELS[band]} starts at or past ${fmt(startDeg, 0)}°`,
        !Number.isFinite(firstAzimuth) || startsOnOrAfterArc,
        `${fmt(firstAzimuth, 3)}°`,
      );
      must(
        `${trackId}/${BAND_LABELS[band]} has terminal nodes`,
        geometry.anchors.length >= geometry.curve.length,
        `${geometry.anchors.length}`,
      );
    }
  }

  // ---- Decomposition -------------------------------------------------------
  const incidence = {};
  for (const trackId of SOLVER_TRACK_IDS) incidence[trackId] = store.incidence[trackId] ?? NaN;

  log(`  incidence ${SOLVER_TRACK_IDS.map((id) => `${id}:${fmt(incidence[id])}`).join(' ')}`);
  log(`  toward ${SOLVER_TRACK_IDS.map((id) => `${id}:${fmt(towardDeg(id), 0)}`).join(' ')}`);

  const matrix = SOLVER_TRACK_IDS.map((id) => losRow(incidence[id], towardDeg(id)));
  log(`  rows [dE, dU] ${matrix.map((r) => `[${fmt(r[0], 4)}, ${fmt(r[1], 4)}]`).join(' ')}`);
  log(`  condition ${fmt(conditionOf(matrix))}`);

  for (let band = 0; band < pylon.bandZ.length; band++) {
    const fields = {};
    const weights = {};
    for (const trackId of SOLVER_TRACK_IDS) {
      fields[trackId] = bandMedianAt(pylon.bands[trackId][band], store.commonEpochMs, windowDays);
      weights[trackId] = pylon.nByBandTrack[trackId][band];
    }
    const solution = solveBand({
      d95: fields['95D'],
      d44: fields['44A'],
      d146: fields['146A'],
      inc: incidence,
      weights,
    });
    log(
      `  band ${BAND_LABELS[band]}: d95=${fmt(fields['95D'])} d44=${fmt(fields['44A'])} `
      + `d146=${fmt(fields['146A'])} → ΔE=${fmt(solution.dE)} ΔU=${fmt(solution.dU)} `
      + `fit=${fmt(solution.residualMm)} mm cond=${fmt(solution.condition)} `
      + `used=${solution.used.join(',') || '—'} ${solution.lowConfidence ? 'LOW' : 'OK'}`,
    );
  }

  const weights = { '95D': 9, '44A': 9, '146A': 9 };
  const east = solveBand({
    d95: matrix[0][0], d44: matrix[1][0], d146: matrix[2][0], inc: incidence, weights,
  });
  const down = solveBand({
    d95: -matrix[0][1], d44: -matrix[1][1], d146: -matrix[2][1], inc: incidence, weights,
  });
  must('synthetic ΔE=+1, ΔU=0 solved back',
    Math.abs(east.dE - 1) < 1e-9 && Math.abs(east.dU) < 1e-9,
    `ΔE=${east.dE}, ΔU=${east.dU}`);
  must('synthetic ΔE=0, ΔU=−1 solved back',
    Math.abs(down.dE) < 1e-9 && Math.abs(down.dU + 1) < 1e-9,
    `ΔE=${down.dE}, ΔU=${down.dU}`);
  must('east motion is + on 95D and − on both ascending rows',
    matrix[0][0] > 0 && matrix[1][0] < 0 && matrix[2][0] < 0,
    matrix.map((r) => fmt(r[0], 3)).join(' / '));

  // ---- Arrow heads ---------------------------------------------------------
  // deck.gl maps a mesh's local +Z to (cos yaw·sin pitch, sin yaw·sin pitch,
  // cos pitch); these assertions prove the emitted orientation reproduces
  // (east, 0, up). A ±90° yaw would put the axis on ±Y (north/south).
  for (const [eastM, upM] of [[4, -1], [-4, -1], [0, -4], [3, 3]]) {
    const axis = coneAxis(coneOrientation(eastM, upM));
    const length = Math.hypot(eastM, upM);
    const target = [eastM / length, 0, upM / length];
    must(
      `cone axis matches shaft for (E ${eastM}, U ${upM})`,
      axis.every((value, i) => Math.abs(value - target[i]) < 1e-9),
      `[${axis.map((v) => fmt(v, 3)).join(', ')}]`,
    );
  }

  // ---- Height sweep --------------------------------------------------------
  for (const id of SPOT_PYLON_IDS) {
    const spot = findPylonById(store, id);
    if (!spot) {
      must(`pylon ${id} present`, false);
      continue;
    }
    const values = [];
    for (let band = 0; band < spot.bandZ.length; band++) {
      for (const trackId of TRACK_IDS) {
        values.push(bandMedianAt(spot.bands[trackId][band], store.commonEpochMs, windowDays));
      }
    }
    must(
      `pylon ${id} (${spot.typ ?? '?'}, ${fmt(spot.height, 1)} m) has no NaN`,
      values.every((v) => v === null || Number.isFinite(v)),
      `bandZ ${spot.bandZ.map((z) => fmt(z, 1)).join(' / ')}`,
    );
  }

  log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
  return failures;
}

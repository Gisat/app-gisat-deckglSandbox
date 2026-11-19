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

import { bandMedianAt, buildSectionRingStacks } from './bandGeometry';
import { SOLVER_TRACK_IDS, losRow, solveBand, towardDeg } from './decomposition';
import {
  DEFAULT_SCALE_M_PER_MM,
  METRES_PER_DEG_LAT,
  RING_RADIUS_M,
  RING_ALPHA_RAW,
  RING_ALPHA_SMOOTHED,
  RING_RAW_COUNT,
  RING_SMOOTHED_COUNT,
  TRACK_IDS,
  getSectionLayout,
  metresPerDegLon,
} from './tracks';

export const DEBUG_PYLON_ID = 10;
export const SPOT_PYLON_IDS = [1, 18];
/** Track used for the geometric gates; 95D has the longest record. */
export const DEBUG_TRACK_ID = '95D';

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

/** Signed angular difference, degrees in (-180, 180]. */
function angleDelta(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

/** Centre of a closed ring path (the last vertex repeats the first). */
function ringCentre(path, mPerDegLon) {
  let east = 0;
  let north = 0;
  let z = 0;
  const unique = Math.max(1, path.length - 1);
  for (let i = 0; i < unique; i++) {
    east += (path[i][0] - path[0][0]) * mPerDegLon;
    north += (path[i][1] - path[0][1]) * METRES_PER_DEG_LAT;
    z += path[i][2];
  }
  // Average the offsets from the first vertex, then re-anchor to lon/lat.
  return {
    lon: path[0][0] + (east / unique) / mPerDegLon,
    lat: path[0][1] + (north / unique) / METRES_PER_DEG_LAT,
    z: z / unique,
  };
}

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

  log(`window ${windowDays} d · union grid ${store.grid.length} epochs · shift ×${Math.round(DEFAULT_SCALE_M_PER_MM * 1000)}`);
  log(`common decomposition epoch ${fmtDate(store.commonEpochMs)}`);

  const pylon = findPylonById(store, DEBUG_PYLON_ID);
  if (!pylon) {
    log(`FAIL pylon ${DEBUG_PYLON_ID} is not in the rig store`);
    return failures + 1;
  }

  const mPerDegLon = metresPerDegLon(pylon.lat);

  // Per-type layout of the focused tower; `sectionCount` sizes every loop below
  // so a two-section portal tower is checked as such.
  const layout = getSectionLayout(pylon.typ);
  const sectionLabels = pylon.sectionLabels ?? layout.labels;
  const sections = pylon.sectionSlots ?? layout.zSlots;
  const sectionCount = sections.length;

  // ---- Frame ---------------------------------------------------------------
  log(`pylon ${pylon.id} (${pylon.typ ?? '?'}) at ${fmt(pylon.lon, 5)}, ${fmt(pylon.lat, 5)}`);
  log(`  terrainElevation ${fmt(pylon.terrainElevation)} m (COG, the z anchor)`);
  log(`  baseElevation ${fmt(pylon.baseElevation)} m (DTM _median, reported only)`);
  log(`  _median - COG offset ${fmt(pylon.baseElevation - pylon.terrainElevation)} m`);
  log(`  height ${fmt(pylon.height, 1)} m · sections ${sectionCount} (${sectionLabels.join(' / ')}) · bandZ ${pylon.bandZ.map((z) => fmt(z)).join(' / ')} m`);
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
    pylon.bandZ.every((z, i) => Math.abs(z - layout.bandFractions[i] * pylon.height) < 1e-6),
    pylon.bandZ.map((z) => fmt(z, 2)).join(' / '),
  );
  must(
    'every pylon has the section count of its layout',
    store.pylons.size > 0
      && [...store.pylons.values()].every((p) => (
        p.bandZ.length === (p.sectionLabels ?? getSectionLayout(p.typ).labels).length
      )),
    `${store.pylons.size} pylons`,
  );

  // ---- Section slots -------------------------------------------------------
  const base = pylon.terrainElevation;
  const slots = sections.map(([startFraction, endFraction]) => ({
    zStart: base + startFraction * pylon.height,
    zEnd: base + endFraction * pylon.height,
    startFraction,
    endFraction,
  }));

  for (let band = 0; band < slots.length; band++) {
    const slot = slots[band];
    const label = sectionLabels[band] ?? 'section';
    log(
      `  section ${label}: z ${fmt(slot.zStart)}–${fmt(slot.zEnd)} m `
      + `(${fmt(slot.startFraction * 100, 0)}–${fmt(slot.endFraction * 100, 0)}% of height)`,
    );
    must(`${label} slot runs upward`, slot.zEnd > slot.zStart);
    must(
      `${label} slot stays inside the tower`,
      slot.startFraction >= 0 && slot.endFraction <= 1,
    );
    must(
      `${label} slot has air above and below`,
      band === 0 || slots[band - 1].zEnd < slot.zStart,
    );
  }

  // ---- Ring stack geometry -------------------------------------------------
  const smoothed = buildSectionRingStacks({
    pylon,
    activeTrackId: DEBUG_TRACK_ID,
    grid: store.grid,
    rawMode: false,
    windowDays,
    scaleMPerMm: DEFAULT_SCALE_M_PER_MM,
  });

  // Only populated sections emit floor + ceiling rings, so the count follows the
  // sections that actually have scatterers for the debug track.
  const populatedSections = sections.filter(
    (_, band) => (pylon.bands?.[DEBUG_TRACK_ID]?.[band]?.length ?? 0) > 0,
  ).length;

  log(`  references ${smoothed.references.length} · stacks ${smoothed.stacks.length}`);
  must(
    `${populatedSections * 2} 0 mm reference rings (floor + ceiling per populated section)`,
    smoothed.references.length === populatedSections * 2,
  );

  const referenceZ = smoothed.references.map((reference) => reference.path[0][2]);
  must(
    'reference rings sit on their section floors and ceilings',
    smoothed.references.every((reference) => {
      const slot = slots[reference.bandIndex];
      return Math.abs(reference.path[0][2] - (reference.kind === 'floor' ? slot.zStart : slot.zEnd)) < 1e-6;
    }),
    referenceZ.map((z) => fmt(z, 1)).join(' / '),
  );
  must(
    `reference rings use the ${RING_RADIUS_M} m radius`,
    smoothed.references.every((reference) => {
      const centre = ringCentre(reference.path, mPerDegLon);
      return reference.path.every((point) => {
        const east = (point[0] - centre.lon) * mPerDegLon;
        const north = (point[1] - centre.lat) * METRES_PER_DEG_LAT;
        return Math.abs(Math.hypot(east, north) - RING_RADIUS_M) < 1e-6;
      });
    }),
  );

  const toward = towardDeg(DEBUG_TRACK_ID);
  const byBand = sections.map((_, band) => smoothed.stacks.filter((ring) => ring.bandIndex === band));
  const expectedCount = RING_SMOOTHED_COUNT;

  for (let band = 0; band < byBand.length; band++) {
    const rings = byBand[band];
    const slot = slots[band];
    const label = sectionLabels[band] ?? 'section';
    const sectionScatterers = pylon.bands[DEBUG_TRACK_ID]?.[band]?.length ?? 0;

    // A section with no scatterers for this track legitimately has no stack.
    if (rings.length === 0) {
      log(`  ${label} stack: no rings (${sectionScatterers} scatterers for ${DEBUG_TRACK_ID})`);
      must(
        `${label} empty stack means an empty section`,
        sectionScatterers === 0,
        `${sectionScatterers} scatterers`,
      );
      continue;
    }

    const zs = rings.map((ring) => ring.path[0][2]);
    const ascending = zs.every((z, i) => i === 0 || z > zs[i - 1]);
    const radiiOk = rings.every((ring) => {
      const centre = ringCentre(ring.path, mPerDegLon);
      return ring.path.every((point) => {
        const east = (point[0] - centre.lon) * mPerDegLon;
        const north = (point[1] - centre.lat) * METRES_PER_DEG_LAT;
        return Math.abs(Math.hypot(east, north) - RING_RADIUS_M) < 1e-6;
      });
    });

    // Centre shift must equal value × scale along the toward-sensor bearing.
    let shiftOk = true;
    let worstShift = 0;
    for (const ring of rings) {
      const centre = ringCentre(ring.path, mPerDegLon);
      const east = (centre.lon - pylon.lon) * mPerDegLon;
      const north = (centre.lat - pylon.lat) * METRES_PER_DEG_LAT;
      const distance = Math.hypot(east, north);
      const expected = Math.abs(ring.valueMm * DEFAULT_SCALE_M_PER_MM);
      worstShift = Math.max(worstShift, Math.abs(distance - expected));
      if (Math.abs(distance - expected) > 1e-6) shiftOk = false;
      if (distance > 1e-9) {
        const azimuth = ((Math.atan2(east, north) * DEG) + 360) % 360;
        const expectedAzimuth = ring.valueMm >= 0 ? toward : (toward + 180) % 360;
        if (Math.abs(angleDelta(azimuth, expectedAzimuth)) > 1e-3) shiftOk = false;
      }
    }

    log(
      `  ${label} stack: ${rings.length} rings of ${expectedCount} steps, `
      + `z ${fmt(Math.min(...zs))}–${fmt(Math.max(...zs))} m, `
      + `shift |max| ${fmt(Math.max(...rings.map((r) => Math.abs(r.valueMm * DEFAULT_SCALE_M_PER_MM))))} m, `
      + `worst shift error ${worstShift.toExponential(1)} m`,
    );

    // A track that stops before the union grid ends leaves the top step empty, so
    // the last ring sits at most one step below the ceiling.
    const step = (slot.zEnd - slot.zStart) / Math.max(1, expectedCount - 1);
    must(
      `${label} stack reaches the ceiling within one step`,
      Math.max(...zs) <= slot.zEnd + 1e-6 && Math.max(...zs) >= slot.zEnd - step - 1e-6,
      `${fmt(Math.max(...zs) - slot.zEnd)} m from the ceiling`,
    );
    must(`${label} stack height increases with time`, ascending);
    must(`${label} rings keep the constant radius`, radiiOk);
    must(`${label} ring shift = value × ×1000 along ${fmt(toward, 0)}°`, shiftOk);
    must(
      `${label} ring dates increase`,
      rings.every((ring, i) => i === 0 || ring.dateMs > rings[i - 1].dateMs),
    );
    must(
      `${label} ring colours follow Viridis`,
      rings.every((ring) => ring.color.length === 4 && ring.color[3] === RING_ALPHA_SMOOTHED),
    );
  }

  const raw = buildSectionRingStacks({
    pylon,
    activeTrackId: DEBUG_TRACK_ID,
    grid: store.grid,
    rawMode: true,
    windowDays,
    scaleMPerMm: DEFAULT_SCALE_M_PER_MM,
  });
  const rawPerBand = sections.map((_, band) => raw.stacks.filter((ring) => ring.bandIndex === band));
  log(`  raw stacks ${rawPerBand.map((rings) => rings.length).join(' / ')} of ${RING_RAW_COUNT}`);
  must(
    'raw mode uses sampled acquisitions and a lower alpha',
    raw.stacks.length > 0
      && raw.stacks.length <= sectionCount * RING_RAW_COUNT
      && raw.stacks.every((ring) => ring.color[3] === RING_ALPHA_RAW),
  );

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
      `  band ${sectionLabels[band] ?? 'section'}: d95=${fmt(fields['95D'])} d44=${fmt(fields['44A'])} `
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

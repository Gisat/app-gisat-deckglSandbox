/**
 * Poláky/Hradec v3 — `?debugRig=1` acceptance block.
 *
 * Prints the numeric gates from plan tasks 2–4 for pylon 10 (the default focus)
 * and a no-NaN sweep over the shortest and tallest towers. Enabled only by the
 * query parameter; v1 / v2 ignore it entirely.
 *
 * Each check logs as `console.info('[rig] P/F ...')` so a failing gate is
 * visible without opening the console details.
 */

import {
  bandMedianAt,
  bandMedianSeries,
  buildFinGeometry,
  featureSeries,
} from './bandGeometry';
import {
  SOLVER_TRACK_IDS,
  losRow,
  solveBand,
  towardDeg,
} from './decomposition';
import {
  BAND_FRACTIONS,
  BAND_LABELS,
  FIN_INNER_M,
  FIN_LENGTH_M,
  LANE_OFFSET_M,
  TRACK_IDS,
  metresPerDegLon,
} from './tracks';

export const DEBUG_PYLON_ID = 10;
export const SPOT_PYLON_IDS = [1, 18];

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

/**
 * Runs the debug block.
 *
 * @param {{
 *   store: any, windowDays: number, scaleMPerMm: number,
 * }} input
 * @returns {number} Number of failed checks.
 */
export function logRigDebug({ store, windowDays, scaleMPerMm }) {
  const log = (message) => console.info(`[rig] ${message}`);
  let failures = 0;
  const must = (name, ok, detail) => {
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  log(`window ${windowDays} d · scale ${scaleMPerMm} m/mm · union grid ${store.grid.length} epochs`);
  log(`common decomposition epoch ${fmtDate(store.commonEpochMs)}`);

  const pylon = findPylonById(store, DEBUG_PYLON_ID);
  if (!pylon) {
    log(`FAIL pylon ${DEBUG_PYLON_ID} is not in the rig store`);
    return failures + 1;
  }

  // ---- Task 2: z frame ----------------------------------------------------
  log(`pylon ${pylon.id} (${pylon.typ ?? '?'}) at ${fmt(pylon.lon, 5)}, ${fmt(pylon.lat, 5)}`);
  log(`  baseElevation ${fmt(pylon.baseElevation)} m (DTM _median, reported only)`);
  log('  z frame: terrain (COG) + bandZ + Δ, same offset mode as the tower meshes');
  log(`  height ${fmt(pylon.height, 1)} m`);
  log(`  bandZ ${pylon.bandZ.map((z) => fmt(z)).join(' / ')} m`);
  for (const trackId of TRACK_IDS) {
    log(`  ${trackId} band counts ${pylon.nByBandTrack[trackId].join(' / ')}`);
  }
  // The rig must not use `_median` as an absolute z: the COG terrain under the
  // towers sits ~45 m below that datum at this site. The wire check is that the
  // band heights are a clean fraction of the tower and strictly increasing;
  // `baseElevation` is printed only so the offset stays auditable.
  must(
    'bandZ equals the band fractions of the tower height',
    pylon.bandZ.every((z, i) => Math.abs(z - BAND_FRACTIONS[i] * pylon.height) < 1e-6),
    `${pylon.bandZ.map((z) => fmt(z, 2)).join(' / ')} m`,
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

  // ---- Task 3: fin geometry ----------------------------------------------
  const mPerDegLon = metresPerDegLon(pylon.lat);
  const axisEnd = FIN_INNER_M + FIN_LENGTH_M;
  let quadTotal = 0;

  for (const trackId of TRACK_IDS) {
    const side = trackId === '95D' ? 'west' : 'east';
    const dir = side === 'west' ? -1 : 1;
    const laneOffsetM = trackId === '95D' ? 0 : (trackId === '44A' ? -LANE_OFFSET_M / 2 : LANE_OFFSET_M / 2);

    for (let band = 0; band < pylon.bandZ.length; band++) {
      const scatterers = pylon.bands[trackId][band];
      if (scatterers.length === 0) {
        log(`  fin ${trackId}/${BAND_LABELS[band]}: no scatterers, not drawn`);
        continue;
      }

      const series = bandMedianSeries(scatterers, windowDays, store.grid);
      const geometry = buildFinGeometry({
        series,
        grid: store.grid,
        side,
        laneOffsetM,
        bandZ: pylon.bandZ[band],
        bandIndex: band,
        trackId,
        scaleMPerMm: scaleMPerMm,
        pylon,
      });
      quadTotal += geometry.quads.length;

      const present = series.filter(Number.isFinite).length;
      const gaps = store.grid.length - present;
      const drawn = geometry.curve[0] ?? [];
      const first = drawn[0];
      const last = drawn[drawn.length - 1];
      const innerOffset = first ? dir * (first[0] - pylon.lon) * mPerDegLon : NaN;
      const outerOffset = last ? dir * (last[0] - pylon.lon) * mPerDegLon : NaN;
      const firstMm = first ? first[2] - pylon.bandZ[band] : NaN;
      const ordered = drawn.every((p, i) => i === 0 || dir * (p[0] - drawn[i - 1][0]) > 0);

      log(
        `  fin ${trackId}/${BAND_LABELS[band]}: n=${scatterers.length} quads=${geometry.quads.length} `
        + `present=${present} gaps=${gaps} axis 6→${axisEnd} m, drawn ${fmt(innerOffset, 3)}→`
        + `${fmt(outerOffset, 3)} m, first ${fmt(firstMm)} mm`,
      );

      // The axis is shared by all three tracks, so a track that starts a few days
      // after the first union epoch begins a fraction of a metre outward — never
      // more than one grid step's worth.
      must(`${trackId}/${BAND_LABELS[band]} inner vertex at ${FIN_INNER_M} m (±0.2)`,
        Math.abs(innerOffset - FIN_INNER_M) <= 0.2, `${fmt(innerOffset, 3)} m`);
      must(`${trackId}/${BAND_LABELS[band]} vertices ordered start→end`, ordered);
      // The raw record is pre-referenced to its first epoch, so every scatterer's
      // first `d_*` sample is 0. The *smoothed* first value is the mean of the
      // first window, which is why it is reported rather than asserted at 0.
      must(`${trackId}/${BAND_LABELS[band]} raw records start at 0 mm`,
        scatterers.every((feature) => Math.abs(featureSeries(feature).values[0]) < 1e-9),
        `smoothed start ${fmt(firstMm)} mm`);
      must(`${trackId}/${BAND_LABELS[band]} quads cover every present pair`,
        geometry.quads.length === present - 1, `${geometry.quads.length} vs ${present - 1}`);
      must(`${trackId}/${BAND_LABELS[band]} drawn end stays on the axis`,
        outerOffset <= axisEnd + 0.01, `${fmt(outerOffset, 2)} m`);
    }
  }

  log(`  fins total ${quadTotal} quads`);
  must('fins were built', quadTotal > 0);

  // ---- Task 4: decomposition ---------------------------------------------
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

  // ---- Height sweep ------------------------------------------------------
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

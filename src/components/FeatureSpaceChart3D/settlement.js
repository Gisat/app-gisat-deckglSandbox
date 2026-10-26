/**
 * Cumulative-settlement-from-initial-state transform for the 3D line-profile
 * Trend view.
 *
 * Pure module (no React / three / deck.gl). The source attributes are cumulative
 * trend displacements over overlapping windows, all ending "now"
 * (`TD_90/180/365/730`). The Trend view reports the cumulative settlement
 * measured from the initial state instead:
 *
 *   settlement(t) = TD_730 - TD_x        (TD_0 := 0)
 *
 * See `TREND_TIMELINE` in `attributes.js` for the ordered set of steps.
 */

import { SETTLEMENT_REF_KEY, TREND_TIMELINE } from './attributes';

/** @param {unknown} v */
function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Cumulative settlement [mm] of a profile sample at a timeline step, or null
 * when the underlying fields are missing. The `initial` anchor is 0 by
 * definition; the `now` anchor is the full reference displacement `TD_730`.
 *
 * @param {Record<string, any>} sample
 * @param {import('./attributes').TrendStep} step
 * @returns {number|null}
 */
export function settlementOf(sample, step) {
  if (!sample || !step) return null;
  const ref = sample[SETTLEMENT_REF_KEY];
  if (!isNum(ref)) return null;
  if (step.anchor === 'initial') return 0;
  if (step.anchor === 'now') return ref;
  const td = sample[step.tdKey];
  return isNum(td) ? ref - td : null;
}

/**
 * Stable per-step field keys used to carry settlement into the map's curtain
 * geometry (which reads a single value key per sample), e.g. `SETTLE_90`.
 */
export const SETTLEMENT_KEYS = TREND_TIMELINE.map((step) => `SETTLE_${step.daysAgo}`);

/**
 * Copy `samples` with a settlement value added under each `SETTLEMENT_KEYS[i]`,
 * so `curtainGeometry` / `curtainZDomain` can consume them.
 *
 * @param {Array<Record<string, any>>} samples
 * @returns {Array<Record<string, any>>}
 */
export function withSettlement(samples) {
  const list = Array.isArray(samples) ? samples : [];
  return list.map((sample) => {
    const out = { ...sample };
    TREND_TIMELINE.forEach((step, i) => {
      out[SETTLEMENT_KEYS[i]] = settlementOf(sample, step);
    });
    return out;
  });
}

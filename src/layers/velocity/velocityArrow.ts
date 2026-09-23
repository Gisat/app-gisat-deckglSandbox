import {
  computeArrowTargetMeters,
  computeHeadSizeMeters,
  computeStemThicknessMeters,
  HEAD_WIDTH_RATIO
} from './velocitySymbols';

/**
 * Pure geometry math for the 2D (shader-based) InSAR velocity arrow symbology.
 *
 * Ported from `app-damStabilityInspector/src/lib/symbologies/velocity2d/velocity2dArrow.ts`.
 * The 2D arrows share the absolute map-meter functions with the symbols module,
 * then express them as normalized fractions of the point quad radius (the size
 * of the deck.gl point quad) so the `DynamicArrowLayer` fragment shader can
 * rasterize the arrow inside that quad.
 *
 * The quad radius is a fixed reference (`ARROW_REFERENCE_RADIUS_METERS`) large
 * enough to hold the longest possible arrow. `DynamicArrowLayer` adds a minimum
 * stem that reserves the visible bare stem in front of each glyph's wings, so
 * the longest arrow (max preset pen width 2.5 m, saturated 20 m stem, round-cap
 * head and wing sweep) reaches about 32 m; the 52 m reference leaves margin for
 * the selection stroke. Fractions are `meters / (2 * radius)` because the quad
 * spans `2 * radius` map meters (`p.y = 0.5` maps to `+radius`).
 */

/**
 * Fixed reference radius (in map meters) of the point quad the arrow is
 * rasterized into. The tail sits on the anchor (LOS, `anchorCentered: false`),
 * so the tip lies one full arrow length from the quad centre and the radius
 * must be at least the longest possible arrow for the tip to stay inside the
 * quad edge (`p.y = 0.5` maps to `+radius`). A centered arrow would only need
 * half its length.
 */
export const ARROW_REFERENCE_RADIUS_METERS = 52;

/**
 * Converts an absolute meter dimension into a fraction of the point quad radius.
 *
 * @param meters - Dimension in map meters.
 * @returns Dimension as a fraction of the quad half-side.
 */
export const metersToArrowFraction = (meters: number): number => meters / (2 * ARROW_REFERENCE_RADIUS_METERS);

/**
 * Computes the stem length fraction from the relative velocity.
 *
 * @param velRel - `vel_rel` attribute value, or null when missing.
 * @returns Stem length as a fraction of the point quad radius.
 */
export const computeStemLengthFraction = (velRel: number | null): number =>
  metersToArrowFraction(computeArrowTargetMeters(velRel));

/**
 * Computes the stem thickness fraction from the reliability length rate.
 *
 * The returned value is the full width; the shader halves it.
 *
 * @param relLen - `rel_len` attribute value, or null when missing.
 * @returns Stem thickness as a fraction of the point quad radius.
 */
export const computeStemThicknessFraction = (relLen: number | null): number =>
  metersToArrowFraction(computeStemThicknessMeters(relLen));

/**
 * Computes the arrow head length fraction from the coherence.
 *
 * @param coh - `coh` attribute value, or null when missing.
 * @returns Head length as a fraction of the point quad radius.
 */
export const computeHeadSizeFraction = (coh: number | null): number => metersToArrowFraction(computeHeadSizeMeters(coh));

/**
 * Computes the arrow head base width fraction from the coherence.
 *
 * The head width equals `HEAD_WIDTH_RATIO x head size` in map meters. The
 * returned value is the full base width; the shader halves it.
 *
 * @param coh - `coh` attribute value, or null when missing.
 * @returns Head base width as a fraction of the point quad radius.
 */
export const computeHeadWidthFraction = (coh: number | null): number =>
  metersToArrowFraction(HEAD_WIDTH_RATIO * computeHeadSizeMeters(coh));

/**
 * Returns the fixed reference radius of the point quad, in map meters.
 *
 * @returns The reference quad radius in map meters.
 */
export const computeArrowRadius = (): number => ARROW_REFERENCE_RADIUS_METERS;

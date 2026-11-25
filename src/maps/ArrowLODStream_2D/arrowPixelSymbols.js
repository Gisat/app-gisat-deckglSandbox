/**
 * Pure screen-space symbology math for the ArrowLODStream 2D map.
 *
 * The streamed LOD points carry `los_east` / `los_north`, the horizontal
 * projection of the 3D LOS unit vector (|·| ≈ 0.63), and a cumulative
 * displacement in mm. This module turns those
 * values into the `DynamicArrowLayer` accessor inputs, using the same round-cap
 * arrow geometry as the Arrow Gallery instead of the map-metre velocity
 * symbology (this map sizes arrows in screen pixels).
 *
 * All fractions are in the shader's local `p` space, where the point quad spans
 * `[-0.5, +0.5]` (`DynamicArrowLayer.shader.ts` maps `vLocalPos * 0.5`).
 *
 * The circle/arrow threshold, heading and magnitude normalization are shared
 * with the 3D map and live in `layers/velocity/displacementSymbols`.
 */

import { getLodTier } from '../../layers/lodTiers';
import { getDisplacementNormalized } from '../../layers/velocity/displacementSymbols';

/** Arrow stem-length band in quad-fraction space (before the shader reserve). */
const ARROW_STEM_LENGTH_MIN = 0.06;
const ARROW_STEM_LENGTH_MAX = 0.28;

/** Along-axis wing length of the round-cap preset (multiple of the pen width). */
const ARROW_WING_LENGTH = 2.24;

/** Half-angle between the stem and each wing, in degrees. */
const ARROW_WING_ANGLE_DEG = 40;

/**
 * Pen (stroke) width shared by the stem and both wings, as a quad fraction.
 * A single pen draws the whole stroked arrow, so the head's stroke equals the
 * stem's.
 */
export const ARROW_STEM_THICKNESS = 0.05;

/** Along-axis wing length of the head, as a quad fraction. */
export const ARROW_HEAD_SIZE = ARROW_WING_LENGTH * ARROW_STEM_THICKNESS;

/**
 * Full span of the two wings, as a quad fraction. Derived from the wing length
 * and angle (`headWidth / 2 = headSize * tan(angle)`), matching
 * `arrowShapePresets.ts`.
 */
export const ARROW_HEAD_WIDTH =
    2 * ARROW_WING_LENGTH * Math.tan((ARROW_WING_ANGLE_DEG * Math.PI) / 180) * ARROW_STEM_THICKNESS;

/**
 * Arrow quad radius in screen pixels per LOD tier. The quad must be large
 * enough for the full arrow (the circles only need 2-5 px), and grows slightly
 * with the tier so the denser detail views stay legible.
 */
const ARROW_RADIUS_PIXELS_BY_TIER = [18, 22, 26];

/**
 * Screen-space arrow quad radius for the current zoom tier.
 *
 * @param {number} zoom - Current view zoom.
 * @returns {number} Radius in CSS pixels.
 */
export const getArrowRadiusPixels = (zoom) => ARROW_RADIUS_PIXELS_BY_TIER[getLodTier(zoom)];

/**
 * Maps `|displacement|` (mm) to the data-driven stem length in quad fractions.
 *
 * `|displacement| / 20` keeps the arrow length visually consistent with the
 * `[-20, 20]` colour ramp, so a strongly displaced point is both the longest and
 * the most saturated. Zero displacement keeps the minimum stem, so every point
 * still renders a visible stub.
 *
 * The band ends at 0.28 rather than the full half-quad: the `round-cap` shader
 * adds a bare-stem reserve of `thickness + headSize + thickness / 2` (0.187) on
 * top of this value, and the forward tip stops at `stem + thickness / 2`, so the
 * maximum forward extent is 0.212 + 0.28 = 0.492 and the arrow stays inside the
 * quad together with its anti-aliasing fringe.
 *
 * @param {number} displacement - Current displacement in mm.
 * @returns {number} Stem length as a fraction of the quad half-side.
 */
export const getArrowStemLengthFraction = (displacement) =>
    ARROW_STEM_LENGTH_MIN +
    getDisplacementNormalized(displacement) * (ARROW_STEM_LENGTH_MAX - ARROW_STEM_LENGTH_MIN);

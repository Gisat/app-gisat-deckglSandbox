/**
 * Pure screen-space symbology math for the ArrowLODStream 2D map.
 *
 * The streamed LOD points carry a horizontal LOS unit vector (`los_east`,
 * `los_north`) and a cumulative displacement in mm. This module turns those
 * values into the `DynamicArrowLayer` accessor inputs, using the same round-cap
 * arrow geometry as the Arrow Gallery instead of the map-metre velocity
 * symbology (this map sizes arrows in screen pixels).
 *
 * All fractions are in the shader's local `p` space, where the point quad spans
 * `[-0.5, +0.5]` (`DynamicArrowLayer.shader.ts` maps `vLocalPos * 0.5`).
 */

import { getLodTier } from '../../layers/lodTiers';
import { DISPLACEMENT_CLAMP_MM } from './displacementScale';

/**
 * Displacement magnitude (mm) below which a point is treated as stable and
 * drawn as a circle instead of an arrow. Time-dependent: the point switches
 * between circle and arrow as the displayed displacement crosses this band.
 */
export const DISPLACEMENT_CIRCLE_THRESHOLD_MM = 2;

/**
 * Whether the currently displayed displacement is small enough to render the
 * point as a circle.
 *
 * A missing value is NOT treated as stable, so the point keeps rendering as an
 * arrow instead of silently disappearing into the circle layer.
 *
 * @param {number|null|undefined} displacement - Current displacement in mm.
 * @returns {boolean} True when `|displacement| < 2 mm`.
 */
export const isSmallDisplacement = (displacement) =>
    Number.isFinite(displacement) && Math.abs(displacement) < DISPLACEMENT_CIRCLE_THRESHOLD_MM;

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
export const getArrowStemLengthFraction = (displacement) => {
    const magnitude = Math.abs(Number.isFinite(displacement) ? displacement : 0);
    const normalized = Math.min(magnitude / DISPLACEMENT_CLAMP_MM, 1);
    return ARROW_STEM_LENGTH_MIN + normalized * (ARROW_STEM_LENGTH_MAX - ARROW_STEM_LENGTH_MIN);
};

/**
 * Compass bearing of the horizontal LOS projection.
 *
 * `0` points up / north, matching `DynamicArrowLayer`'s `getAngle` convention
 * (the existing `computeArrowHeading` uses the same bearing space). The sign of
 * `signedValue` flips the arrow 180 degrees.
 *
 * Over a city-scale AOI the LOS vector is almost constant, so most arrows are
 * near-parallel; the sign is what separates the moving-toward / moving-away
 * populations. Pass `mean_velocity` here (stable across the animation) rather
 * than the current cumulative displacement so playback does not flicker.
 *
 * @param {number} east - `los_east` unit-vector component.
 * @param {number} north - `los_north` unit-vector component.
 * @param {number} signedValue - Value whose sign flips the arrow (mm/yr).
 * @returns {number} Heading in degrees `[0, 360)`, or `0` when the vector is
 *   missing or zero.
 */
export const getArrowHeading = (east, north, signedValue) => {
    if (!Number.isFinite(east) || !Number.isFinite(north)) return 0;
    if (east === 0 && north === 0) return 0;

    const bearing = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
    const value = Number.isFinite(signedValue) ? signedValue : 0;
    return value < 0 ? (bearing + 180) % 360 : bearing;
};

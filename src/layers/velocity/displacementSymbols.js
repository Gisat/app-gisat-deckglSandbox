/**
 * Map-agnostic displacement symbology shared by the 2D and 3D Arrow LOD stream
 * maps.
 *
 * The streamed LOD points carry a horizontal LOS unit vector (`los_east`,
 * `los_north`) and a displacement in mm. These pure helpers turn those values
 * into a circle/arrow classification, a compass heading, and the normalized
 * magnitude the arrow-length bands are built from, so both maps classify and
 * orient points identically.
 */

import { DISPLACEMENT_CLAMP_MM } from '../displacementScale';

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

/**
 * Maps `|displacement|` (mm) onto `[0, 1]` against the colour-ramp span.
 *
 * `|displacement| / 20` keeps an arrow's data-driven size consistent with the
 * `[-20, 20]` colour ramp, so a strongly displaced point is both the longest and
 * the most saturated. Missing values coalesce to `0`.
 *
 * @param {number|null|undefined} displacement - Current displacement in mm.
 * @returns {number} Normalized magnitude in `[0, 1]`.
 */
export const getDisplacementNormalized = (displacement) => {
    const magnitude = Math.abs(Number.isFinite(displacement) ? displacement : 0);
    return Math.min(magnitude / DISPLACEMENT_CLAMP_MM, 1);
};

/**
 * Compass bearing of the horizontal LOS projection.
 *
 * `0` points up / north, matching the shader `getAngle` convention (the
 * existing `computeArrowHeading` uses the same bearing space). The sign of
 * `signedValue` flips the arrow 180 degrees.
 *
 * Over a city-scale AOI the LOS vector is almost constant, so most arrows are
 * near-parallel; the sign is what separates the moving-toward / moving-away
 * populations.
 *
 * @param {number} east - `los_east` unit-vector component.
 * @param {number} north - `los_north` unit-vector component.
 * @param {number} signedValue - Value whose sign flips the arrow (mm).
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

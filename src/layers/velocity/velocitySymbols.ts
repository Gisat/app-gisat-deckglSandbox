/**
 * Pure geometry math for the 2D InSAR velocity (LOS) symbology.
 *
 * Ported from `app-damStabilityInspector/src/lib/symbologies/velocity3d/velocity3dSymbols.ts`
 * so the sandbox can render the same shader-based arrows/circles with the same
 * meter-based sizing rules. All functions are pure and side-effect free.
 *
 * Rendering values are driven by feature attributes:
 * - `vel_avg` — average long-term line-of-sight velocity; classifies circle vs
 *   arrow and selects the fixed heading by its sign
 * - `vel_rel` — relative velocity; drives the stem length
 * - `rel_len` — reliability length rate; drives the stem thickness
 * - `coh`     — coherence; drives the arrowhead size/width
 * - `orbit`   — `'A'` (ascending) or `'D'` (descending); selects the fixed
 *   heading pair and whether a feature is the non-dominant orbit
 */

/** Minimum arrow stem length in map meters. */
const ARROW_TARGET_MIN_METERS = 2;

/** Maximum arrow stem length in map meters. */
const ARROW_TARGET_MAX_METERS = 20;

/** |VEL_REL| value at which the stem length saturates at its maximum. */
const ARROW_VEL_REL_CLAMP = 10;

/** Minimum stem (tail) thickness in map meters. */
export const STEM_THICKNESS_MIN_METERS = 1.0;

/** Maximum stem (tail) thickness in map meters. */
export const STEM_THICKNESS_MAX_METERS = 5;

/** Fixed full sphere radius in map meters (matches the 3D point symbology). */
export const SPHERE_RADIUS_METERS = 1.5;

/** Scale factor for small spheres (non-dominant orbit). */
export const NON_DOMINANT_ORBIT_SIZE_FACTOR = 0.5;

/** Sphere radius in map meters for non-dominant-orbit points. */
export const SMALL_SPHERE_RADIUS_METERS = SPHERE_RADIUS_METERS * NON_DOMINANT_ORBIT_SIZE_FACTOR;

/** Lower clamp bound for the `rel_len` attribute. */
const REL_LEN_MIN = 0.4;

/** Upper clamp bound for the `rel_len` attribute. */
const REL_LEN_MAX = 1;

/** Minimum arrowhead size in map meters. */
const HEAD_SIZE_MIN_METERS = 6.5;

/** Maximum arrowhead size in map meters. */
const HEAD_SIZE_MAX_METERS = 13;

/** Lower clamp bound for the `coh` attribute. */
const COH_MIN = 0.4;

/** Upper clamp bound for the `coh` attribute. */
const COH_MAX = 1;

/**
 * Ratio of the arrowhead's base width to its length (matches the QGIS QML
 * equilateral-triangle head).
 */
export const HEAD_WIDTH_RATIO = 0.8;

/** Fixed heading (degrees) for negative velocities, ascending orbit (ENE). */
export const FIXED_HEADING_AWAY_ASC = 80;

/** Fixed heading (degrees) for positive velocities, ascending orbit (WSW). */
export const FIXED_HEADING_TOWARD_ASC = 260;

/** Fixed heading (degrees) for negative velocities, descending orbit (WNW). */
export const FIXED_HEADING_AWAY_DESC = 280;

/** Fixed heading (degrees) for positive velocities, descending orbit (ESE). */
export const FIXED_HEADING_TOWARD_DESC = 100;

/**
 * Coerces a possibly-missing numeric attribute to a fallback value.
 *
 * @param value - Raw attribute value.
 * @param fallback - Value used when the attribute is missing. Defaults to `0`.
 * @returns The original value when finite, otherwise the fallback.
 */
export const coalesce = (value: number | null | undefined, fallback = 0): number =>
  value == null || !Number.isFinite(value) ? fallback : value;

/**
 * Clamps a value into an inclusive `[min, max]` range.
 *
 * @param value - Value to clamp.
 * @param min - Lower bound (inclusive).
 * @param max - Upper bound (inclusive).
 * @returns The clamped value.
 */
export const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Classifies a feature as a near-zero circle based on its average velocity.
 *
 * @param velAvg - `vel_avg` attribute value, or null when missing.
 * @returns True when the feature should render as a circle (`|vel_avg| < 1`).
 */
export const isSphere = (velAvg: number | null): boolean => {
  const v = coalesce(velAvg);
  return v >= -1 && v < 1;
};

/**
 * Classifies a feature as the non-dominant orbit of the active style.
 *
 * @param orbit - Feature's `orbit` attribute, or null when missing.
 * @param dominantOrbit - The active style's dominant orbit, or null/undefined when no orbit filtering applies.
 * @returns True when the feature belongs to the non-dominant orbit.
 */
export const isNonDominantOrbit = (
  orbit: string | null | undefined,
  dominantOrbit: string | null | undefined
): boolean => dominantOrbit != null && orbit != null && orbit !== dominantOrbit;

/**
 * Computes the arrow stem length in map meters from the relative velocity.
 *
 * Linear scale from 2 m at `vel_rel = 0` to 20 m at `|vel_rel| >= 10`.
 *
 * @param velRel - `vel_rel` attribute value, or null when missing.
 * @returns Target stem length in map meters.
 */
export const computeArrowTargetMeters = (velRel: number | null): number => {
  const absVelRel = Math.abs(coalesce(velRel));
  const clamped = clamp(absVelRel, 0, ARROW_VEL_REL_CLAMP);
  return (
    ARROW_TARGET_MIN_METERS + (clamped / ARROW_VEL_REL_CLAMP) * (ARROW_TARGET_MAX_METERS - ARROW_TARGET_MIN_METERS)
  );
};

/**
 * Computes the stem thickness in map meters from the reliability length rate.
 *
 * Linear scale from 1 m at `rel_len = 0.4` to 5 m at `rel_len = 1`.
 *
 * @param relLen - `rel_len` attribute value, or null when missing.
 * @returns Stem thickness in map meters.
 */
export const computeStemThicknessMeters = (relLen: number | null): number => {
  const clamped = clamp(coalesce(relLen, REL_LEN_MIN), REL_LEN_MIN, REL_LEN_MAX);
  return (
    STEM_THICKNESS_MIN_METERS +
    ((clamped - REL_LEN_MIN) / (REL_LEN_MAX - REL_LEN_MIN)) * (STEM_THICKNESS_MAX_METERS - STEM_THICKNESS_MIN_METERS)
  );
};

/**
 * Computes the arrowhead length in map meters from the coherence.
 *
 * Linear scale from 6.5 m at `coh = 0.4` to 13 m at `coh = 1`.
 *
 * @param coh - `coh` attribute value, or null when missing.
 * @returns Arrowhead length in map meters.
 */
export const computeHeadSizeMeters = (coh: number | null): number => {
  const clamped = clamp(coalesce(coh, COH_MIN), COH_MIN, COH_MAX);
  return (
    HEAD_SIZE_MIN_METERS + ((clamped - COH_MIN) / (COH_MAX - COH_MIN)) * (HEAD_SIZE_MAX_METERS - HEAD_SIZE_MIN_METERS)
  );
};

/**
 * Computes the arrow heading (yaw) in degrees from a fixed, orbit-aware pair.
 *
 * @param velAvg - `vel_avg` attribute value, or null when missing.
 * @param orbit - Feature's `orbit` attribute, or null when missing.
 * @returns Heading in degrees.
 */
export const computeArrowHeading = (velAvg: number | null, orbit: string | null | undefined): number => {
  if (orbit === 'D') {
    return coalesce(velAvg) < 0 ? FIXED_HEADING_AWAY_DESC : FIXED_HEADING_TOWARD_DESC;
  }
  return coalesce(velAvg) < 0 ? FIXED_HEADING_AWAY_ASC : FIXED_HEADING_TOWARD_ASC;
};

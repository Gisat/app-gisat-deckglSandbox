/**
 * Pure 3D arrow math for the ArrowLODStream 3D map.
 *
 * The 3D arrows are built from the Arrow Gallery meshes (`arrow_tail_unit.obj`
 * and `arrow_head_round_cap.obj`), placed flat on the terrain. Both meshes share
 * the same convention:
 *
 * - origin at the part's base,
 * - geometry extending along **negative Z** toward the tip,
 * - model Y is the vertical thickness once the mesh is laid flat
 *   (`ARROW_TAIL_UNIT_THICKNESS` model-Y units per pen).
 *
 * The gallery lays the meshes flat with roll `90` and points them along a
 * heading with yaw `(360 - heading) % 360`, so those two helpers mirror the
 * existing `velocity/velocity3dArrow` orientation convention.
 */

import { ARROW_TAIL_UNIT_THICKNESS } from '../../layers/velocity/arrowMeshDimensions';
import { getDisplacementNormalized } from '../../layers/velocity/displacementSymbols';

/** Gallery pen (stroke) width in map meters. */
export const DISPLACEMENT_ARROW_PEN_METERS = 1.5;

/** Stem length at `|displacement| = 0`, in map meters. */
export const STEM_MIN_METERS = 4;

/** Stem length at `|displacement| >= DISPLACEMENT_CLAMP_MM`, in map meters. */
export const STEM_MAX_METERS = 12;

/**
 * Data-driven stem length: 4 m at `|d| = 0` → 12 m at `|d| >= 20 mm`.
 *
 * @param {number|null|undefined} displacement - Current displacement in mm.
 * @returns {number} Stem length in map meters.
 */
export const getArrowStemMeters = (displacement) =>
    STEM_MIN_METERS + getDisplacementNormalized(displacement) * (STEM_MAX_METERS - STEM_MIN_METERS);

/**
 * Vertical raise that makes the flat mesh rest on the terrain: the model's Y
 * cross-section is centred on zero, so lifting by half its thickness puts the
 * underside on the surface.
 *
 * @param {number} pen - Pen width in map meters.
 * @returns {number} Raise in map meters.
 */
export const getRaiseMeters = (pen) => (ARROW_TAIL_UNIT_THICKNESS * pen) / 2;

/**
 * Deck.gl `SimpleMeshLayer` orientation for a compass heading: `[0, yaw, 90]`.
 *
 * The `90` roll turns the model's `-Z` tip onto world `+Y` (north) and its Y
 * thickness onto the vertical; yaw `-heading` then rotates north onto the
 * compass heading.
 *
 * @param {number} heading - Compass heading in degrees.
 * @returns {[number, number, number]} `[pitch, yaw, roll]` in degrees.
 */
export const headingToOrientation = (heading) => [0, (360 - heading) % 360, 90];

/**
 * World-meter offset `meters` along a compass heading, as `[east, north, 0]`.
 *
 * @param {number} heading - Compass heading in degrees.
 * @param {number} meters - Distance in map meters.
 * @returns {[number, number, number]} Offset tuple.
 */
export const headingOffset = (heading, meters) => {
    const radians = (heading * Math.PI) / 180;
    return [Math.sin(radians) * meters, Math.cos(radians) * meters, 0];
};

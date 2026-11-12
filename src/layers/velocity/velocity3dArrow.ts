/**
 * Pure geometry math for the 3D LOS InSAR velocity arrow (a round-capped arrow
 * composite), ported from
 * `app-damStabilityInspector/src/lib/symbologies/velocity3d/velocity3dSymbols.ts`.
 *
 * The shared meter functions (`computeArrowTargetMeters`,
 * `computeStemThicknessMeters`, `computeArrowHeading`, `coalesce`, `clamp`) live in
 * `./velocitySymbols` and are re-exported here; this module adds the 3D-only
 * constants and functions. All functions are pure and side-effect free.
 *
 * Rendering values are driven by feature attributes:
 * - `VEL_AVG` / `vel_avg` — selects the fixed arrow heading by its sign.
 * - `VEL_REL` / `vel_rel` — no longer drives the tail length; every arrow uses
 *   the same fixed length (see `ARROW_FIXED_TAIL_TARGET_METERS`).
 * - `REL_LEN` / `rel_len` — no longer drives thickness; every arrow uses the
 *   same fixed pen width (see `ARROW_PEN_METERS`).
 * - `orbit` — `'A'` (ascending) or `'D'` (descending); selects the heading pair.
 *
 * The arrow is a composite of round rods and round end caps, all sharing one pen
 * width: a round rear cap; a straight round body reaching the tip; two fixed-size
 * wing rods drawn backward-outward from the tip; and round end caps at each wing
 * tip and at the arrow tip.
 */

import {
  ARROW_MODEL_PEN_WIDTH,
  ARROW_TAIL_UNIT_DIAMETER,
  ARROW_TAIL_UNIT_HEIGHT,
  ARROW_TAIL_UNIT_THICKNESS,
} from './arrowMeshDimensions';
import {
  clamp,
  coalesce,
  computeArrowHeading,
  computeArrowTargetMeters,
  computeStemThicknessMeters,
} from './velocitySymbols';

/** Uniform 3D arrow pen width in map meters, shared by every arrow. */
export const ARROW_PEN_METERS = 0.6;

/**
 * Uniform scale applied to the map arrows only (stem length, pen width and fixed
 * head). `1` renders at the base meter bands; lower it to shrink the whole
 * arrow without touching the data-driven constants.
 */
export const ARROW_MAP_SIZE_SCALE = 1;

/** Reference pen width (map meters) the fixed head geometry is sized from. */
export const ARROW_HEAD_PEN_METERS = 1.5;

/** Half-angle between the stem axis and each wing, in degrees. */
export const ARROW_HEAD_WING_ANGLE_DEG = 40;

/** Along-axis wing length, as a multiple of `ARROW_HEAD_PEN_METERS`. */
export const ARROW_HEAD_WING_LENGTH_RATIO = 2.24;

/** Fixed 3D head along-axis length (map meters): `2.24 × 1.5` (= 3.36). */
export const ARROW_HEAD_SIZE_METERS = ARROW_HEAD_WING_LENGTH_RATIO * ARROW_HEAD_PEN_METERS;

/** Fixed 3D head half-width (map meters): `2.24 × tan(40°) × 1.5`. */
export const ARROW_HEAD_HALF_WIDTH_METERS =
  ARROW_HEAD_WING_LENGTH_RATIO * Math.tan((ARROW_HEAD_WING_ANGLE_DEG * Math.PI) / 180) * ARROW_HEAD_PEN_METERS;

/** Fixed length of each straight wing rod (map meters) — the head size. */
export const ARROW_HEAD_WING_ROD_LENGTH_METERS = Math.hypot(
  ARROW_HEAD_SIZE_METERS,
  ARROW_HEAD_HALF_WIDTH_METERS,
);

/**
 * Fixed bare-stem reserve (map meters) added to the fixed tail target:
 * `1.5 × 1.5 + 3.36` (= 5.61 m).
 */
export const ARROW_TAIL_RESERVE_METERS = 1.5 * ARROW_HEAD_PEN_METERS + ARROW_HEAD_SIZE_METERS;

/**
 * Fixed tail (body) length driver in map meters. Replaces the `VEL_REL`-driven
 * band so every arrow renders at the same length, regardless of the feature's
 * displacement.
 */
export const ARROW_FIXED_TAIL_TARGET_METERS = 4;

/**
 * Returns the uniform 3D arrow pen width in map meters.
 *
 * Every arrow uses `ARROW_PEN_METERS`; `REL_LEN` no longer drives thickness.
 *
 * @param _relLen - Unused; kept for call-site compatibility.
 * @returns Pen (stroke) width in map meters.
 */
export const computePenWidthMeters = (_relLen: number | null): number => ARROW_PEN_METERS;

/**
 * Model-unit scale factor mapping one model unit to the pen width in map meters.
 *
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns Pen width as a model-unit scale factor.
 */
export const computePenScale = (relLen: number | null): number =>
  computePenWidthMeters(relLen) / ARROW_MODEL_PEN_WIDTH;

/**
 * Computes the visible 3D tail length (anchor → tip) in map meters.
 *
 * Every arrow uses the same fixed length: `ARROW_FIXED_TAIL_TARGET_METERS` plus
 * the fixed head reserve. It depends on neither the feature's displacement nor
 * its pen.
 *
 * @param _velRel - Unused; kept for call-site compatibility.
 * @param _relLen - Unused; kept for call-site compatibility.
 * @returns Tail length in map meters.
 */
export const computeEffectiveTailMeters = (
  _velRel: number | null,
  _relLen: number | null,
): number => ARROW_FIXED_TAIL_TARGET_METERS + ARROW_TAIL_RESERVE_METERS;

/**
 * Computes the straight-body length in map meters, from the rear cap's flat face
 * to the arrow tip: `max(0, tail − penWidth / 2)`.
 *
 * @param velRel - Unused; the tail length is fixed for every arrow.
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns Straight-body length in map meters.
 */
export const computeBodyLengthMeters = (velRel: number | null, relLen: number | null): number =>
  Math.max(0, computeEffectiveTailMeters(velRel, relLen) - computePenWidthMeters(relLen) / 2);

/**
 * Computes the per-instance scale for the round rear cap mesh: `[pen, pen, pen]`
 * so the semicircular cap is never stretched.
 *
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns `[pen, pen, pen]` model-unit scale.
 */
export const computeCapScale = (relLen: number | null): [number, number, number] => {
  const pen = computePenScale(relLen);
  return [pen, pen, pen];
};

/**
 * Computes the per-instance scale for the straight body mesh.
 *
 * @param velRel - Unused; the tail length is fixed for every arrow.
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns `[lateral, lateral, bodyLength / ARROW_TAIL_UNIT_HEIGHT]`.
 */
export const computeBodyScale = (
  velRel: number | null,
  relLen: number | null,
): [number, number, number] => {
  const pen = computePenScale(relLen);
  const lateral = (pen * ARROW_MODEL_PEN_WIDTH) / ARROW_TAIL_UNIT_DIAMETER;
  return [lateral, lateral, computeBodyLengthMeters(velRel, relLen) / ARROW_TAIL_UNIT_HEIGHT];
};

/**
 * Computes the per-instance scale for a single wing rod mesh — pen-sized
 * cross-section, fixed along-Z length.
 *
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns `[lateral, lateral, wingRodLength / ARROW_TAIL_UNIT_HEIGHT]`.
 */
export const computeWingScale = (relLen: number | null): [number, number, number] => {
  const pen = computePenScale(relLen);
  const lateral = (pen * ARROW_MODEL_PEN_WIDTH) / ARROW_TAIL_UNIT_DIAMETER;
  return [lateral, lateral, ARROW_HEAD_WING_ROD_LENGTH_METERS / ARROW_TAIL_UNIT_HEIGHT];
};

/**
 * Computes the terrain raise (map meters) for the flat composite arrow:
 * `ARROW_TAIL_UNIT_THICKNESS × pen`, lifting the whole pen thickness above the
 * anchor.
 *
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @returns The vertical (model Y) thickness in map meters.
 */
export const computeVectorRaiseMeters = (relLen: number | null): number =>
  ARROW_TAIL_UNIT_THICKNESS * computePenWidthMeters(relLen);

/**
 * Unit direction vector of a compass heading, as `[x = East, y = North, z]`.
 *
 * @param headingDeg - Compass heading in degrees.
 * @returns The `[sin(heading), cos(heading), 0]` direction tuple.
 */
export const computeHeadingDirection = (headingDeg: number): [number, number, number] => {
  const radians = (headingDeg * Math.PI) / 180;
  return [Math.sin(radians), Math.cos(radians), 0];
};

/**
 * Computes the per-instance orientation `[pitch, yaw, roll]` in degrees.
 *
 * Deck.gl's `SimpleMeshLayer` Euler matrix built from `[pitch, yaw, roll]` maps
 * model Y to the world vertical and model X to the lateral axis for pitch `0`;
 * yaw `−heading` then puts the `−Z` tip along the heading and roll `90` keeps the
 * flat face parallel to the ground.
 *
 * @param velAvg - `VEL_AVG` attribute value, or null when missing.
 * @param orbit - `'A'`/`'D'`, or null when missing.
 * @returns `[0, (360 - heading) % 360, 90]`.
 */
export const computeArrowOrientation = (
  velAvg: number | null,
  orbit: string | null | undefined,
): [number, number, number] => [0, (360 - computeArrowHeading(velAvg, orbit)) % 360, 90];

/**
 * Compass angle of one wing's outward direction (from the tip).
 *
 * @param headingDeg - Arrow compass heading in degrees.
 * @param side - `'left'` (+angle) or `'right'` (−angle).
 * @returns Wing compass heading in degrees (0–360).
 */
export const computeWingHeading = (headingDeg: number, side: 'left' | 'right'): number =>
  (headingDeg +
    180 +
    (side === 'left' ? ARROW_HEAD_WING_ANGLE_DEG : -ARROW_HEAD_WING_ANGLE_DEG) +
    360) %
  360;

/**
 * Computes the per-instance orientation for one wing rod.
 *
 * @param velAvg - `VEL_AVG` attribute value driving the fixed heading, or null.
 * @param orbit - `'A'`/`'D'`, or null when missing.
 * @param side - `'left'` or `'right'` wing.
 * @returns `[0, (360 - wingHeading) % 360, 90]`.
 */
export const computeWingOrientation = (
  velAvg: number | null,
  orbit: string | null | undefined,
  side: 'left' | 'right',
): [number, number, number] => [
  0,
  (360 - computeWingHeading(computeArrowHeading(velAvg, orbit), side)) % 360,
  90,
];

/**
 * Computes the per-instance orientation for a round end cap whose **dome** points
 * along a compass heading.
 *
 * @param headingDeg - Compass heading the cap dome should point along.
 * @returns `[0, (360 - headingDeg) % 360, 90]`.
 */
export const computeCapOrientation = (headingDeg: number): [number, number, number] => [
  0,
  (360 - headingDeg + 360) % 360,
  90,
];

/**
 * Computes the per-instance translation of a wing's OUTER end (where its round
 * cap sits): the arrow tip plus the fixed wing rod length along the wing heading.
 *
 * @param velRel - Unused; the tail length is fixed for every arrow.
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @param velAvg - `VEL_AVG` attribute value driving the fixed heading, or null.
 * @param orbit - `'A'`/`'D'`, or null when missing.
 * @param side - `'left'` or `'right'` wing.
 * @returns `[x, y, 0]` world meters offset from the anchor.
 */
export const computeWingTipTranslation = (
  velRel: number | null,
  relLen: number | null,
  velAvg: number | null,
  orbit: string | null | undefined,
  side: 'left' | 'right',
): [number, number, number] => {
  const heading = computeArrowHeading(velAvg, orbit);
  const tail = computeEffectiveTailMeters(velRel, relLen);
  const headDir = computeHeadingDirection(heading);
  const wingDir = computeHeadingDirection(computeWingHeading(heading, side));
  return [
    headDir[0] * tail + wingDir[0] * ARROW_HEAD_WING_ROD_LENGTH_METERS,
    headDir[1] * tail + wingDir[1] * ARROW_HEAD_WING_ROD_LENGTH_METERS,
    0,
  ];
};

/**
 * Computes the per-instance translation shared by the round rear cap and the
 * straight body: half a pen forward of the anchor.
 *
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @param velAvg - `VEL_AVG` attribute value driving the fixed heading, or null.
 * @param orbit - `'A'`/`'D'`, or null when missing.
 * @returns `[pen/2 * sin(heading), pen/2 * cos(heading), 0]`.
 */
export const computeStemTranslation = (
  relLen: number | null,
  velAvg: number | null,
  orbit: string | null | undefined,
): [number, number, number] => {
  const direction = computeHeadingDirection(computeArrowHeading(velAvg, orbit));
  const offset = computePenWidthMeters(relLen) / 2;
  return [direction[0] * offset, direction[1] * offset, 0];
};

/**
 * Computes the per-instance translation placing the wing rods and the tip cap at
 * the arrow tip: `tail` along the heading.
 *
 * @param velRel - Unused; the tail length is fixed for every arrow.
 * @param relLen - Unused; the pen width is fixed for every arrow.
 * @param velAvg - `VEL_AVG` attribute value driving the fixed heading, or null.
 * @param orbit - `'A'`/`'D'`, or null when missing.
 * @returns `[tail * sin(heading), tail * cos(heading), 0]`.
 */
export const computeArrowTranslation = (
  velRel: number | null,
  relLen: number | null,
  velAvg: number | null,
  orbit: string | null | undefined,
): [number, number, number] => {
  const direction = computeHeadingDirection(computeArrowHeading(velAvg, orbit));
  const offset = computeEffectiveTailMeters(velRel, relLen);
  return [direction[0] * offset, direction[1] * offset, 0];
};

/** Re-exported shared helpers so layer builders have one import site. */
export { clamp, coalesce, computeArrowHeading, computeArrowTargetMeters, computeStemThicknessMeters };

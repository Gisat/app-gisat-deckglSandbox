/**
 * Model-unit dimensions of the 3D LOS arrow OBJ meshes.
 *
 * Ported from
 * `app-damStabilityInspector/src/lib/symbologies/velocity3d/arrowMeshDimensions.ts`
 * (pure geometry constants only; the OBJ URLs live in the layer builder).
 *
 * The 3D LOS arrow is a composite of two meshes that share one pen width:
 * - `arrow_tail_unit_rounded.obj` — a round rod, used for the straight body and
 *   the two wing rods.
 * - `arrow_tail_round_end_rounded.obj` — a round end cap (flat face at `Z = 0`,
 *   dome toward −Z), used for the rear cap, the two wing-tip caps and the arrow
 *   tip cap.
 *
 * Convention (both meshes):
 * - The origin `(0, 0, 0)` sits at the part's **base**.
 * - The geometry extends along the **negative Z axis** toward the tip.
 *
 * Measured bounding boxes (model units):
 * - rod: Z −1.00 → 0 (height = 1.00); X −0.50 → 0.50, Y −0.40 → 0.40.
 * - cap: Z −0.50 → 0; X −0.50 → 0.50, Y −0.40 → 0.40.
 */

/**
 * Model cross-section width of the shared reference pen, in model units. Every
 * arrow mesh cross-section is authored one pen wide (X span 1.0), so a uniform
 * scale of `penWidth / ARROW_MODEL_PEN_WIDTH` maps model units onto the pen width
 * in map meters.
 */
export const ARROW_MODEL_PEN_WIDTH = 1.0;

/** Base height of the `arrow_tail_unit_rounded.obj` mesh in model units (local Z extent). */
export const ARROW_TAIL_UNIT_HEIGHT = 1.0;

/** Base diameter of the `arrow_tail_unit_rounded.obj` cross-section in model units. */
export const ARROW_TAIL_UNIT_DIAMETER = 1.0;

/**
 * Model-Y span of the `arrow_tail_unit_rounded.obj` cross-section. With the flat
 * orientation the model Y axis is the world vertical, so this is the rod's
 * ground-clearance thickness in model units.
 */
export const ARROW_TAIL_UNIT_THICKNESS = 0.8;

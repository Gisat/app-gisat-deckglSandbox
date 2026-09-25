import type { ArrowShape } from '../DynamicArrowLayer.shader';

/**
 * Fixed arrow-shape presets for evaluating `DynamicArrowLayer` shapes on the
 * Tabqa Dam LOS features.
 *
 * The three distinct presets are the same stroked open-V arrow — one shared
 * centerline — so they differ only in their shape (`round-cap`, `square-cap`,
 * `vertical-cut`). The geometry is driven by the data:
 * - pen width (stroke thickness) ← `rel_len`: one pen draws the stem and both
 *   wings, so the head's stroke always equals the stem's.
 * - stem length ← `vel_rel`, plus a minimum that reserves the same visible bare
 *   stem in front of the wings.
 * - heading ← `vel_avg` + `orbit`; color ← the velocity colormap.
 *
 * `headWidth` / `headSize` are the wing span and the along-axis wing length as
 * multiples of the head's reference pen width (a fixed map-meter size, see
 * `ARROW_HEAD_PEN_METERS` in the factory), so every feature shares one head
 * shape. Each wing sits at `ARROW_WING_ANGLE_DEG` to the stem.
 *
 * One preset is a *thin-edge* variant of another: it uses the same head but drops
 * the default 1px unselected stroke, so the arrow keeps only a smaller soft
 * fringe and the circle points lose their border.
 */

/**
 * Preset-only scale on the pen (stroke) width. The shared stem-thickness mapping
 * spans 1-5 m; the presets multiply it by this factor so their stroke spans
 * 0.5-2.5 m. The data/fill head is unaffected.
 */
export const ARROW_SHAPE_PRESET_STROKE_WIDTH_SCALE = 0.5;

/** Identifier of a built-in arrow shape preset. */
export type ArrowShapePresetId = 'round-cap' | 'square-cap' | 'vertical-cut' | 'vertical-cut-thin';

/**
 * A fixed arrow-head preset.
 *
 * `headWidth` / `headSize` are the wing span and along-axis wing length as
 * multiples of the head's reference pen width, i.e. a fixed head size in map
 * meters. The shape selects the geometry baked into the shader.
 */
export interface ArrowShapePreset {
  id: ArrowShapePresetId;
  /** Human-readable label for the shape-toggle UI. */
  label: string;
  /** Arrow shape rasterized by the shader. */
  shape: ArrowShape;
  /** Wing span as a multiple of the reference head pen width. */
  headWidth: number;
  /** Along-axis wing length as a multiple of the reference head pen width. */
  headSize: number;
  /**
   * When true, drop the default 1px unselected stroke so the arrow renders a
   * smaller soft fringe and the circle points lose their unselected border.
   * Selection / hover borders are unaffected.
   */
  thinEdge?: boolean;
}

/**
 * Half-angle between the stem and each wing, in degrees — the single style knob
 * shared by all three arrows.
 */
const ARROW_WING_ANGLE_DEG = 40;

/** Along-axis wing length, as a multiple of the reference head pen width. */
const ARROW_WING_LENGTH = 2.24;

/**
 * Shared wing geometry of the three arrows. `headWidth` is derived from the wing
 * length and angle (`headWidth / 2 = headSize * tan(angle)`), so changing
 * `ARROW_WING_ANGLE_DEG` keeps every preset consistent.
 */
const ARROW_HEAD = {
  headWidth: 2 * ARROW_WING_LENGTH * Math.tan((ARROW_WING_ANGLE_DEG * Math.PI) / 180),
  headSize: ARROW_WING_LENGTH
} as const;

/** The arrow heads available for comparison. */
export const ARROW_SHAPE_PRESETS: ArrowShapePreset[] = [
  {
    id: 'round-cap',
    label: 'Round-Cap',
    shape: 'round-cap',
    ...ARROW_HEAD
  },
  {
    id: 'square-cap',
    label: 'Square-Cap',
    shape: 'square-cap',
    ...ARROW_HEAD
  },
  {
    id: 'vertical-cut',
    label: 'Vertical-Cut',
    shape: 'vertical-cut',
    ...ARROW_HEAD
  },
  {
    id: 'vertical-cut-thin',
    label: 'Vertical-Cut (Thin Border)',
    shape: 'vertical-cut',
    ...ARROW_HEAD,
    thinEdge: true
  }
];

/**
 * Looks up a preset by id.
 *
 * @param id - Preset identifier, or null/undefined.
 * @returns The matching preset, or null when not found.
 */
export const getArrowShapePreset = (id: ArrowShapePresetId | null | undefined): ArrowShapePreset | null =>
  ARROW_SHAPE_PRESETS.find((preset) => preset.id === id) ?? null;

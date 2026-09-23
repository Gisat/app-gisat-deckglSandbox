import type { ArrowGlyph } from '../DynamicArrowLayer.shader';

/**
 * Fixed arrow-head presets for evaluating `DynamicArrowLayer` glyphs on the
 * Tabqa Dam LOS features.
 *
 * A preset selects the **head glyph only**. The glyphs are fixed-pen-width
 * drawings traced from the reference SVG, as if drawn with a single pen whose
 * width is the whole-arrow size, so the whole glyph scales as one piece:
 * - pen width (whole-arrow size) ← `rel_len`: scales `headSize`, `headWidth`
 *   and the stem thickness together, so the stem and the head bars always have
 *   the same thickness.
 * - stem length ← `vel_rel`, plus a minimum that reserves the same visible bare
 *   stem in front of the wings for every glyph (so the presets look equally
 *   long even though their wings sweep back by different amounts).
 * - heading ← `vel_avg` + `orbit`; color ← the velocity colormap.
 *
 * `headWidth` / `headSize` are the head's width and length as multiples of the
 * pen width, traced from the reference SVG:
 * - `round-cap` (open V strokes): head width 4.48, head length 2.24
 * - `butt-cap` (square cut):     head width 4.97, head length 3.21
 * - `flush-cap` (flat cut):      head width 3.32, head length 1.92
 *
 * `headSize`'s along-axis meaning is glyph-specific, since each glyph is traced
 * independently: it is the forward tip offset for `triangle`/`barbed`, the
 * *total* along-axis head extent for `dart`, and the backward arm length for
 * `open`. `DynamicArrowLayer` compensates with per-glyph wing-sweep factors, so
 * do not read `headSize` as a shared "tip distance".
 */

/**
 * Preset-only scale on the pen width. The shared stem-thickness mapping spans
 * 1-5 m; the presets multiply it by this factor so their pen width (and, since
 * the head is a multiple of it, the whole glyph) spans 0.5-2.5 m. The fill head
 * is unaffected.
 */
export const ARROW_SHAPE_PRESET_STROKE_WIDTH_SCALE = 0.5;

/** Identifier of a built-in arrow shape preset. */
export type ArrowShapePresetId = 'round-cap' | 'butt-cap' | 'flush-cap';

/**
 * A fixed arrow-head preset.
 *
 * `headWidth` / `headSize` are the head's width and length as multiples of the
 * pen width (the `rel_len`-driven stem thickness); scaling both by that width
 * keeps the whole glyph, including its bar thickness, drawn with one pen. The
 * glyph itself (angles, barbs, caps) is baked into the shader.
 */
export interface ArrowShapePreset {
  id: ArrowShapePresetId;
  /** Human-readable label for the shape-toggle UI. */
  label: string;
  /** Arrow head glyph rasterized by the shader. */
  glyph: ArrowGlyph;
  /** Head width as a multiple of the pen width. */
  headWidth: number;
  /** Head length as a multiple of the pen width. */
  headSize: number;
}

/** The three arrow heads available for comparison. */
export const ARROW_SHAPE_PRESETS: ArrowShapePreset[] = [
  {
    id: 'round-cap',
    label: 'Round-Cap Arrow',
    glyph: 'open',
    headWidth: 4.48,
    headSize: 2.24
  },
  {
    id: 'butt-cap',
    label: 'Square-Cap / Butt-Cap Arrow',
    glyph: 'dart',
    headWidth: 4.968,
    headSize: 3.214
  },
  {
    id: 'flush-cap',
    label: 'Vertical-Cut / Flush-Cap Arrow',
    glyph: 'barbed',
    headWidth: 3.32,
    headSize: 1.916
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

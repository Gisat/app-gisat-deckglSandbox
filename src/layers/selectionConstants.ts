/**
 * Feature-border (selection / hover) stroke widths shared by the symbology
 * accessors and the generic layer shaders (`DynamicArrowLayer`).
 *
 * This module is intentionally dependency-free (no imports) so a reusable
 * shader can read the stroke widths without depending on symbology code — the
 * sandbox equivalent of
 * `app-damStabilityInspector/src/lib/symbologies/constants/selection.ts`, which
 * the ported shader imports there.
 */

/** Border width (CSS px) of selected features. */
export const SELECTED_FEATURE_LINE_WIDTH = 3;

/** Border width (CSS px) of unselected features (the transparent ring). */
export const NON_SELECTED_FEATURE_LINE_WIDTH = 1;

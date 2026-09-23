import { getRgbaColorFromHex, type RgbaColor } from './velocityColormap';

/**
 * Shared feature-border (selection / hover) constants for the 2D velocity
 * symbology, mirroring
 * `app-damStabilityInspector/src/lib/symbologies/constants/selection.ts`.
 *
 * The border of every sublayer (arrows and circles) is driven by the same
 * accessors: unselected features get a transparent 1px ring (effectively
 * invisible), hovered features a red 3px ring, and selected features the
 * per-feature selection color at 3px.
 */

/** Border color of unselected features (transparent — effectively no border). */
export const NON_SELECTED_FEATURE_LINE_COLOR: RgbaColor = [0, 0, 0, 0];

/** Border width (CSS px) of unselected features. */
export const NON_SELECTED_FEATURE_LINE_WIDTH = 1;

/** Border color of hovered features. */
export const HOVERED_FEATURE_LINE_COLOR: RgbaColor = getRgbaColorFromHex('#ff3c30');

/** Border width (CSS px) of hovered features. */
export const HOVERED_FEATURE_LINE_WIDTH = 3;

/** Border width (CSS px) of selected features. */
export const SELECTED_FEATURE_LINE_WIDTH = 3;

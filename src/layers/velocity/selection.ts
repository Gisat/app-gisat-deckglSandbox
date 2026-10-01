import { getRgbaColorFromHex, type RgbaColor } from './velocityColormap';

/**
 * Shared feature-border (selection / hover) color and hover-width constants for
 * the 2D velocity symbology.
 *
 * The selected / non-selected stroke widths live in the dependency-free
 * `src/layers/selectionConstants.ts` (so the reusable `DynamicArrowLayer` shader
 * can read them without importing symbology code) and are re-exported here so
 * consumers have a single selection-constants entry point.
 *
 * The border of every sublayer (arrows and circles) is driven by the same
 * accessors: unselected features get a transparent 1px ring (effectively
 * invisible), hovered features a red 3px ring, and selected features the
 * per-feature selection color at 3px.
 */

export {
  NON_SELECTED_FEATURE_LINE_WIDTH,
  SELECTED_FEATURE_LINE_WIDTH
} from '../selectionConstants';

/** Border color of unselected features (transparent — effectively no border). */
export const NON_SELECTED_FEATURE_LINE_COLOR: RgbaColor = [0, 0, 0, 0];

/** Border color of hovered features. */
export const HOVERED_FEATURE_LINE_COLOR: RgbaColor = getRgbaColorFromHex('#ff3c30');

/** Border width (CSS px) of hovered features. */
export const HOVERED_FEATURE_LINE_WIDTH = 3;

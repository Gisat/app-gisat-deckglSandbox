/**
 * Zoom-adaptive size band for the LOS (ascending/descending) velocity symbols.
 *
 * Ported from `app-damStabilityInspector/src/lib/symbologies/constants/common.ts`
 * and `computeVelocitySizeZoomScale` in the shared symbology helpers.
 *
 * The Web Mercator pixels-per-meter ratio doubles with every zoom step, so
 * between the floor and ceiling zooms the scale is `1` (plain map meters — the
 * symbols grow/shrink geographically with the zoom). At/under the floor zoom the
 * scale is `2^(floorZoom - zoom)` so the rendered on-screen size stays identical
 * to the floor-zoom size; at/above the ceiling zoom it is `2^(ceilingZoom - zoom)`.
 */

/** Zoom at/under which the LOS symbols hold a fixed on-screen size. */
export const VELOCITY_LOS_SIZE_FLOOR_ZOOM = 15;

/** Zoom at/above which the LOS symbols hold a fixed on-screen size. */
export const VELOCITY_LOS_SIZE_CEILING_ZOOM = 18;

/**
 * Computes the zoom-adaptive size scale applied to the absolute meter radius.
 *
 * @param zoom - Current map zoom level.
 * @returns Scale factor for the absolute meter radius.
 */
export const computeVelocitySizeZoomScale = (zoom: number): number => {
  if (zoom <= VELOCITY_LOS_SIZE_FLOOR_ZOOM) {
    return Math.pow(2, VELOCITY_LOS_SIZE_FLOOR_ZOOM - zoom);
  }
  if (zoom >= VELOCITY_LOS_SIZE_CEILING_ZOOM) {
    return Math.pow(2, VELOCITY_LOS_SIZE_CEILING_ZOOM - zoom);
  }
  return 1;
};

import { scaleLinear } from 'd3-scale';

/**
 * Displacement color ramp shared by the map layers and the legend.
 *
 * The arrow-length normalizer is derived from the same span, so the longest
 * arrow always matches the most saturated color.
 */
export const COLOR_DOMAIN = [-20, 0, 20];

export const DISPLACEMENT_CLAMP_MM = Math.abs(COLOR_DOMAIN[2]);

export const colorScale = scaleLinear()
    .domain(COLOR_DOMAIN)
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
    .clamp(true);

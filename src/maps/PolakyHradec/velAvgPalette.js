/**
 * Poláky/Hradec `VEL_AVG` colour ramp.
 *
 * Kept inside the map folder on purpose: this 11-stop continuous ramp is the
 * map scale for this dataset only. Other maps and the chart defaults keep
 * `MAP_VELOCITY_COLORS`.
 */

import chroma from 'chroma-js';
import { MAP_VEL_AVG_DOMAIN } from '../../components/FeatureSpaceChart3D/colorScale';

/** Ordered ramp stops, red (-1) → orange → yellow → green → cyan → blue (+1). */
export const POLAKY_VEL_AVG_COLORS = [
  '#B1001D',
  '#D3512C',
  '#F18831',
  '#FBC423',
  '#FFFF00',
  '#70E000',
  '#58D3F0',
  '#44ABDD',
  '#2D84C8',
  '#1960AA',
  '#003E8A',
];

/** Colour domain shared with the chart so the map and chart cannot diverge. */
export const POLAKY_VEL_AVG_DOMAIN = MAP_VEL_AVG_DOMAIN;

/**
 * Builds the continuous Poláky `VEL_AVG` scale over ±1 mm/yr.
 *
 * @returns {import('chroma-js').Scale} Chroma scale for `VEL_AVG`.
 */
export const buildPolakyVelAvgScale = () =>
  chroma.scale(POLAKY_VEL_AVG_COLORS).domain([...POLAKY_VEL_AVG_DOMAIN]);

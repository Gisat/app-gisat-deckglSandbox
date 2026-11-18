/**
 * Poláky/Hradec `VEL_AVG` colour ramp.
 *
 * Kept inside the map folder on purpose: this 11-stop continuous ramp is the
 * map scale for this dataset only. Other maps and the chart defaults keep
 * `MAP_VELOCITY_COLORS`.
 */

import chroma from 'chroma-js';

/**
 * Ascending tracks: ordered ramp stops, blue (-2.5) → cyan → green → yellow →
 * orange → red (+2.5).
 */
export const POLAKY_VEL_AVG_COLORS_ASCENDING = [
  '#003E8A',
  '#1960AA',
  '#2D84C8',
  '#44ABDD',
  '#58D3F0',
  '#70E000',
  '#FFFF00',
  '#FBC423',
  '#F18831',
  '#D3512C',
  '#B1001D',
];

/**
 * Descending tracks: the same ramp inverted, red (-2.5) → orange → yellow →
 * green → cyan → blue (+2.5).
 */
export const POLAKY_VEL_AVG_COLORS_DESCENDING = [
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
export const POLAKY_VEL_AVG_DOMAIN = [-2.5, 2.5];

/**
 * Fixed settlement ramp for the 3D timeline: one rainbow for every orbit so
 * settlement colours stay comparable across tracks. VEL_AVG colouring keeps
 * the per-orbit map ramp so it matches the map and legend.
 */
export const POLAKY_SETTLEMENT_COLORS = POLAKY_VEL_AVG_COLORS_DESCENDING;

/**
 * Ordered ramp for one orbit (`'D'` inverts the ascending ramp).
 *
 * @param {'A'|'D'|null|undefined} [orbit]
 * @returns {string[]} Chroma palette stops.
 */
export const getPolakyVelAvgColors = (orbit) =>
  (orbit === 'D'
    ? POLAKY_VEL_AVG_COLORS_DESCENDING
    : POLAKY_VEL_AVG_COLORS_ASCENDING);

/**
 * Builds the continuous Poláky `VEL_AVG` scale over the map's ±2.5 mm/yr domain
 * for one orbit.
 *
 * @param {'A'|'D'|null|undefined} [orbit] Track orbit; `'D'` uses the inverted ramp.
 * @returns {import('chroma-js').Scale} Chroma scale for `VEL_AVG`.
 */
export const buildPolakyVelAvgScale = (orbit = 'A') =>
  chroma.scale(getPolakyVelAvgColors(orbit)).domain([...POLAKY_VEL_AVG_DOMAIN]);

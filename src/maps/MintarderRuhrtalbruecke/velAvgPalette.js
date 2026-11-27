/**
 * Mintarder Ruhrtalbrücke `VEL_AVG` colour ramp.
 *
 * Kept inside the map folder on purpose: the map owns its scale so a change to
 * another map's palette or domain cannot silently recolour this route or its
 * legend. Ascending tracks run blue (-2.5) → red (+2.5); descending tracks use
 * the same ramp inverted, so a given colour reads the same way on every orbit.
 */

import chroma from 'chroma-js';

/** Ascending tracks: ordered ramp stops, blue (-2.5) → red (+2.5). */
export const MINTARDER_VEL_AVG_COLORS_ASCENDING = [
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

/** Descending tracks: the same ramp inverted, red (-2.5) → blue (+2.5). */
export const MINTARDER_VEL_AVG_COLORS_DESCENDING = [
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

/** Colour domain shared by the map symbols, legend and info card. */
export const MINTARDER_VEL_AVG_DOMAIN = [-2.5, 2.5];

/**
 * Ordered ramp for one orbit (`'D'` inverts the ascending ramp).
 *
 * @param {'A'|'D'|null|undefined} [orbit]
 * @returns {string[]} Chroma palette stops.
 */
export const getMintarderVelAvgColors = (orbit) =>
  (orbit === 'D'
    ? MINTARDER_VEL_AVG_COLORS_DESCENDING
    : MINTARDER_VEL_AVG_COLORS_ASCENDING);

/**
 * Builds the continuous `VEL_AVG` scale for one orbit.
 *
 * The default domain is the map's ±2.5 mm/yr; callers that auto-expand the
 * domain per track can pass their own symmetric `[min, max]`.
 *
 * @param {'A'|'D'|null|undefined} [orbit] Track orbit; `'D'` uses the inverted ramp.
 * @param {[number, number]} [domain] Scale domain; defaults to ±2.5 mm/yr.
 * @returns {import('chroma-js').Scale} Chroma scale for `VEL_AVG`.
 */
export const buildMintarderVelAvgScale = (
  orbit = 'A',
  domain = MINTARDER_VEL_AVG_DOMAIN,
) => chroma.scale(getMintarderVelAvgColors(orbit)).domain([...domain]);

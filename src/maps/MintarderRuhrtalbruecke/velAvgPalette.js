/**
 * Mintarder Ruhrtalbrücke `VEL_AVG` colour ramps.
 *
 * Kept inside the map folder on purpose: the map owns its scale so a change to
 * another map's palette or domain cannot silently recolour this route or its
 * legend. The two ramps are explicit options, not tied to an orbit: ascending
 * runs blue (−2.5) → red (+2.5) and descending runs red (−2.5) → blue (+2.5).
 * Descending is the default for every velocity attribute so a given colour
 * reads the same way on every track.
 */

/** Ascending option: ordered ramp stops, blue (-2.5) → red (+2.5). */
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

/** Descending option (default): the same ramp inverted, red (-2.5) → blue (+2.5). */
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

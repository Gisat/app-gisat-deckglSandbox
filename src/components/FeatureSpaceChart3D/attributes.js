/**
 * Attribute metadata, presets and helpers for the 3D feature-space chart.
 *
 * Pure module: no React, no deck.gl, no chart-library imports. Safe to lift into
 * another repository as-is.
 *
 * The Tabqa (Syria) InSAR source attributes are read directly off the feature
 * `properties` with UPPERCASE keys (fid, ID, H, VEL_REL, VEL_SD, ...). The keys
 * are kept verbatim so the chart reads the GeoJSON without any ETL. `point_id`
 * is derived by the map view and is intentionally NOT a chart attribute.
 */

/**
 * @typedef {Object} AttributeMeta
 * @property {string} key
 * @property {string} label
 * @property {string} short
 * @property {string} unit
 * @property {number} decimals
 * @property {boolean} [derived]
 * @property {boolean} [unitless]
 */

/** @type {Record<string, AttributeMeta>} */
export const ATTRIBUTES = {
  VEL_REL: { key: 'VEL_REL', label: 'Relative velocity', short: 'VEL_REL', unit: 'mm/yr', decimals: 2 },
  VEL_LAST: { key: 'VEL_LAST', label: 'Last-epoch velocity', short: 'VEL_LAST', unit: 'mm/yr', decimals: 2 },
  LT_365: { key: 'LT_365', label: 'Trend (last 365 days)', short: 'LT_365', unit: 'mm/yr', decimals: 2 },
  VEL_AVG: { key: 'VEL_AVG', label: 'Average velocity', short: 'VEL_AVG', unit: 'mm/yr', decimals: 2 },
  VEL_SD: { key: 'VEL_SD', label: 'Velocity std. dev.', short: 'VEL_SD', unit: 'mm/yr', decimals: 2 },
  SVEL_LAST: { key: 'SVEL_LAST', label: 'Last-epoch velocity std. dev.', short: 'SVEL_LAST', unit: 'mm/yr', decimals: 2 },
  LTS_365: { key: 'LTS_365', label: 'Trend 365 d std. dev.', short: 'LTS_365', unit: 'mm/yr', decimals: 2 },
  TD_90: { key: 'TD_90', label: 'Trend displacement (90 d)', short: 'TD_90', unit: 'mm', decimals: 2 },
  TD_180: { key: 'TD_180', label: 'Trend displacement (180 d)', short: 'TD_180', unit: 'mm', decimals: 2 },
  TD_365: { key: 'TD_365', label: 'Trend displacement (365 d)', short: 'TD_365', unit: 'mm', decimals: 2 },
  TD_730: { key: 'TD_730', label: 'Trend displacement (730 d)', short: 'TD_730', unit: 'mm', decimals: 2 },
  STD_90: { key: 'STD_90', label: 'Trend disp. std. dev. (90 d)', short: 'STD_90', unit: 'mm', decimals: 2 },
  STD_180: { key: 'STD_180', label: 'Trend disp. std. dev. (180 d)', short: 'STD_180', unit: 'mm', decimals: 2 },
  STD_365: { key: 'STD_365', label: 'Trend disp. std. dev. (365 d)', short: 'STD_365', unit: 'mm', decimals: 2 },
  STD_730: { key: 'STD_730', label: 'Trend disp. std. dev. (730 d)', short: 'STD_730', unit: 'mm', decimals: 2 },
  H: { key: 'H', label: 'Measured height (H)', short: 'H', unit: 'm', decimals: 1 },
  H_SD: { key: 'H_SD', label: 'Height std. dev. (H_SD)', short: 'H_SD', unit: 'm', decimals: 2 },
  H_REF: { key: 'H_REF', label: 'Reference height (H_REF)', short: 'H_REF', unit: 'm', decimals: 2 },
  COH: { key: 'COH', label: 'Coherence', short: 'COH', unit: '', decimals: 2, unitless: true },
  COH_MOD: { key: 'COH_MOD', label: 'Coherence (modelled)', short: 'COH_MOD', unit: '', decimals: 2, unitless: true },
  INC_ANG: { key: 'INC_ANG', label: 'Incidence angle', short: 'INC_ANG', unit: '\u00b0', decimals: 1 },
  az_ang: { key: 'az_ang', label: 'Azimuth angle', short: 'az_ang', unit: '\u00b0', decimals: 1 },
  REL_LEN: { key: 'REL_LEN', label: 'Relative length', short: 'REL_LEN', unit: '', decimals: 2, unitless: true },
  ACCEL: { key: 'ACCEL', label: 'Acceleration', short: 'ACCEL', unit: 'mm/yr\u00b2', decimals: 2 },
  SEASONAL: { key: 'SEASONAL', label: 'Seasonal amplitude', short: 'SEASONAL', unit: 'mm', decimals: 2 },
  VACC: { key: 'VACC', label: 'Velocity accuracy class', short: 'VACC', unit: '', decimals: 0, unitless: true },
};

/**
 * Ordered attribute keys offered in the axis/color/size pickers, in the order
 * declared above (velocities, trend displacements, heights, coherence, geometry).
 */
export const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTES);

/** Keys usable as a chart axis. */
export const AXIS_KEYS = ATTRIBUTE_KEYS;

/** Keys usable as the color channel. */
export const COLOR_KEYS = ATTRIBUTE_KEYS;

/** Keys usable as the size channel. */
export const SIZE_KEYS = ATTRIBUTE_KEYS;

/**
 * @typedef {Object} PresetAxes
 * @property {string} x
 * @property {string} y
 * @property {string} z
 * @property {string} color
 * @property {string} size
 */

/**
 * @typedef {Object} Preset
 * @property {string} key
 * @property {string} label
 * @property {PresetAxes} axes
 */

/** @type {Record<string, Preset>} */
export const PRESETS = {
  kinematic: {
    key: 'kinematic',
    label: 'Kinematic',
    axes: { x: 'VEL_REL', y: 'VEL_LAST', z: 'LT_365', color: 'VEL_REL', size: 'COH' },
  },
  topographic: {
    key: 'topographic',
    label: 'Topographic',
    axes: { x: 'H', y: 'VEL_REL', z: 'COH', color: 'VEL_REL', size: 'COH' },
  },
};

export const PRESET_KEYS = ['kinematic', 'topographic', 'custom'];

/** Axis bundle used for the free-form Custom preset. */
export const DEFAULT_CUSTOM_AXES = { x: 'VEL_REL', y: 'VEL_LAST', z: 'H', color: 'VEL_REL', size: 'COH' };

export const DEFAULT_PRESET = 'kinematic';

/** Fixed domain used when the size channel is coherence. */
export const COHERENCE_SIZE_DOMAIN = [0, 1];

/**
 * Resolve the active axis bundle for a preset key.
 * @param {string} presetKey
 * @param {PresetAxes} customAxes
 * @returns {PresetAxes}
 */
export function resolveAxes(presetKey, customAxes) {
  if (presetKey === 'custom') return { ...customAxes };
  return { ...PRESETS[presetKey].axes };
}

/**
 * @param {string} key
 * @returns {AttributeMeta}
 */
export function getAttribute(key) {
  return ATTRIBUTES[key] || { key, label: key, short: key, unit: '', decimals: 2 };
}

/**
 * Human-readable axis title, e.g. "Relative velocity [mm/yr]".
 * @param {string} key
 */
export function axisTitle(key) {
  const a = getAttribute(key);
  return a.unit ? `${a.label} [${a.unit}]` : a.label;
}

/**
 * Format a value for tooltips/labels.
 * @param {string} key
 * @param {number|null|undefined} value
 */
export function formatValue(key, value) {
  if (value == null || !Number.isFinite(value)) return '\u2014';
  const a = getAttribute(key);
  const text = value.toFixed(a.decimals);
  return a.unit ? `${text} ${a.unit}` : text;
}

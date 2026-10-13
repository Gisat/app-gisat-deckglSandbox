/**
 * Attribute metadata, presets and helpers for the 3D feature-space chart.
 *
 * Pure module: no React, no deck.gl, no chart-library imports. Safe to lift into
 * another repository as-is.
 *
 * The InSAR source attributes (confirmed against the SelectionDrawing3D dataset)
 * are: vel_rel, coh, inc_ang, az_ang, h, h_dtm, id_global, id_orig, rel_len,
 * vel_last. `h_struct` is derived. `point_id` / `mean_velocity` are derived by
 * the map view and are intentionally NOT chart attributes.
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
  vel_rel: { key: 'vel_rel', label: 'Relative velocity', short: 'vel_rel', unit: 'mm/yr', decimals: 2 },
  vel_last: { key: 'vel_last', label: 'Last-epoch velocity', short: 'vel_last', unit: 'mm/yr', decimals: 2 },
  coh: { key: 'coh', label: 'Coherence', short: 'coh', unit: '', decimals: 2, unitless: true },
  inc_ang: { key: 'inc_ang', label: 'Incidence angle', short: 'inc_ang', unit: '\u00b0', decimals: 1 },
  az_ang: { key: 'az_ang', label: 'Azimuth angle', short: 'az_ang', unit: '\u00b0', decimals: 1 },
  h: { key: 'h', label: 'Measured height (h)', short: 'h', unit: 'm', decimals: 1 },
  h_dtm: { key: 'h_dtm', label: 'DTM elevation (h_dtm)', short: 'h_dtm', unit: 'm', decimals: 1 },
  h_struct: { key: 'h_struct', label: 'Structure height (h - h_dtm)', short: 'h_struct', unit: 'm', decimals: 1, derived: true },
  rel_len: { key: 'rel_len', label: 'Relative length', short: 'rel_len', unit: '', decimals: 2, unitless: true },
};

/**
 * Ordered attribute keys offered in the axis/color/size pickers. The Radar
 * Acquisition Geometry preset is intentionally omitted: `inc_ang` / `az_ang`
 * are constant per InSAR stack, so a scatter over them collapses to a line.
 */
export const ATTRIBUTE_KEYS = [
  'vel_rel',
  'vel_last',
  'coh',
  'inc_ang',
  'az_ang',
  'h',
  'h_dtm',
  'h_struct',
  'rel_len',
];

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
    axes: { x: 'vel_rel', y: 'vel_last', z: 'h_struct', color: 'vel_rel', size: 'coh' },
  },
  topographic: {
    key: 'topographic',
    label: 'Topographic',
    axes: { x: 'h_dtm', y: 'h_struct', z: 'vel_rel', color: 'vel_rel', size: 'coh' },
  },
};

export const PRESET_KEYS = ['kinematic', 'topographic', 'custom'];

/** Axis bundle used for the free-form Custom preset. */
export const DEFAULT_CUSTOM_AXES = { x: 'vel_rel', y: 'coh', z: 'h_struct', color: 'vel_rel', size: 'coh' };

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

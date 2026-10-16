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
 * @property {string} [stdKey]  paired uncertainty field (used as the Z ribbon band)
 * @property {boolean} [std]    this attribute is itself an uncertainty field
 * @property {boolean} [derived]
 * @property {boolean} [unitless]
 * @property {boolean} [coordinate]  geometry-derived lon/lat (profile axes only)
 */

/** @type {Record<string, AttributeMeta>} */
export const ATTRIBUTES = {
  VEL_REL: { key: 'VEL_REL', label: 'Relative velocity', short: 'VEL_REL', unit: 'mm/yr', decimals: 2, stdKey: 'VEL_SD' },
  VEL_LAST: { key: 'VEL_LAST', label: 'Last-epoch velocity', short: 'VEL_LAST', unit: 'mm/yr', decimals: 2, stdKey: 'SVEL_LAST' },
  LT_365: { key: 'LT_365', label: 'Trend (last 365 days)', short: 'LT_365', unit: 'mm/yr', decimals: 2, stdKey: 'LTS_365' },
  VEL_AVG: { key: 'VEL_AVG', label: 'Average velocity', short: 'VEL_AVG', unit: 'mm/yr', decimals: 2 },
  VEL_SD: { key: 'VEL_SD', label: 'Velocity std. dev.', short: 'VEL_SD', unit: 'mm/yr', decimals: 2, std: true },
  SVEL_LAST: { key: 'SVEL_LAST', label: 'Last-epoch velocity std. dev.', short: 'SVEL_LAST', unit: 'mm/yr', decimals: 2, std: true },
  LTS_365: { key: 'LTS_365', label: 'Trend 365 d std. dev.', short: 'LTS_365', unit: 'mm/yr', decimals: 2, std: true },
  TD_90: { key: 'TD_90', label: 'Trend displacement (90 d)', short: 'TD_90', unit: 'mm', decimals: 2, stdKey: 'STD_90' },
  TD_180: { key: 'TD_180', label: 'Trend displacement (180 d)', short: 'TD_180', unit: 'mm', decimals: 2, stdKey: 'STD_180' },
  TD_365: { key: 'TD_365', label: 'Trend displacement (365 d)', short: 'TD_365', unit: 'mm', decimals: 2, stdKey: 'STD_365' },
  TD_730: { key: 'TD_730', label: 'Trend displacement (730 d)', short: 'TD_730', unit: 'mm', decimals: 2, stdKey: 'STD_730' },
  STD_90: { key: 'STD_90', label: 'Trend disp. std. dev. (90 d)', short: 'STD_90', unit: 'mm', decimals: 2, std: true },
  STD_180: { key: 'STD_180', label: 'Trend disp. std. dev. (180 d)', short: 'STD_180', unit: 'mm', decimals: 2, std: true },
  STD_365: { key: 'STD_365', label: 'Trend disp. std. dev. (365 d)', short: 'STD_365', unit: 'mm', decimals: 2, std: true },
  STD_730: { key: 'STD_730', label: 'Trend disp. std. dev. (730 d)', short: 'STD_730', unit: 'mm', decimals: 2, std: true },
  H: { key: 'H', label: 'Measured height (H)', short: 'H', unit: 'm', decimals: 1, stdKey: 'H_SD' },
  H_SD: { key: 'H_SD', label: 'Height std. dev. (H_SD)', short: 'H_SD', unit: 'm', decimals: 2, std: true },
  H_REF: { key: 'H_REF', label: 'Reference height (H_REF)', short: 'H_REF', unit: 'm', decimals: 2 },
  COH: { key: 'COH', label: 'Coherence', short: 'COH', unit: '', decimals: 2, unitless: true },
  COH_MOD: { key: 'COH_MOD', label: 'Coherence (modelled)', short: 'COH_MOD', unit: '', decimals: 2, unitless: true },
  INC_ANG: { key: 'INC_ANG', label: 'Incidence angle', short: 'INC_ANG', unit: '\u00b0', decimals: 1 },
  az_ang: { key: 'az_ang', label: 'Azimuth angle', short: 'az_ang', unit: '\u00b0', decimals: 1 },
  REL_LEN: { key: 'REL_LEN', label: 'Relative length', short: 'REL_LEN', unit: '', decimals: 2, unitless: true },
  ACCEL: { key: 'ACCEL', label: 'Acceleration', short: 'ACCEL', unit: 'mm/yr\u00b2', decimals: 2 },
  SEASONAL: { key: 'SEASONAL', label: 'Seasonal amplitude', short: 'SEASONAL', unit: 'mm', decimals: 2 },
  VACC: { key: 'VACC', label: 'Velocity accuracy class', short: 'VACC', unit: '', decimals: 0, unitless: true },
  // Geometry-derived coordinates (not feature properties). Offered as profile
  // Y/Z attributes so a line profile can be read against real lon/lat; excluded
  // from the scatter axes/color/size pickers (see SCATTER_KEYS below).
  lon: { key: 'lon', label: 'Longitude', short: 'lon', unit: '\u00b0', decimals: 5, coordinate: true },
  lat: { key: 'lat', label: 'Latitude', short: 'lat', unit: '\u00b0', decimals: 5, coordinate: true },
};

/**
 * Ordered attribute keys offered in the axis/color/size pickers, in the order
 * declared above (velocities, trend displacements, heights, coherence, geometry).
 */
export const ATTRIBUTE_KEYS = Object.keys(ATTRIBUTES);

/** Attribute keys usable in the scatter x/y/z/color/size pickers (no lon/lat). */
const SCATTER_KEYS = ATTRIBUTE_KEYS.filter((key) => !ATTRIBUTES[key].coordinate);

/** Keys usable as a chart axis. */
export const AXIS_KEYS = SCATTER_KEYS;

/** Keys usable as the color channel. */
export const COLOR_KEYS = SCATTER_KEYS;

/** Keys usable as the size channel. */
export const SIZE_KEYS = SCATTER_KEYS;

/**
 * Keys usable as a profile Y/Z axis: every attribute except the uncertainty
 * (`std`) fields (only meaningful as a paired band) and the geometry-derived
 * `lon`/`lat` coordinates (reached via the Lon/Lat basis, not this picker).
 */
export const PROFILE_AXIS_KEYS = ATTRIBUTE_KEYS.filter(
  (key) => !ATTRIBUTES[key].std && !ATTRIBUTES[key].coordinate,
);

/**
 * Default profile axes. The Attributes basis keeps X = distance along the line;
 * the Lon/Lat basis replaces X/Y with real lon/lat. Z defaults to `VEL_REL` (LOS/
 * relative velocity, mm/yr) as the best available proxy. Its band uses the paired
 * `VEL_SD`, whose ownership is unconfirmed — treat the ribbon as indicative (see
 * the profile plan, Open Q1).
 *
 * `zPlan` is the Lon/Lat basis Z default (height, `H`); `basis` the initial basis
 * (Lon/Lat, so the panel opens on the geographic view).
 */
export const PROFILE_DEFAULTS = { y: 'H', z: 'VEL_REL', zPlan: 'H', basis: 'plan' };

/**
 * Attribute-view bases:
 *  - `along`: X = distance along the drawn line (m), Y/Z = attribute pickers.
 *  - `plan`:  X = longitude, Y = latitude (equal ground scale), Z = attribute
 *    picker (default `H`), so the profile reads as a 3D plan view.
 */
export const PROFILE_BASES = ['along', 'plan'];

/**
 * Raw trend windows: cumulative trend displacement over 90/180/365/730 days, in
 * ascending window order with a light->dark sequential colour ramp. These are
 * the source fields for the Trend view's `windows ±σ` shape, which keeps the
 * original per-window `TD_x ± STD_x` reading (the one place the uncertainty is
 * genuinely per-series). Each window's uncertainty field is its paired `STD_*`.
 */
export const TREND_WINDOWS = [
  { key: 'TD_90', stdKey: 'STD_90', days: 90, color: '#c6dbef' },
  { key: 'TD_180', stdKey: 'STD_180', days: 180, color: '#6baed6' },
  { key: 'TD_365', stdKey: 'STD_365', days: 365, color: '#2171b5' },
  { key: 'TD_730', stdKey: 'STD_730', days: 730, color: '#08306b' },
];

/**
 * Human-readable label for a trend window, e.g. `90 d`.
 * @param {number} days
 */
export function trendWindowLabel(days) {
  return `${days} d`;
}

/**
 * Reference key for the cumulative-settlement transform: the longest trend
 * window (`TD_730`) spans the whole record (730 days ending "now"), so it is
 * the total displacement from the initial state and anchors the settlement
 * timeline (see `TREND_TIMELINE` / `settlement.js`).
 */
export const SETTLEMENT_REF_KEY = 'TD_730';

/**
 * @typedef {Object} TrendStep
 * @property {number} daysAgo  days before "now" (730 = initial state, 0 = now)
 * @property {string} label    axis/tooltip label, e.g. `T-90` or `now`
 * @property {string|null} tdKey   cumulative window subtracted from the reference
 * @property {string} stdKey   paired uncertainty field (before propagation)
 * @property {string} color    light->dark sequential colour (oldest -> now)
 * @property {'initial'|'now'} [anchor]  derived endpoint (value 0 / `TD_730`)
 */

/**
 * Settlement timeline for the 3D line-profile Trend view.
 *
 * The source trend fields (`TD_90/180/365/730`) are *cumulative displacements
 * over overlapping windows, all ending "now"*, which is not geotechnically
 * intuitive on its own. The Trend view instead reports the cumulative
 * settlement measured from the initial state (the oldest epoch, 730 days before
 * now):
 *
 *   settlement(t) = TD_730 - TD_x        (TD_0 := 0)
 *
 * which gives, from the initial state to now:
 *   T-730 (initial) = 0
 *   T-365           = TD_730 - TD_365
 *   T-180           = TD_730 - TD_180
 *   T-90            = TD_730 - TD_90
 *   T0   (now)      = TD_730
 *
 * Ordered oldest -> now; the light -> dark blue ramp tracks time since the
 * initial state. The `initial` and `now` anchors are derived from the reference
 * window rather than a `TD_*` field (see `settlement.js`). These are ordered
 * categorical steps, not a linear time scale.
 *
 * @type {TrendStep[]}
 */
export const TREND_TIMELINE = [
  { daysAgo: 730, label: 'T-730', tdKey: 'TD_730', stdKey: 'STD_730', color: '#eff3ff', anchor: 'initial' },
  { daysAgo: 365, label: 'T-365', tdKey: 'TD_365', stdKey: 'STD_365', color: '#bdd7e7' },
  { daysAgo: 180, label: 'T-180', tdKey: 'TD_180', stdKey: 'STD_180', color: '#6baed6' },
  { daysAgo: 90, label: 'T-90', tdKey: 'TD_90', stdKey: 'STD_90', color: '#3182bd' },
  { daysAgo: 0, label: 'now', tdKey: null, stdKey: 'STD_730', color: '#08519c', anchor: 'now' },
];

/** Profile views: the attribute explorer (shipped) and the settlement trend. */
export const PROFILE_VIEWS = ['attributes', 'trend'];

/** Default profile view. */
export const PROFILE_VIEW_DEFAULT = 'attributes';

/**
 * Trend shapes:
 *  - `windows`: the original reading — one line per raw `TREND_WINDOWS` entry
 *    (`TD_x` displacement across distance), each with its paired `STD_x` band.
 *  - `profiles`: one cumulative-settlement profile per `TREND_TIMELINE` step
 *    (`TD_730 - TD_x`, see `settlement.js`), no band.
 *  - `points`: one settlement-vs-time curve per selected point, no bands.
 */
export const TREND_SHAPES = ['windows', 'profiles', 'points'];

/** Default trend shape (the cumulative-settlement profile). */
export const TREND_LINES_DEFAULT = 'profiles';

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

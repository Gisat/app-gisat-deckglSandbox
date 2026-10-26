/**
 * FeatureSpaceChart3D - portable 3D feature-space scatter chart.
 *
 * Single entry point: importing only this barrel pulls in no renderer until
 * FeatureSpaceChart lazily loads the selected one.
 */

export { FeatureSpaceChart } from './FeatureSpaceChart';
export { PointTooltip } from './PointTooltip';
export { ProfileTooltip } from './ProfileTooltip';
export { buildCurtainGeometry, curtainZDomain, CURTAIN_MAX_HEIGHT } from './curtainGeometry';
export { hexToRgba, aggregateSamples } from './profileGeometry';
export { settlementOf, withSettlement, SETTLEMENT_KEYS } from './settlement';

export {
  ATTRIBUTES,
  ATTRIBUTE_KEYS,
  AXIS_KEYS,
  COLOR_KEYS,
  SIZE_KEYS,
  PROFILE_AXIS_KEYS,
  PROFILE_DEFAULTS,
  PROFILE_VIEWS,
  PROFILE_VIEW_DEFAULT,
  TREND_WINDOWS,
  TREND_TIMELINE,
  SETTLEMENT_REF_KEY,
  TREND_SHAPES,
  TREND_LINES_DEFAULT,
  trendWindowLabel,
  PRESETS,
  PRESET_KEYS,
  DEFAULT_CUSTOM_AXES,
  DEFAULT_PRESET,
  COHERENCE_SIZE_DOMAIN,
  resolveAxes,
  getAttribute,
  axisTitle,
  formatValue,
} from './attributes';

export {
  transformFeature,
  transformPoints,
  activeFieldsFor,
  computeAxisDomains,
  projectToCube,
} from './transformPoints';

export {
  MAP_VELOCITY_COLORS,
  MAP_VELOCITY_DOMAIN,
  SIZE_PIXEL_RANGE,
  getColorDomain,
  getSizeDomain,
  buildColorScale,
  colorToRgba,
  colorToHex,
  buildPlotlyColorscale,
  sizeForValue,
} from './colorScale';

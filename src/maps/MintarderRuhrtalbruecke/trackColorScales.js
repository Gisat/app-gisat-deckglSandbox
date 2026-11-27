/**
 * Per-track colour attributes, palettes and domain helpers.
 *
 * Each InSAR track on the Mintarder map can be coloured independently by
 * `VEL_AVG`, `VEL_REL` or `VEL_LAST`, using either the two legacy VEL_AVG ramps
 * or one of the nine ColorBrewer diverging schemes.
 *
 * Direction convention: every scale below is defined warm → cool so the warm
 * end reads at negative values and the cool end at positive values. Seven of
 * the Brewer schemes already follow that order (`schemeRdBu[11]` starts red);
 * `PuOr` (purple → orange) and `PRGn` (purple → green) are cool → warm in the
 * library, so they are reversed once at definition time. The library arrays are
 * never mutated: `[...schemePuOr[11]].reverse()` copies first.
 *
 * The two legacy VEL_AVG ramps are kept exactly as the map shipped them:
 * ascending is blue (−) → red (+) and descending is red (−) → blue (+). They
 * intentionally oppose the Brewer convention and stay explicit options.
 *
 * Pure module: no React or deck.gl imports.
 */

import chroma from 'chroma-js';
import {
  schemeBrBG,
  schemePiYG,
  schemePRGn,
  schemePuOr,
  schemeRdBu,
  schemeRdGy,
  schemeRdYlBu,
  schemeRdYlGn,
  schemeSpectral,
} from 'd3-scale-chromatic';
import {
  MINTARDER_VEL_AVG_COLORS_ASCENDING,
  MINTARDER_VEL_AVG_COLORS_DESCENDING,
  MINTARDER_VEL_AVG_DOMAIN,
} from './velAvgPalette';

/** Colour attributes offered per track, with their symmetric floor domains. */
export const COLOR_ATTRIBUTES = [
  { key: 'VEL_AVG', label: 'VEL_AVG', floorDomain: MINTARDER_VEL_AVG_DOMAIN },
  { key: 'VEL_REL', label: 'VEL_REL', floorDomain: [-3, 3] },
  { key: 'VEL_LAST', label: 'VEL_LAST', floorDomain: [-3, 3] },
];

/** Attribute keys in fallback-preference order (`VEL_AVG` first). */
export const COLOR_ATTRIBUTE_KEYS = COLOR_ATTRIBUTES.map((def) => def.key);

/** Attribute metadata by key. */
export const COLOR_ATTRIBUTE_BY_KEY = Object.fromEntries(
  COLOR_ATTRIBUTES.map((def) => [def.key, def]),
);

/**
 * Selectable scales. The two legacy ramps come first because they are the
 * defaults for ascending/descending orbits.
 */
export const TRACK_COLOR_SCALES = [
  {
    id: 'vel-avg-ascending',
    label: 'VEL_AVG ramp — ascending (blue → red)',
    group: 'legacy',
    colors: MINTARDER_VEL_AVG_COLORS_ASCENDING,
  },
  {
    id: 'vel-avg-descending',
    label: 'VEL_AVG ramp — descending (red → blue)',
    group: 'legacy',
    colors: MINTARDER_VEL_AVG_COLORS_DESCENDING,
  },
  { id: 'brewer-rdbu', label: 'RdBu', group: 'brewer', colors: schemeRdBu[11] },
  { id: 'brewer-rdylbu', label: 'RdYlBu', group: 'brewer', colors: schemeRdYlBu[11] },
  { id: 'brewer-rdylgn', label: 'RdYlGn', group: 'brewer', colors: schemeRdYlGn[11] },
  { id: 'brewer-spectral', label: 'Spectral', group: 'brewer', colors: schemeSpectral[11] },
  { id: 'brewer-brbg', label: 'BrBG', group: 'brewer', colors: schemeBrBG[11] },
  { id: 'brewer-piyg', label: 'PiYG', group: 'brewer', colors: schemePiYG[11] },
  // Warm/cool convention: PuOr and PRGn are defined in reverse.
  {
    id: 'brewer-puor',
    label: 'PuOr',
    group: 'brewer',
    colors: [...schemePuOr[11]].reverse(),
  },
  {
    id: 'brewer-prgn',
    label: 'PRGn',
    group: 'brewer',
    colors: [...schemePRGn[11]].reverse(),
  },
  { id: 'brewer-rdgy', label: 'RdGy', group: 'brewer', colors: schemeRdGy[11] },
];

/** Scale definitions by id. */
export const TRACK_COLOR_SCALE_BY_ID = Object.fromEntries(
  TRACK_COLOR_SCALES.map((def) => [def.id, def]),
);

/** Default legacy ramp per orbit. */
export const DEFAULT_SCALE_ID_BY_ORBIT = {
  A: 'vel-avg-ascending',
  D: 'vel-avg-descending',
};

/**
 * Builds one chroma scale over the given symmetric domain.
 *
 * `chroma-js` (2.x) has no `.clamp()` method; its scales already return the
 * domain-end colours for values outside the domain, so no extra clamping is
 * needed.
 *
 * @param {{ colors: string[] }} scaleDef
 * @param {[number, number]} domain
 */
export const buildTrackColorScale = (scaleDef, domain) =>
  chroma.scale(scaleDef.colors).domain(domain);

/** Preferred symmetric "nice" ceilings, times powers of ten. */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10];

/**
 * Next nice value ≥ `value` from the step ladder (1, 1.5, 2, 2.5, 3, 4, 5,
 * 7.5, 10 × 10ⁿ).
 *
 * @param {number} value
 * @returns {number|null} `null` for non-finite or non-positive input.
 */
const niceCeiling = (value) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  // The epsilon keeps exact steps such as 4.999 for 5 from jumping to 7.5.
  const step = NICE_STEPS.find((candidate) => normalized <= candidate + 1e-9)
    ?? NICE_STEPS[NICE_STEPS.length - 1];
  return step * base;
};

/**
 * Symmetric domain around 0, expanded from the attribute floor to the next nice
 * ceiling when the data needs it.
 *
 * @param {number} maxAbs Largest absolute value in the track.
 * @param {[number, number]} floorDomain Symmetric floor for the attribute.
 * @returns {[number, number]}
 */
export const niceSymmetricDomain = (maxAbs, floorDomain) => {
  const floorMax = Math.max(Math.abs(floorDomain[0]), Math.abs(floorDomain[1]));
  const half = niceCeiling(Math.max(maxAbs || 0, floorMax)) ?? floorMax;
  return [-half, half];
};

/**
 * Reads one colour attribute from a feature, tolerating lowercase parquet
 * exports. Feature properties are canonical uppercase, but the fallback keeps
 * hand-built features working.
 *
 * @param {{ properties?: Record<string, unknown> }} feature
 * @param {string} key
 * @returns {number|null}
 */
export const readColorAttribute = (feature, key) => {
  const properties = feature?.properties ?? {};
  const raw = properties[key] ?? properties[key.toLowerCase()];
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/**
 * One-pass availability and domain stats per attribute, computed at load so
 * changing attribute or scale never rescans the feature array.
 *
 * @param {Array<{ properties?: Record<string, unknown> }>} features
 * @returns {Record<string, { available: boolean, domain: [number, number] }>}
 */
export const computeTrackColorStats = (features) => {
  const stats = Object.fromEntries(
    COLOR_ATTRIBUTES.map((def) => [def.key, { available: false, maxAbs: 0 }]),
  );
  for (const feature of features) {
    for (const def of COLOR_ATTRIBUTES) {
      const value = readColorAttribute(feature, def.key);
      if (value == null) continue;
      stats[def.key].available = true;
      stats[def.key].maxAbs = Math.max(stats[def.key].maxAbs, Math.abs(value));
    }
  }
  for (const def of COLOR_ATTRIBUTES) {
    stats[def.key].domain = niceSymmetricDomain(
      stats[def.key].maxAbs,
      def.floorDomain,
    );
    delete stats[def.key].maxAbs;
  }
  return stats;
};

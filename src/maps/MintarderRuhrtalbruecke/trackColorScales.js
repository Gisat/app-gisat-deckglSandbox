/**
 * Per-track colour attributes, palettes and fixed domains.
 *
 * Each InSAR track on the Mintarder map can be coloured independently by one of
 * seven attributes. Every attribute has one fixed domain shared by all tracks,
 * so the same colour reads the same way on every orbit and enabling another
 * track never rescales the legend.
 *
 * Direction convention: every diverging scale below is defined warm → cool so
 * the warm end reads at negative values and the cool end at positive values.
 * Seven of the Brewer schemes already follow that order (`schemeRdBu[11]` starts
 * red); `PuOr` (purple → orange) and `PRGn` (purple → green) are cool → warm in
 * the library, so they are reversed once at definition time. The library arrays
 * are never mutated: `[...schemePuOr[11]].reverse()` copies first.
 *
 * The two legacy VEL_AVG ramps are kept exactly as the map shipped them:
 * ascending is blue (−) → red (+) and descending is red (−) → blue (+). They
 * intentionally oppose the Brewer convention and stay explicit options. The
 * descending ramp is the default for all three velocity attributes.
 *
 * Sequential attributes use ColorBrewer sequential schemes, which run light
 * (low) → dark (high).
 *
 * Pure module: no React or deck.gl imports.
 */

import chroma from 'chroma-js';
import {
  schemeBlues,
  schemeBrBG,
  schemeBuPu,
  schemeGreens,
  schemeGreys,
  schemeOranges,
  schemePiYG,
  schemePRGn,
  schemePuOr,
  schemePurples,
  schemeRdBu,
  schemeRdGy,
  schemeRdYlBu,
  schemeRdYlGn,
  schemeSpectral,
  schemeYlGnBu,
  schemeYlOrRd,
} from 'd3-scale-chromatic';
import {
  MINTARDER_VEL_AVG_COLORS_ASCENDING,
  MINTARDER_VEL_AVG_COLORS_DESCENDING,
  MINTARDER_VEL_AVG_DOMAIN,
} from './velAvgPalette';

/**
 * Colour attributes offered per track, with their fixed domain and default
 * scale. `kind` drives the legend layout and the scale reset when the user
 * switches between diverging and sequential attributes.
 */
export const COLOR_ATTRIBUTES = [
  {
    key: 'VEL_AVG',
    label: 'VEL_AVG',
    unit: 'mm/yr',
    kind: 'diverging',
    domain: MINTARDER_VEL_AVG_DOMAIN,
    defaultScaleId: 'vel-avg-descending',
  },
  {
    key: 'VEL_REL',
    label: 'VEL_REL',
    unit: 'mm/yr',
    kind: 'diverging',
    domain: [-3, 3],
    defaultScaleId: 'vel-avg-descending',
  },
  {
    key: 'VEL_LAST',
    label: 'VEL_LAST',
    unit: 'mm/yr',
    kind: 'diverging',
    domain: [-3, 3],
    defaultScaleId: 'vel-avg-descending',
  },
  {
    key: 'K_TEMP',
    label: 'K_TEMP',
    unit: 'mm/°C',
    kind: 'sequential',
    domain: [0, 0.8],
    defaultScaleId: 'brewer-ylorrd',
  },
  {
    key: 'H',
    label: 'H',
    unit: 'm',
    kind: 'sequential',
    domain: [30, 190],
    defaultScaleId: 'brewer-blues',
  },
  {
    key: 'H_REF',
    label: 'H_REF',
    unit: 'm',
    kind: 'sequential',
    domain: [-50, 50],
    defaultScaleId: 'brewer-purples',
  },
  {
    key: 'COH',
    label: 'COH',
    unit: '',
    kind: 'sequential',
    domain: [0, 1],
    defaultScaleId: 'brewer-greens',
  },
];

/** Attribute keys in fallback-preference order (`VEL_AVG` first). */
export const COLOR_ATTRIBUTE_KEYS = COLOR_ATTRIBUTES.map((def) => def.key);

/** Attribute metadata by key. */
export const COLOR_ATTRIBUTE_BY_KEY = Object.fromEntries(
  COLOR_ATTRIBUTES.map((def) => [def.key, def]),
);

/**
 * Selectable scales, grouped for the picker. The descending legacy ramp comes
 * first because it is the default for the velocity attributes.
 */
export const TRACK_COLOR_SCALES = [
  {
    id: 'vel-avg-descending',
    label: 'VEL_AVG ramp — descending (default, red → blue)',
    shortLabel: 'VEL_AVG ↓',
    group: 'legacy',
    kind: 'diverging',
    colors: MINTARDER_VEL_AVG_COLORS_DESCENDING,
  },
  {
    id: 'vel-avg-ascending',
    label: 'VEL_AVG ramp — ascending (blue → red)',
    shortLabel: 'VEL_AVG ↑',
    group: 'legacy',
    kind: 'diverging',
    colors: MINTARDER_VEL_AVG_COLORS_ASCENDING,
  },
  {
    id: 'brewer-rdbu',
    label: 'RdBu',
    shortLabel: 'RdBu',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeRdBu[11],
  },
  {
    id: 'brewer-rdylbu',
    label: 'RdYlBu',
    shortLabel: 'RdYlBu',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeRdYlBu[11],
  },
  {
    id: 'brewer-rdylgn',
    label: 'RdYlGn',
    shortLabel: 'RdYlGn',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeRdYlGn[11],
  },
  {
    id: 'brewer-spectral',
    label: 'Spectral',
    shortLabel: 'Spectral',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeSpectral[11],
  },
  {
    id: 'brewer-brbg',
    label: 'BrBG',
    shortLabel: 'BrBG',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeBrBG[11],
  },
  {
    id: 'brewer-piyg',
    label: 'PiYG',
    shortLabel: 'PiYG',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemePiYG[11],
  },
  // Warm/cool convention: PuOr and PRGn are defined in reverse.
  {
    id: 'brewer-puor',
    label: 'PuOr',
    shortLabel: 'PuOr',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: [...schemePuOr[11]].reverse(),
  },
  {
    id: 'brewer-prgn',
    label: 'PRGn',
    shortLabel: 'PRGn',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: [...schemePRGn[11]].reverse(),
  },
  {
    id: 'brewer-rdgy',
    label: 'RdGy',
    shortLabel: 'RdGy',
    group: 'brewer-diverging',
    kind: 'diverging',
    colors: schemeRdGy[11],
  },
  {
    id: 'brewer-blues',
    label: 'Blues',
    shortLabel: 'Blues',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeBlues[9],
  },
  {
    id: 'brewer-greens',
    label: 'Greens',
    shortLabel: 'Greens',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeGreens[9],
  },
  {
    id: 'brewer-greys',
    label: 'Greys',
    shortLabel: 'Greys',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeGreys[9],
  },
  {
    id: 'brewer-oranges',
    label: 'Oranges',
    shortLabel: 'Oranges',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeOranges[9],
  },
  {
    id: 'brewer-purples',
    label: 'Purples',
    shortLabel: 'Purples',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemePurples[9],
  },
  {
    id: 'brewer-bupu',
    label: 'BuPu',
    shortLabel: 'BuPu',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeBuPu[9],
  },
  {
    id: 'brewer-ylgnbu',
    label: 'YlGnBu',
    shortLabel: 'YlGnBu',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeYlGnBu[9],
  },
  {
    id: 'brewer-ylorrd',
    label: 'YlOrRd',
    shortLabel: 'YlOrRd',
    group: 'brewer-sequential',
    kind: 'sequential',
    colors: schemeYlOrRd[9],
  },
];

/** Scale definitions by id. */
export const TRACK_COLOR_SCALE_BY_ID = Object.fromEntries(
  TRACK_COLOR_SCALES.map((def) => [def.id, def]),
);

/**
 * Keeps the current scale while it matches the attribute's kind; otherwise
 * returns that attribute's default scale. Shared by the load fallback and the
 * attribute picker so both reset rules stay in sync.
 *
 * @param {string} scaleId
 * @param {{ kind: string, defaultScaleId: string }} attributeDef
 * @returns {string}
 */
export const resolveScaleIdForAttribute = (scaleId, attributeDef) =>
  (TRACK_COLOR_SCALE_BY_ID[scaleId]?.kind === attributeDef.kind
    ? scaleId
    : attributeDef.defaultScaleId);

/**
 * Builds one chroma scale over the attribute's fixed domain.
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
 * One-pass availability stats per attribute, computed at load so changing
 * attribute or scale never rescans the feature array. Domains are fixed, so
 * availability is the only per-track fact.
 *
 * @param {Array<{ properties?: Record<string, unknown> }>} features
 * @returns {Record<string, { available: boolean }>}
 */
export const computeTrackColorStats = (features) => {
  const stats = Object.fromEntries(
    COLOR_ATTRIBUTES.map((def) => [def.key, { available: false }]),
  );
  for (const feature of features) {
    for (const def of COLOR_ATTRIBUTES) {
      if (stats[def.key].available) continue;
      if (readColorAttribute(feature, def.key) != null) {
        stats[def.key].available = true;
      }
    }
  }
  return stats;
};

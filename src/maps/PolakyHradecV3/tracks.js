/**
 * Poláky/Hradec v3 — measurement tracks and rig constants.
 *
 * Pure module: no React, no deck.gl, no three. Imported by the map host, the
 * pure geometry/decomposition modules and the debug block.
 *
 * The three InSAR products are one orbit pass each. The point cloud still shows
 * one track at a time (v2 rule: point IDs are unique only within a track); the
 * multi-track rig reads all three, because the whole point of v3 is to compare
 * their geometries over the same tower.
 */

import {
  FIXED_HEADING_TOWARD_ASC,
  FIXED_HEADING_TOWARD_DESC,
} from '../../layers/velocity/velocitySymbols';

/**
 * Measurement tracks available on this map. The GeoJSON carries no orbit/track
 * property, so the orbit (which drives the arrow heading pair) is declared here.
 * Files share the point schema and the `index_right` pylon join space.
 */
export const TRACKS = [
  {
    id: '95D',
    direction: 'descending',
    orbit: 'D',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_95D_PS.geojson',
  },
  {
    id: '44A',
    direction: 'ascending',
    orbit: 'A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_44A_PS.geojson',
  },
  {
    id: '146A',
    direction: 'ascending',
    orbit: 'A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_146A_PS.geojson',
  },
];

export const TRACK_IDS = TRACKS.map(t => t.id);
export const DEFAULT_TRACK_ID = '95D';

/**
 * Toward-sensor bearing per track, degrees clockwise from north. These reuse the
 * shared arrow headings so the ring shift, the least-squares rows and the 3D
 * point symbols cannot drift apart.
 */
export const TRACK_TOWARD_DEG = {
  '95D': FIXED_HEADING_TOWARD_DESC,
  '44A': FIXED_HEADING_TOWARD_ASC,
  '146A': FIXED_HEADING_TOWARD_ASC,
};

/**
 * Band heights as a fraction of each tower's GeoJSON `height`. The transcript's
 * fixed 13 / 37 / 60 m put the top band above every tower in this dataset
 * (heights are 39.4–52.4 m); fractions follow the structure instead.
 */
export const BAND_FRACTIONS = [0.25, 0.55, 0.85];

/**
 * Scatterer → band assignment, by `H_REF / height`: below 0.40 → base band,
 * below 0.70 → mid band, everything else (including conductors above the tower
 * top) → top band. Midpoints of the band fractions above.
 */
export const BAND_ASSIGN_FRACTIONS = [0.40, 0.70];

export const BAND_LABELS = ['base', 'mid', 'top'];
export const BAND_COUNT = BAND_FRACTIONS.length;

// ---------------------------------------------------------------------------
// Separated 3-section ring stack
//
// Each tower section owns an empty vertical slot with air above and below it, so
// a slot reads as a local 2014 → 2026 time axis and never as elevation. Inside a
// slot there is one bold horizontal ring per timestep: its height encodes time,
// its centre shift encodes LOS displacement, and its colour encodes time again
// through Viridis. Rings stay strictly horizontal — no terrain extension — so the
// three stacks cannot bleed into each other in perspective.
// ---------------------------------------------------------------------------

/**
 * Vertical slots per section, as a fraction of the tower height:
 * 3 spans × 0.20 + 2 gaps × 0.16 + 0.04 bottom/top margin = 1.0.
 *
 * The gaps are deliberately taller than the old 0.10 (roughly two thirds of a
 * span) so adjacent stacks never read as one continuous column.
 */
export const SECTION_Z_FRACTIONS = [
  [0.04, 0.24], // base / foundation
  [0.40, 0.60], // mid-shaft lattice
  [0.76, 0.96], // upper cross-arms
];

/** Wider than the cross-arms, under half of the 50.8 m closest tower spacing. */
export const RING_RADIUS_M = 11.5;
/** Vertices around one bold ring. */
export const RING_SEGMENTS = 64;
/** Bold rings per section in Smoothed mode. */
export const RING_SMOOTHED_COUNT = 48;
/** Sampled acquisition rings per section in Raw mode. */
export const RING_RAW_COUNT = 120;

/**
 * Ring stroke alpha. Fully opaque: the thin strokes and the section gaps do the
 * separating, so translucency is not needed (and washes the Viridis key out).
 */
export const RING_ALPHA_SMOOTHED = 255;
export const RING_ALPHA_RAW = 255;

/** Displacement exaggeration choices, displayed as ×500 / ×1000 / ×2000. */
export const SCALE_OPTIONS = [0.5, 1.0, 2.0];
/** 8 mm shift = 8 m, ~70% of the 11.5 m ring radius. */
export const DEFAULT_SCALE_M_PER_MM = 1.0;

/**
 * Linear RGB interpolation over a stop list, shared by every ring-colour ramp so
 * the modes cannot drift apart.
 *
 * @param {Array<[number, number, number]>} stops
 * @param {number} t Normalised position, clamped to 0 … 1.
 * @returns {[number, number, number]} RGB.
 */
function sampleRamp(stops, t) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const from = stops[index];
  const to = stops[index + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * frac),
    Math.round(from[1] + (to[1] - from[1]) * frac),
    Math.round(from[2] + (to[2] - from[2]) * frac),
  ];
}

/** Six-stop Viridis ramp, 2014 → 2026. */
const VIRIDIS_STOPS = [
  [68, 1, 84], // deep violet
  [65, 68, 135], // indigo
  [42, 120, 142], // teal blue
  [34, 168, 132], // sea green
  [122, 209, 81], // lime
  [253, 231, 37], // bright yellow
];

/**
 * Viridis colour for time, 2014 → 2026.
 *
 * @param {number} u Normalised time, 0 (2014) … 1 (2026).
 * @returns {[number, number, number]} RGB.
 */
export function viridisColor(u) {
  return sampleRamp(VIRIDIS_STOPS, u);
}

/** Ring colour modes, in switcher order. `time` is the default. */
export const RING_COLOR_MODES = [
  { id: 'time', label: 'Time', title: 'Chronological acquisition year (Viridis 2014 → 2026)' },
  { id: 'season', label: 'Season', title: 'Annual thermal cycle (Winter ↔ Spring/Autumn ↔ Summer)' },
  { id: 'displacement', label: 'Displacement', title: 'Ring LOS displacement (mm): Away/subsidence ↔ 0 ↔ Toward' },
];
export const DEFAULT_RING_COLOR_MODE = 'time';

/**
 * Ring LOS displacement domain, mm. The VEL_AVG palette is reused for this mode,
 * but stretched over the displacement range: the ±2.5 mm/yr velocity domain
 * saturates almost every ring at the ramp ends.
 */
export const RING_DISPLACEMENT_DOMAIN = [-10, 10];

/** Season thermal ramp: Winter → Spring/Autumn → Summer. */
export const SEASON_STOPS = [
  [56, 142, 232],   // Winter (Jan) — cool ice-blue
  [168, 175, 185],  // Spring / Autumn — muted neutral slate-gray
  [239, 108, 68],   // Summer (Jul) — warm coral-orange
];

/**
 * Thermal-cycle colour for one acquisition date. Winter (Jan–Feb) is cold blue,
 * summer (Jul–Aug) is hot red; the phase is a smooth cosine over the year.
 *
 * @param {number} dateMs Epoch ms.
 * @returns {[number, number, number]} RGB.
 */
export function seasonColor(dateMs) {
  if (!Number.isFinite(dateMs)) return SEASON_STOPS[1].slice();
  const d = new Date(dateMs);
  const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
  const dayOfYear = (dateMs - startOfYear) / 86400000;
  // Smooth thermal cosine: 0 = late-Jan winter trough, 0.5 = spring/autumn, 1 = late-Jul summer peak
  const phase = 0.5 * (1 - Math.cos(((dayOfYear - 20) / 365.25) * 2 * Math.PI));
  return sampleRamp(SEASON_STOPS, phase);
}

/** Smoothing windows, in days. The cadence is irregular (6–24 d), so never in samples. */
export const WINDOW_OPTIONS = [30, 90, 180, 365];
export const DEFAULT_WINDOW_DAYS = 90;

/** Metres per degree of latitude at this latitude; longitude follows cos(lat). */
export const METRES_PER_DEG_LAT = 111320;

/**
 * Metres per degree of longitude at `latDeg`.
 *
 * @param {number} latDeg
 * @returns {number}
 */
export function metresPerDegLon(latDeg) {
  return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/** Rig render modes: the ring stack is the only rig reading. */
export const RIG_OFF = 'off';
export const RIG_RINGS = 'rings';
export const RIG_MODES = [
  { id: RIG_OFF, label: 'Off' },
  { id: RIG_RINGS, label: 'Rings' },
];

/** Decomposition confidence thresholds (see `decomposition.js`). */
export const MIN_SCATTERERS_PER_BAND = 3;
export const LOW_CONFIDENCE_SCATTERERS = 6;
export const LOW_CONFIDENCE_RESIDUAL_MM = 1.5;
export const LOW_CONFIDENCE_CONDITION = 10;

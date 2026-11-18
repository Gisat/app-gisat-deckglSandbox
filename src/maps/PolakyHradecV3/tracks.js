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
 * Look direction per track, degrees clockwise from north: where the sensor
 * points. It only decides which side of the ring the curve is drawn on. The
 * least-squares row uses the opposite bearing (toward the sensor), see
 * `towardDeg` in `decomposition.js`.
 */
export const TRACK_LOOK_DEG = {
  '95D': 280,
  '44A': 80,
  '146A': 80,
};

/** One hue per track (fill alpha is applied by the map host). */
export const HALO_TRACK_COLORS = {
  '95D': [108, 79, 216],
  '44A': [14, 159, 143],
  '146A': [217, 119, 6],
};

/**
 * Ring side per track: 95D reads the west semicircle, both ascending tracks the
 * east one. The north-south divider is the seam between them.
 */
export const TRACK_HALO_SIDE = {
  '95D': 'west',
  '44A': 'east',
  '146A': 'east',
};

/** Only this track's curve is dashed, so the two ascending tracks never merge. */
export const DASHED_TRACK_ID = '146A';

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
// Halo rings
//
// One flat polar ring per structural band, centred on the tower axis. Time runs
// clockwise from north (2014) to south (2026) on both semicircles; displacement
// is radial — inward for negative LOS, outward for positive. The 0 mm circle at
// 18 m clears the lattice and still fits inside the 50 m closest neighbour
// spacing, so three rings never intersect a neighbouring tower.
//
// Unlike the old vertical fin walls these are strictly horizontal: no terrain extension and no
// vertical channel, so they cannot bleed into each other in perspective.
// ---------------------------------------------------------------------------

/** -10 mm boundary. */
export const HALO_INNER_RADIUS_M = 10;
/** 0 mm baseline circle: clears the tower, stays inside the neighbour spacing. */
export const HALO_ZERO_RADIUS_M = 18;
/** +10 mm boundary. */
export const HALO_OUTER_RADIUS_M = 26;
/** Metres of radius per millimetre of smoothed LOS displacement. */
export const HALO_RADIAL_SCALE_M_PER_MM = 0.8;
/** Vertices around a full ring (half are used per semicircle disc). */
export const HALO_SEGMENTS = 96;
/** Display vertices per curve, after smoothing. */
export const HALO_SAMPLE_COUNT = 120;

/** Polar sweep: each semicircle spans 150° of the ring, 30° shy of the divider. */
export const HALO_ARC_DEG = 150;
/** 95D starts NNW (345°) and sweeps clockwise to SSW (195°). */
export const HALO_WEST_START_DEG = 345;
/** The ascending tracks start NNE (15°) and sweep clockwise to SSE (165°). */
export const HALO_EAST_START_DEG = 15;

// ---------------------------------------------------------------------------
// Structural ΔU/ΔE vectors
// ---------------------------------------------------------------------------

/** Metres of arrow per millimetre of solved motion. */
export const VECTOR_SCALE_M_PER_MM = 2.5;
/** Even a 1.7 mm mid-shaft tilt must reach past the 3.5 m lattice. */
export const VECTOR_MIN_LENGTH_M = 6.5;
export const VECTOR_MAX_LENGTH_M = 22;
export const VECTOR_SHAFT_RADIUS_M = 0.32;
export const VECTOR_HEAD_LENGTH_M = 2.4;
export const VECTOR_HEAD_RADIUS_M = 0.7;
export const VECTOR_COLOR = [255, 210, 60, 255];

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

/** Rig render modes. Rings are the primary reading; vectors are the optional extra. */
export const RIG_OFF = 'off';
export const RIG_RINGS = 'rings';
export const RIG_RINGS_VECTORS = 'rings-vectors';
export const RIG_MODES = [
  { id: RIG_OFF, label: 'Off' },
  { id: RIG_RINGS, label: 'Rings' },
  { id: RIG_RINGS_VECTORS, label: 'Rings + vectors' },
];

/** Decomposition confidence thresholds (see `decomposition.js`). */
export const MIN_SCATTERERS_PER_BAND = 3;
export const LOW_CONFIDENCE_SCATTERERS = 6;
export const LOW_CONFIDENCE_RESIDUAL_MM = 1.5;
export const LOW_CONFIDENCE_CONDITION = 10;

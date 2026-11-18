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
 * points. It only decides which side of the tower the fin is drawn on. The
 * least-squares row uses the opposite bearing (toward the sensor), see
 * `towardDeg` in `decomposition.js`.
 */
export const TRACK_LOOK_DEG = {
  '95D': 280,
  '44A': 80,
  '146A': 80,
};

/** Fin side per track: descending west, both ascending east. */
export const TRACK_FIN_SIDE = {
  '95D': 'west',
  '44A': 'east',
  '146A': 'east',
};

/** One hue per track (fill alpha is applied by the map host). */
export const FIN_TRACK_COLORS = {
  '95D': [108, 79, 216],
  '44A': [14, 159, 143],
  '146A': [217, 119, 6],
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

/**
 * Rig fin layout, metres. `FIN_INNER_M` equals the collar radius so each ribbon
 * springs directly from its collar ring on the tower instead of starting in
 * mid-air.
 */
export const FIN_INNER_M = 3.5;
export const FIN_LENGTH_M = 60;

/**
 * Lane separation between the two east fins. Both ascending tracks sit on the
 * east side, so they are offset north/south by half this distance each. At 8 m
 * the two translucent walls no longer sit on top of each other in a tilted view.
 */
export const LANE_OFFSET_M = 8.0;

/**
 * Vertical exaggeration choices, displayed as ×700 / ×1500 / ×2500. The default
 * ×1500 makes 4–9 mm deflections read clearly; the ground-clearance clamp in
 * `buildFinGeometry` keeps the deepest base-band values out of the terrain.
 */
export const SCALE_OPTIONS = [0.7, 1.5, 2.5];
export const DEFAULT_SCALE_M_PER_MM = 1.5;

/**
 * Display vertices per fin. Smoothing happens on each track's own dates; the
 * smoothed series is then resampled to this many uniform steps before it becomes
 * geometry. The union grid has ~1300 epochs, i.e. ~0.05 m per segment along a
 * 60 m fin, which turns a dashed line into a sub-pixel scribble.
 */
export const FIN_SAMPLE_COUNT = 120;

/** Band collar: a small ring on the tower at each band height. */
export const BAND_COLLAR_RADIUS_M = 3.5;
export const BAND_COLLAR_SEGMENTS = 48;

/** Fins are clamped to this height above the sampled ground. */
export const RIG_GROUND_CLEARANCE_M = 0.5;

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

/** Rig render modes. */
export const RIG_OFF = 'off';
export const RIG_FINS = 'fins';
export const RIG_FINS_VECTORS = 'fins-vectors';
export const RIG_MODES = [
  { id: RIG_OFF, label: 'Off' },
  { id: RIG_FINS, label: 'Fins' },
  { id: RIG_FINS_VECTORS, label: 'Fins + vectors' },
];

/** Decomposition confidence thresholds (see `decomposition.js`). */
export const MIN_SCATTERERS_PER_BAND = 3;
export const LOW_CONFIDENCE_SCATTERERS = 6;
export const LOW_CONFIDENCE_RESIDUAL_MM = 1.5;
export const LOW_CONFIDENCE_CONDITION = 10;

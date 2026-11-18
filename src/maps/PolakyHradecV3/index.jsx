// Forked from src/maps/PolakyHradecV2 for the Poláky/Hradec v3 multi-track rig.
// v2 keeps the point-cloud / pylon work; v3 adds a rig that reads all three
// tracks at once over the focused pylon (time-fin ribbons per structural band)
// plus a per-band ΔU/ΔE least squares. The point cloud stays single-track: point
// IDs are unique only within a track, so three point layers at once would break
// selection, arrow orbit and the legend branch.
//
// Map-specific modules (this file, tracks/rigData/bandGeometry/decomposition,
// debugRig, velAvgPalette, TimelineChart) live in this folder. The shared
// chart/layer modules (src/components/FeatureSpaceChart3D,
// src/layers/factory/build3dLos*) are used by v1 and /3d-feature-charts as well,
// so nothing here may require changes there.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { COORDINATE_SYSTEM, FlyToInterpolator } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import {
  BitmapLayer,
  PathLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
} from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CylinderGeometry, ConeGeometry } from '@luma.gl/engine';
import { OBJLoader } from '@loaders.gl/obj';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import {
  _TerrainExtension as TerrainExtension,
  PathStyleExtension,
} from '@deck.gl/extensions';
import { build3dLosArrowLayers } from '../../layers/factory/build3dLosArrowLayers';
import { build3dLosSphereLayer } from '../../layers/factory/build3dLosSphereLayer';
import {
  BLUE_PALETTE,
  FeatureSpaceChart,
  isTimelineKey,
} from '../../components/FeatureSpaceChart3D';
import {
  POLAKY_SETTLEMENT_COLORS,
  buildPolakyVelAvgScale,
  getPolakyVelAvgColors,
  POLAKY_VEL_AVG_DOMAIN,
} from './velAvgPalette';
import TimelineChart from './TimelineChart';
import {
  BAND_COLLAR_RADIUS_M,
  BAND_COLLAR_SEGMENTS,
  BAND_LABELS,
  DASHED_TRACK_ID,
  DEFAULT_SCALE_M_PER_MM,
  DEFAULT_TRACK_ID,
  DEFAULT_WINDOW_DAYS,
  FIN_SAMPLE_COUNT,
  FIN_TRACK_COLORS,
  LANE_OFFSET_M,
  RIG_FINS_VECTORS,
  RIG_MODES,
  RIG_OFF,
  SCALE_OPTIONS,
  TRACK_FIN_SIDE,
  TRACK_IDS,
  TRACKS,
  WINDOW_OPTIONS,
  metresPerDegLon,
} from './tracks';
import {
  buildRigStore,
  getPointJoinKey,
  getPylonJoinKey,
  getPylonPickFeature,
  loadRigTracks,
} from './rigData';
import {
  bandMedianAt,
  bandMedianSeries,
  buildBandCollars,
  buildFinGeometry,
  coneOrientation,
  medianScatterer,
  resampleSeries,
} from './bandGeometry';
import { eastLabel, solveBand } from './decomposition';
import { logRigDebug } from './debugRig';
import { TERRAIN_URL, sampleTerrainElevations } from './terrainElevation';

// Measurement tracks, join keys and rig constants live in `tracks.js`;
// `rigData.js` owns the three-track store.


const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const PYLONS_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/sloupy.geojson';
const PYLON_ASSET_BASE = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets';

const PYLON_COLOR = [183, 188, 193, 255];
// Fallback bearing (degrees clockwise from north) for features without
// `azimuth`; the current GeoJSON provides it for every tower.
const PYLON_DEFAULT_AZIMUTH = 60;
// Compasses measure clockwise from north, deck.gl yaw rotates counter-clockwise
// from +X (east), hence yaw = 90 - azimuth. Adjust this offset if a model's
// local forward axis turns out not to be +X after checking it on the imagery.
const PYLON_OBJ_YAW_OFFSET = 0;
// Native heights come from the OBJ headers (metres, Z-up, base centre at origin).
// Each instance is scaled to its GeoJSON `height`; see getPylonHeight below.
const PYLON_MODELS = [
  { typ: 'dunaj', nativeHeight: 40.0, mesh: `${PYLON_ASSET_BASE}/dunaj.obj` },
  { typ: 'kocka', nativeHeight: 26.7, mesh: `${PYLON_ASSET_BASE}/kocka.obj` },
  { typ: 'portal', nativeHeight: 29.169, mesh: `${PYLON_ASSET_BASE}/portal.obj` },
];

// Invisible pick target. SimpleMeshLayer picks per triangle, so the gaps between
// lattice members are not hit-testable; a solid cylinder around the tower
// silhouette makes the whole body clickable.
const PYLON_HIT_RADIUS_FACTOR = 0.25;
const PYLON_HIT_RADIUS_MIN_M = 5;
// Unit cylinder, Z-up, centred on the origin. Scaled per instance to
// [radius, radius, height]. Caps make the top face clickable too.
const PYLON_HIT_MESH = new CylinderGeometry({
  radius: 1,
  height: 1,
  verticalAxis: 'z',
  nradial: 12,
  nvertical: 1,
  topCap: true,
  bottomCap: true,
});

// Stable empty array so memoised selections do not retrigger chart transforms.
const EMPTY = [];

// ---------------------------------------------------------------------------
// Multi-track rig
//
// Rig vertices are `[lon, lat, terrainAtPylon + bandZ + Δ]` in LNGLAT metres —
// one absolute z per tower, sampled once from the draped COG
// (`terrainElevation.js`). No terrain extension on any rig layer: sampling terrain
// per vertex bent each 60 m ribbon with the field topography, so a fin is rigid
// and horizontal in world space by construction.
//
// `terrainAtPylon` must come from the COG, not from `_median` / `H_dem`: the
// InSAR heights sit on a different vertical datum (a smooth 43.9–46.1 m above the
// COG at the 18 towers), so anchoring on them floats the rig ~45 m above the
// steel. `baseElevation` stays in the rig store for reporting only.
// ---------------------------------------------------------------------------
const RIG_FIN_WALL_LAYER = 'rig-fin-walls';
const RIG_FIN_SOLID_LAYER = 'rig-fin-curves';
const RIG_FIN_DASHED_LAYER = 'rig-fin-curves-dashed';
const RIG_FIN_SOLID_GLOW_LAYER = 'rig-fin-curves-glow';
const RIG_FIN_DASHED_GLOW_LAYER = 'rig-fin-curves-glow-dashed';
const RIG_FIN_BASELINE_LAYER = 'rig-fin-baselines';
const RIG_BAND_COLLAR_LAYER = 'rig-band-collars';
const RIG_FIN_ANCHOR_LAYER = 'rig-fin-anchors';
const RIG_VECTOR_SHAFT_LAYER = 'rig-vector-shafts';
const RIG_VECTOR_HEAD_LAYER = 'rig-vector-heads';
const RIG_DEBUG_MARKER_LAYER = 'rig-debug-band-markers';

/** Walls read as translucent glass; curves and baselines stay legible. */
const RIG_FIN_FILL_ALPHA = 105;
const RIG_FIN_STROKE_ALPHA = 255;

/**
 * Two-pass curves: a wide translucent halo under a crisp core, so a timeline
 * reads as a glowing glass edge without losing the exact value line.
 */
const RIG_CURVE_CORE_WIDTH = 3.5;
const RIG_CURVE_GLOW_WIDTH = 8;
const RIG_CURVE_GLOW_ALPHA = 75;

/** Terminal nodes at each curve's first and last vertex. */
const RIG_ANCHOR_RADIUS_PX = 4;

/** The 0 mm zero line is a dashed white rule, not a faint track-coloured line. */
const RIG_BASELINE_COLOR = [255, 255, 255, 190];
const RIG_BASELINE_WIDTH = 1.5;
const RIG_BASELINE_DASH = [4, 4];

/** Band collars tie each ribbon to its structural zone on the tower. */
const RIG_COLLAR_COLOR = [66, 212, 244, 235];
const RIG_COLLAR_WIDTH = 3;

/** Vectors: amber on the focused or hovered tower, pale grey elsewhere. */
const RIG_VECTOR_COLOR = [235, 238, 242];
const RIG_FOCUS_VECTOR_COLOR = [255, 210, 60];
const RIG_SHAFT_RADIUS = 0.16;

/** Auto-zoom target when the rig is switched on (60 m ≈ 20 px at the default z15). */
const RIG_FOCUS_ZOOM = 18;

/**
 * Unit meshes for the vector: a slim rod and a cone head, both with their long
 * axis on local +Z so one `coneOrientation(east, up)` orients shaft and head
 * identically. The shaft is a mesh rather than a pixel-width LineLayer because a
 * 4 px line swallowed the head and read as a floating cone.
 */
const RIG_SHAFT_MESH = new CylinderGeometry({ radius: 1, height: 1, verticalAxis: 'z', nradial: 12 });
const RIG_CONE_MESH = new ConeGeometry({ radius: 1, height: 1, verticalAxis: 'z', nradial: 12 });

// Layer-id prefix shared by the 3D LOS point symbols (arrow parts and spheres).
const POINT_LAYER_PREFIX = 'vel-avg-arrows';

// Pre-selection opened once on mount: Pylon 10 and one of its linked InSAR
// points, so the map highlight and both charts are visible without a click.
// The pylon is resolved by its business id and then mapped to the join key;
// the join key itself (currently "0") is never hardcoded.
const DEFAULT_PYLON_ID = 10;
const DEFAULT_POINT_ID = 59054;

// The chart's VEL_AVG ramps, shared with the map legend and the 3D chart.
// Descending tracks use the inverted ramp so the colour reading does not flip
// between passes over the same pylon.
const ASCENDING_VEL_AVG_SCALE = buildPolakyVelAvgScale('A');
const DESCENDING_VEL_AVG_SCALE = buildPolakyVelAvgScale('D');

// |VEL_AVG| at/below which a point renders as a sphere instead of an arrow.
const NEAR_ZERO_VEL_AVG = 0.5;

// 3D timeline curves are coloured by the point's cumulative settlement (mm),
// on a fixed settlement ramp; VEL_AVG colouring uses the per-orbit map ramp.
const SETTLEMENT_COLOR = {
  by: 'settlement',
  domain: [-25, 25],
  palette: POLAKY_SETTLEMENT_COLORS,
};

// Missing / non-finite VEL_AVG keeps the arrow behaviour.
function isNearZeroVelAvg(feature) {
  const raw = feature?.properties?.VEL_AVG;
  if (raw == null || raw === '') return false;
  const value = Number(raw);
  return Number.isFinite(value) && Math.abs(value) <= NEAR_ZERO_VEL_AVG;
}

// Numeric GeoJSON properties that identify/join features or carry generic
// index/descriptive statistics rather than measurements; keep them out of the
// chart's axis/colour/size pickers.
const NON_CHART_ATTRIBUTE_KEYS = new Set([
  'ID',
  'id_pp',
  'index_right',
  'index_righ',
  '__index_level_0__',
  '_count',
  '_max',
  '_median',
  '_min',
  '_range',
]);

// Shared cyan for every "selected" or hovered highlight on the map.
const SELECTION_COLOR = [66, 212, 244];
// Chart hover highlight, matching the chart's own red point highlight.
const CHART_HOVER_COLOR = [255, 0, 0, 255];

// Shared chrome for the map's floating cards (track selector, legend, status).
// Opaque white on purpose: the map must not show through the controls.
const OVERLAY_CARD_STYLE = {
  position: 'absolute',
  zIndex: 10,
  padding: '8px 10px',
  background: '#fff',
  border: '1px solid #ddd',
  borderRadius: '6px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
  color: '#333',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '11px',
};

// Card headings match the 11px/600 label size used across the chart cards.
const OVERLAY_TITLE_STYLE = {
  marginBottom: '4px',
  fontSize: '11px',
  fontWeight: 600,
};

// The shared chart header renders `title` inside a 13px <strong>; wrapping the
// text keeps the v2 chart headline at the same 11px/600 size as the other
// card titles without editing the shared chart module.
const CHART_TITLE_STYLE = {
  fontSize: '11px',
  fontWeight: 600,
};

// Mirrors the 3D chart's Timeline/Custom toggle highlight.
function trackButtonStyle(active, failed = false) {
  return {
    minHeight: '24px',
    padding: '4px 8px',
    border: `1px solid ${failed ? '#a00000' : active ? '#0066cc' : '#ccc'}`,
    borderRadius: '4px',
    background: active ? '#e6f0ff' : '#fff',
    color: failed ? '#a00000' : '#333',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: active ? 600 : 400,
  };
}

const INITIAL_VIEW_STATE = {
  longitude: 13.3607,
  latitude: 50.33776,
  zoom: 15,
  pitch: 50,
  bearing: 0,
  minZoom: 8,
  maxZoom: 18,
  maxPitch: 70,
};

const TERRAIN_OPTIONS = {
  type: 'terrain',
  useChannel: 1,
  noDataValue: 0,
  disableLighting: true,
  useSingleColor: true,
  color: [200, 200, 200, 255],
};

// InSAR arrows are anchored on the displayed orthometric terrain (EL-GRID) and
// lifted by H_REF, the point height above the local ground surface. The
// ellipsoidal H stays available to the chart and tooltip but no longer drives
// z. TerrainExtension offset mode adds the terrain height under the anchor, so
// the arrow centre renders at terrain + H_REF; the builder still adds the small
// per-feature vector raise on top.
function getPointElevation(feature) {
  const hRef = feature?.properties?.H_REF;
  if (hRef != null && hRef !== '') {
    const value = Number(hRef);
    if (Number.isFinite(value)) return value;
  }
  // Legacy fallback for datasets without H_REF. On the current data H - H_dem
  // is ~2.5 m lower than the real H_REF, so use it only as a last resort.
  const h = Number(feature?.properties?.H);
  const hDem = Number(feature?.properties?.H_dem);
  if (Number.isFinite(h) && Number.isFinite(hDem)) return h - hDem;
  return 0;
}

// GeoJSON height is the real tower height in metres, so it is used to scale the
// native-size OBJ; features without a height fall back to their type mean.
function getPylonHeight(feature) {
  const height = Number(feature?.properties?.height);
  return Number.isFinite(height) && height > 0 ? height : null;
}

// Hit volume radius: wide enough to cover the lattice legs plus a small margin,
// scaled with the tower so tall pylons stay proportionate.
function getPylonHitRadius(height) {
  return Math.max(PYLON_HIT_RADIUS_MIN_M, height * PYLON_HIT_RADIUS_FACTOR);
}

// Per-feature azimuth from the GeoJSON, normalised to 0-360; only features
// missing the value fall back to the default bearing.
function getPylonAzimuth(feature) {
  const raw = feature?.properties?.azimuth;
  if (raw === null || raw === undefined || raw === '') return PYLON_DEFAULT_AZIMUTH;
  const azimuth = Number(raw);
  return Number.isFinite(azimuth) ? ((azimuth % 360) + 360) % 360 : PYLON_DEFAULT_AZIMUTH;
}

// deck.gl orientation is [pitch, yaw, roll] in degrees, so the compass bearing
// only drives yaw.
function getPylonOrientation(feature) {
  return [0, 90 - getPylonAzimuth(feature) + PYLON_OBJ_YAW_OFFSET, 0];
}

function getRgba(feature, scale) {
  // chroma 2.x scales extrapolate outside the domain; clamp so stations past
  // the ramp endpoints stay on them instead of producing bad channels.
  const value = Number(feature?.properties?.VEL_AVG ?? 0);
  const [min, max] = POLAKY_VEL_AVG_DOMAIN;
  const clamped = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : 0;
  const [r, g, b] = scale(clamped).rgb();
  return [r, g, b, 255];
}

function formatNumber(value, digits) {
  // Number(null) is 0, so reject empty values before coercing: a missing
  // attribute must read as "no data", not as a real zero.
  if (value == null || value === '') return '–';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

// Signed millimetre value, e.g. `-3.50` / `+0.42`. An explicit sign keeps ΔE/ΔU
// direction readable at a glance.
function formatSignedMm(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatDateMs(ms) {
  if (!Number.isFinite(ms)) return '–';
  return new Date(ms).toISOString().slice(0, 10);
}

function withAlpha(rgb, alpha) {
  return [rgb[0], rgb[1], rgb[2], alpha];
}

export default function PolakyHradecV3() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();
  const [activeTrackId, setActiveTrackId] = useState(DEFAULT_TRACK_ID);
  // Per-track cache: id -> { status: 'loading' | 'ready' | 'error', features, error }.
  // Only the active entry is read, so a late response for another track can
  // never repaint the visible map.
  const [tracks, setTracks] = useState({});
  // In-flight fetches live in a ref so deduping does not trigger renders.
  const inFlight = useRef(new Map());
  const [pylonFeatures, setPylonFeatures] = useState([]);
  // Pylons load independently of the points; the default selection waits for
  // both loaders to settle so the pylon chart never flashes its empty hint.
  const [pylonsLoaded, setPylonsLoaded] = useState(false);
  // Selected point (arrow click → 2D timeline) and selected pylon (pylon click
  // → grouped 3D feature chart) are independent and can both stay open.
  const [selectedId, setSelectedId] = useState(null);
  const [selectedPylonKey, setSelectedPylonKey] = useState(null);
  const [hoveredPointId, setHoveredPointId] = useState(null);
  // Hover on the map itself, separate from the 3D chart's hover.
  const [hoveredSphereId, setHoveredSphereId] = useState(null);
  const [hoveredPylonKey, setHoveredPylonKey] = useState(null);
  // Drive the 3D arrow size band; the map still starts from INITIAL_VIEW_STATE.
  const [zoom, setZoom] = useState(INITIAL_VIEW_STATE.zoom);
  // Defaults apply once per mount: a user who clears a card must not have it
  // reopened by a later effect run.
  const didApplyDefaultSelection = useRef(false);

  // ---- Multi-track rig -----------------------------------------------------
  // The rig has its own eager loader; the point-cloud state machine above is
  // untouched. `rigTracks` holds the three raw feature lists, `rigStore` the
  // joined per-pylon index built once the pylons have loaded.
  const [rigMode, setRigMode] = useState(RIG_OFF);
  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [scaleMPerMm, setScaleMPerMm] = useState(DEFAULT_SCALE_M_PER_MM);
  const [rigTracks, setRigTracks] = useState(null);
  const [terrainElevations, setTerrainElevations] = useState(null);
  const [hoveredFin, setHoveredFin] = useState(false);
  // Controlled view state. deck.gl 9.4 removed `Deck.flyTo`, so camera moves are
  // expressed as a view-state update carrying a transition interpolator — the
  // same mechanism the controller uses, and it cannot throw on a missing ref.
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const previousRigMode = useRef(RIG_OFF);
  // `?debugRig=1` prints the plan's acceptance gates; any other route ignores it.
  const debugRig = useMemo(
    () => new URLSearchParams(window.location.search).get('debugRig') === '1',
    [],
  );

  const activeTrack = TRACKS.find(t => t.id === activeTrackId) ?? TRACKS[0];
  const trackState = tracks[activeTrackId];
  // EMPTY keeps the downstream memo inputs stable while a track is loading.
  const features = trackState?.status === 'ready' ? trackState.features : EMPTY;
  const isLoading = !trackState
    || (trackState.status !== 'ready' && trackState.status !== 'error');
  const error = trackState?.status === 'error' ? trackState.error : null;
  // Active-track ramp: descending tracks invert the ascending one.
  const colorScale = activeTrack.orbit === 'D'
    ? DESCENDING_VEL_AVG_SCALE
    : ASCENDING_VEL_AVG_SCALE;
  // Same per-orbit ramp for the chart's VEL_AVG colouring, so it matches the
  // map symbols and legend. Settlement colouring uses its own fixed ramp.
  const velAvgPalette = getPolakyVelAvgColors(activeTrack.orbit);

  // Fetch a track once and cache it; later switches are instant. The cache is
  // cleared on failure so the selector's retry starts a fresh request.
  const loadTrack = useCallback((id) => {
    const track = TRACKS.find(t => t.id === id);
    if (!track || inFlight.current.has(id)) return;

    setTracks(prev => (prev[id]?.status === 'ready'
      ? prev
      : { ...prev, [id]: { status: 'loading', features: null, error: null } }));

    const controller = new AbortController();
    const promise = (async () => {
      try {
        const res = await fetch(track.url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${track.url}`);
        const data = await res.json();
        const loaded = Array.isArray(data) ? data : (data.features || []);
        if (controller.signal.aborted) return;
        setTracks(prev => ({
          ...prev,
          [id]: { status: 'ready', features: loaded, error: null },
        }));
      } catch (err) {
        // Unmount aborts in flight; not a track failure and no state to update.
        if (controller.signal.aborted) return;
        console.error(`❌ Failed to load Poláky data for track ${id}:`, err);
        setTracks(prev => ({
          ...prev,
          [id]: { status: 'error', features: null, error: err.message || String(err) },
        }));
      } finally {
        inFlight.current.delete(id);
      }
    })();

    inFlight.current.set(id, { promise, controller });
  }, []);

  useEffect(() => {
    loadTrack(DEFAULT_TRACK_ID);
  }, [loadTrack]);

  // Abort any pending track request when the map unmounts.
  useEffect(() => () => {
    for (const { controller } of inFlight.current.values()) controller.abort();
    inFlight.current.clear();
  }, []);

  // A point belongs to exactly one track, so its highlight and timeline close on
  // switch. Pylons are track-independent, so the pylon chart stays open and
  // re-renders with that pylon's points in the new track.
  const handleSelectTrack = useCallback((id) => {
    if (id === activeTrackId) {
      // An already-active, failed track is retried by clicking it again.
      if (tracks[id]?.status === 'error') loadTrack(id);
      return;
    }
    setActiveTrackId(id);
    setSelectedId(null);
    setHoveredPointId(null);
    setHoveredSphereId(null);
    if (tracks[id]?.status !== 'ready') loadTrack(id);
  }, [activeTrackId, tracks, loadTrack]);

  // Pylons are decorative: a failure here must not raise the map-level error
  // banner, because the InSAR visualisation still works without them.
  useEffect(() => {
    let cancelled = false;

    const loadPylons = async () => {
      try {
        const res = await fetch(PYLONS_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${PYLONS_URL}`);
        const data = await res.json();
        const loaded = Array.isArray(data) ? data : (data.features || []);
        if (!cancelled) setPylonFeatures(loaded);
      } catch (err) {
        console.error('❌ Failed to load Poláky pylons:', err);
      } finally {
        // Also on failure: the point default must not wait on decorative data.
        if (!cancelled) setPylonsLoaded(true);
      }
    };

    loadPylons();
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the default pylon chart and point timeline once, after both datasets
  // have settled. Both setters run in the same pass so React 18 batches them
  // into one render and the panel mounts straight into its two-card layout.
  useEffect(() => {
    if (isLoading || !pylonsLoaded || didApplyDefaultSelection.current) return;
    // Set the guard before the setters: a re-render caused by these updates
    // must not re-enter and clobber a very fast user click.
    didApplyDefaultSelection.current = true;
    const pylon = pylonFeatures.find(f => Number(f?.properties?.id) === DEFAULT_PYLON_ID);
    const pylonKey = pylon ? getPylonJoinKey(pylon) : null;
    const point = features.find(f => String(f?.properties?.ID) === String(DEFAULT_POINT_ID));
    // A missing pylon or point is skipped silently; the other default still applies.
    if (pylonKey != null) setSelectedPylonKey(pylonKey);
    if (point) setSelectedId(point.properties.ID);
  }, [features, isLoading, pylonFeatures, pylonsLoaded]);

  // Eager three-track load: one abortable request per track. A failure only
  // disables the rig (the rig card reports it); the point cloud keeps working.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const featuresByTrack = await loadRigTracks(controller.signal);
        if (controller.signal.aborted) return;
        setRigTracks({ status: 'ready', featuresByTrack, error: null });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('❌ Failed to load Poláky rig tracks:', err);
        setRigTracks({ status: 'error', featuresByTrack: null, error: err.message || String(err) });
      }
    })();
    return () => controller.abort();
  }, []);

  // One COG terrain sample per tower, in parallel with the track load. This is
  // the rig's z anchor (see `terrainElevation.js` for why it is not `_median`).
  useEffect(() => {
    if (!pylonsLoaded || pylonFeatures.length === 0) return undefined;
    const points = [];
    for (const feature of pylonFeatures) {
      const key = getPylonJoinKey(feature);
      const coordinates = feature?.geometry?.coordinates;
      if (key == null || !Array.isArray(coordinates)) continue;
      points.push({ key, lon: coordinates[0], lat: coordinates[1] });
    }
    if (points.length === 0) return undefined;

    const controller = new AbortController();
    sampleTerrainElevations(points, controller.signal)
      .then((elevations) => {
        if (controller.signal.aborted) return;
        setTerrainElevations(elevations);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('❌ Failed to sample Poláky terrain elevations:', err);
        setTerrainElevations(new Map());
      });
    return () => controller.abort();
  }, [pylonsLoaded, pylonFeatures]);

  // Join the three tracks to the pylons once both loads have settled. Pure and
  // cheap (18 towers), so it can be a memo rather than extra state.
  const rigStore = useMemo(() => {
    if (rigTracks?.status !== 'ready' || !pylonsLoaded || pylonFeatures.length === 0) return null;
    return buildRigStore({
      pylonFeatures,
      featuresByTrack: rigTracks.featuresByTrack,
      terrainElevations,
    });
  }, [rigTracks, pylonsLoaded, pylonFeatures, terrainElevations]);

  const rigReady = rigStore != null;
  const rigEnabled = rigMode !== RIG_OFF;
  const rigStatusLabel = rigTracks?.status === 'error'
    ? `tracks unavailable (${rigTracks.error})`
    : rigReady
      ? `${TRACK_IDS.length} tracks · ${rigStore.pylons.size} towers`
        + (terrainElevations ? '' : ' · terrain…')
      : 'loading tracks…';

  // Join-distance and incidence warnings from the store, reported once per build.
  useEffect(() => {
    if (!rigStore || rigStore.warnings.length === 0) return;
    console.warn('[rig] data warnings:', ...rigStore.warnings);
  }, [rigStore]);

  const focusedPylon = useMemo(() => {
    if (selectedPylonKey == null || !rigStore) return null;
    return rigStore.pylons.get(selectedPylonKey) ?? null;
  }, [rigStore, selectedPylonKey]);

  // Fins for the focused tower: three tracks × three bands, all smoothed on the
  // same union grid and then resampled to `FIN_SAMPLE_COUNT` display vertices.
  // Only this one tower is drawn as ribbons — 9 at most, never 18.
  const finData = useMemo(() => {
    const empty = {
      walls: EMPTY,
      solid: EMPTY,
      dashed: EMPTY,
      baselines: EMPTY,
      collars: EMPTY,
      anchors: EMPTY,
    };
    if (!rigEnabled || !focusedPylon || !rigStore) return empty;
    const base = focusedPylon.terrainElevation;
    if (!Number.isFinite(base)) return empty;

    const walls = [];
    const solid = [];
    const dashed = [];
    const baselines = [];
    const anchors = [];

    for (const trackId of TRACK_IDS) {
      const color = FIN_TRACK_COLORS[trackId];
      const fill = withAlpha(color, RIG_FIN_FILL_ALPHA);
      const stroke = withAlpha(color, RIG_FIN_STROKE_ALPHA);
      const isDashed = trackId === DASHED_TRACK_ID;
      const curves = isDashed ? dashed : solid;

      for (let band = 0; band < focusedPylon.bandZ.length; band++) {
        const scatterers = focusedPylon.bands[trackId][band];
        if (scatterers.length === 0) continue;

        // Smooth on the union grid first, then resample: the other order would
        // re-weight the samples inside each window.
        const dense = bandMedianSeries(scatterers, windowDays, rigStore.grid);
        const display = resampleSeries(dense, rigStore.grid, FIN_SAMPLE_COUNT);
        const laneOffsetM = trackId === '95D'
          ? 0
          : (trackId === '44A' ? -LANE_OFFSET_M / 2 : LANE_OFFSET_M / 2);

        const geometry = buildFinGeometry({
          series: display.series,
          grid: display.grid,
          side: TRACK_FIN_SIDE[trackId],
          laneOffsetM,
          bandZ: focusedPylon.bandZ[band],
          bandIndex: band,
          trackId,
          scaleMPerMm,
          pylon: focusedPylon,
          base,
        });

        for (const quad of geometry.quads) {
          walls.push({
            ...quad,
            count: scatterers.length,
            pylonId: focusedPylon.id,
            pylonKey: focusedPylon.key,
            fillColor: fill,
          });
        }
        for (const path of geometry.curve) {
          curves.push({ path, color: stroke });
          // Terminal nodes: a crisp start (first epoch) and end (last epoch) on
          // every visible run, in the full track colour.
          if (path.length > 0) {
            anchors.push({ position: path[0], color: stroke });
            anchors.push({ position: path[path.length - 1], color: stroke });
          }
        }
        for (const path of geometry.baseline) baselines.push({ path });
      }
    }

    const collars = buildBandCollars({
      pylon: focusedPylon,
      base,
      bandZ: focusedPylon.bandZ,
      radiusM: BAND_COLLAR_RADIUS_M,
      segments: BAND_COLLAR_SEGMENTS,
    });

    return { walls, solid, dashed, baselines, collars, anchors };
  }, [rigEnabled, focusedPylon, rigStore, windowDays, scaleMPerMm]);

  // Per-band ΔU/ΔE for every tower. The focused tower shows the numbers in the
  // badge; all towers share the same vectors, so the compact arrows and the
  // badge can never disagree.
  const bandSolutions = useMemo(() => {
    if (!rigEnabled || !rigStore || !rigStore.commonEpochMs) return EMPTY;

    const out = [];
    for (const pylon of rigStore.pylons.values()) {
      for (let band = 0; band < pylon.bandZ.length; band++) {
        const weights = {};
        const fields = {};
        for (const trackId of TRACK_IDS) {
          weights[trackId] = pylon.nByBandTrack[trackId][band];
          fields[trackId] = bandMedianAt(
            pylon.bands[trackId][band],
            rigStore.commonEpochMs,
            windowDays,
          );
        }
        out.push({
          pylonKey: pylon.key,
          pylonId: pylon.id,
          band,
          bandZ: pylon.bandZ[band],
          counts: weights,
          solution: solveBand({
            d95: fields['95D'],
            d44: fields['44A'],
            d146: fields['146A'],
            inc: rigStore.incidence,
            weights,
          }),
        });
      }
    }
    return out;
  }, [rigEnabled, rigStore, windowDays]);

  const focusedBandSolutions = useMemo(() => {
    if (!focusedPylon) return EMPTY;
    return bandSolutions.filter(entry => entry.pylonKey === focusedPylon.key);
  }, [bandSolutions, focusedPylon]);

  // Arrow shafts and heads, only for the focused and hovered tower. Drawing all
  // 54 band vectors put a pale cone on every neighbour's cross-arms and buried
  // the one vector being read.
  const rigVectors = useMemo(() => {
    if (rigMode !== RIG_FINS_VECTORS || !rigStore) return { shafts: EMPTY, heads: EMPTY };
    if (selectedPylonKey == null && hoveredPylonKey == null) return { shafts: EMPTY, heads: EMPTY };

    const shafts = [];
    const heads = [];

    for (const entry of bandSolutions) {
      if (entry.pylonKey !== selectedPylonKey && entry.pylonKey !== hoveredPylonKey) continue;
      const { solution } = entry;
      if (!solution.ok || !Number.isFinite(solution.dE) || !Number.isFinite(solution.dU)) continue;
      const pylon = rigStore.pylons.get(entry.pylonKey);
      if (!pylon || !Number.isFinite(pylon.terrainElevation)) continue;

      const east = solution.dE * scaleMPerMm;
      const up = solution.dU * scaleMPerMm;
      const length = Math.hypot(east, up);
      if (length < 0.05) continue;

      const z0 = pylon.terrainElevation + entry.bandZ;
      const mPerDegLon = metresPerDegLon(pylon.lat);
      const unitEast = east / length;
      const unitUp = up / length;
      const orientation = coneOrientation(east, up);

      // Shaft and head split the same vector: the rod runs from the tower axis to
      // the head base, the cone covers the last `headLength` metres.
      const headLength = Math.min(2.2, Math.max(0.8, length * 0.28), length);
      const headRadius = headLength * 0.22;
      const shaftLength = Math.max(0.2, length - headLength);

      shafts.push({
        pylonKey: entry.pylonKey,
        position: [
          pylon.lon + ((unitEast * shaftLength) / 2) / mPerDegLon,
          pylon.lat,
          z0 + (unitUp * shaftLength) / 2,
        ],
        orientation,
        scale: [RIG_SHAFT_RADIUS, RIG_SHAFT_RADIUS, shaftLength],
      });
      heads.push({
        pylonKey: entry.pylonKey,
        position: [
          pylon.lon + ((east - unitEast * (headLength / 2)) / mPerDegLon),
          pylon.lat,
          z0 + up - unitUp * (headLength / 2),
        ],
        orientation,
        scale: [headRadius, headRadius, headLength],
      });
    }

    return { shafts, heads };
  }, [rigMode, bandSolutions, rigStore, scaleMPerMm, selectedPylonKey, hoveredPylonKey]);

  // One controlled-view-state sink for every camera change, interactions
  // included. Transition props are one-shot: they must not be stored, or the
  // next render would replay the flight and freeze drag input.
  const handleViewStateChange = useCallback(({ viewState: next }) => {
    const plain = {
      ...next,
      // Keep the map constraints from INITIAL_VIEW_STATE: in controlled mode the
      // controller only sees what the app hands back.
      minZoom: INITIAL_VIEW_STATE.minZoom,
      maxZoom: INITIAL_VIEW_STATE.maxZoom,
      maxPitch: INITIAL_VIEW_STATE.maxPitch,
    };
    delete plain.transitionDuration;
    delete plain.transitionInterpolator;
    delete plain.transitionEasing;
    delete plain.transitionInterruption;
    setViewState(plain);
    setZoom(plain.zoom);
  }, []);

  // Auto-zoom to the focused tower the first time the rig is switched on; later
  // window/scale changes must not move the camera.
  useEffect(() => {
    const wasOff = previousRigMode.current === RIG_OFF;
    previousRigMode.current = rigMode;
    if (!wasOff || rigMode === RIG_OFF || !focusedPylon) return;
    setViewState(prev => ({
      ...prev,
      longitude: focusedPylon.lon,
      latitude: focusedPylon.lat,
      zoom: RIG_FOCUS_ZOOM,
      pitch: 45,
      bearing: 0,
      transitionDuration: 900,
      transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }),
    }));
  }, [rigMode, focusedPylon]);

  // `?debugRig=1` acceptance gates (tasks 2–4). Re-runs on window/scale change so
  // the printed fin numbers follow the controls.
  useEffect(() => {
    if (!debugRig || !rigStore) return;
    logRigDebug({ store: rigStore, windowDays, scaleMPerMm });
  }, [debugRig, rigStore, windowDays, scaleMPerMm]);

  // Clicking a fin wall switches to that fin's track, focuses its pylon and opens
  // the timeline of the band's median scatterer. The pylon chart stays
  // single-track, as the shared chart keys points on `ID`.
  const handleFinClick = useCallback((quad) => {
    if (!quad || !rigStore) return;
    const pylon = rigStore.pylons.get(quad.pylonKey);
    if (!pylon) return;

    if (quad.trackId !== activeTrackId) {
      setActiveTrackId(quad.trackId);
      setHoveredPointId(null);
      setHoveredSphereId(null);
      if (tracks[quad.trackId]?.status !== 'ready') loadTrack(quad.trackId);
    }
    setSelectedPylonKey(quad.pylonKey);
    const scatterer = medianScatterer(
      pylon.bands[quad.trackId]?.[quad.bandIndex] ?? EMPTY,
      quad.dateMs,
      windowDays,
    );
    if (scatterer) setSelectedId(scatterer.properties.ID);
  }, [rigStore, activeTrackId, tracks, loadTrack, windowDays]);

  const pylonGroups = useMemo(() => {
    const groups = { kocka: [], dunaj: [], portal: [] };
    const heightSums = { kocka: 0, dunaj: 0, portal: 0 };
    const heightCounts = { kocka: 0, dunaj: 0, portal: 0 };
    let skipped = 0;
    for (const f of pylonFeatures) {
      const typ = f?.properties?.typ;
      if (!groups[typ]) {
        skipped++;
        continue;
      }
      groups[typ].push(f);
      const height = getPylonHeight(f);
      if (height != null) {
        heightSums[typ] += height;
        heightCounts[typ] += 1;
      }
    }
    if (skipped) console.warn(`Skipped ${skipped} pylon feature(s) with unknown typ`);
    // Mean of the features that do carry a height, for those that do not.
    const meanHeight = {};
    for (const typ of Object.keys(groups)) {
      meanHeight[typ] = heightCounts[typ] ? heightSums[typ] / heightCounts[typ] : null;
    }
    return { groups, meanHeight };
  }, [pylonFeatures]);

  // Per-pylon pick targets: the feature plus the height and radius its hit
  // volume needs. Height falls back GeoJSON -> type mean -> OBJ native height so
  // features with no height still get a correctly sized cylinder.
  const pylonHitData = useMemo(() => {
    const items = [];
    for (const feature of pylonFeatures) {
      const typ = feature?.properties?.typ;
      const model = PYLON_MODELS.find(m => m.typ === typ);
      if (!model) continue;
      const height = getPylonHeight(feature) ?? pylonGroups.meanHeight[typ] ?? model.nativeHeight;
      if (!Number.isFinite(height) || height <= 0) continue;
      items.push({ feature, height, radius: getPylonHitRadius(height) });
    }
    return items;
  }, [pylonFeatures, pylonGroups]);

  const selectedFeature = useMemo(() => {
    if (selectedId == null) return null;
    return features.find(f => String(f.properties?.ID) === String(selectedId)) ?? null;
  }, [features, selectedId]);

  // Attributes offered by the 3D chart: the geometry-derived position, then
  // every numeric GeoJSON property except LON/LAT (duplicates of the geometry),
  // feature IDs/join keys, and the flat `d_YYYYMMDD` displacement timeline.
  const chartAttributeKeys = useMemo(() => {
    const keys = new Set();
    for (const feature of features) {
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        if (key === 'LON' || key === 'LAT') continue;
        if (NON_CHART_ATTRIBUTE_KEYS.has(key)) continue;
        if (!isTimelineKey(key) && typeof value === 'number' && Number.isFinite(value)) {
          keys.add(key);
        }
      }
    }
    return ['lon', 'lat', ...[...keys].sort()];
  }, [features]);

  // InSAR points grouped by their pylon join key (`index_right`).
  const pointsByPylonKey = useMemo(() => {
    const map = new Map();
    for (const feature of features) {
      const key = getPointJoinKey(feature);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(feature);
    }
    return map;
  }, [features]);

  const selectedPylonPoints = useMemo(
    () => (selectedPylonKey ? pointsByPylonKey.get(selectedPylonKey) ?? EMPTY : EMPTY),
    [pointsByPylonKey, selectedPylonKey],
  );

  const selectedPylon = useMemo(() => {
    if (selectedPylonKey == null) return null;
    return pylonFeatures.find(f => getPylonJoinKey(f) === selectedPylonKey) ?? null;
  }, [pylonFeatures, selectedPylonKey]);

  // Chart input for the selected pylon, in the shape the chart already expects
  // (with `point_id`, mirroring the old drawing selection).
  const pylonFeatureCollection = useMemo(() => {
    if (selectedPylonKey == null) return null;
    return {
      type: 'FeatureCollection',
      features: selectedPylonPoints.map(feature => ({
        type: 'Feature',
        id: feature.properties?.ID ?? null,
        geometry: feature.geometry,
        properties: {
          ...feature.properties,
          point_id: feature.properties?.ID ?? null,
        },
      })),
    };
  }, [selectedPylonKey, selectedPylonPoints]);

  // Only re-render when the hovered object actually changes.
  const handleHover = useCallback((info) => {
    const layerId = info.layer?.id ?? '';
    const nextPylonKey = layerId.startsWith('pylons-')
      ? getPylonJoinKey(getPylonPickFeature(info.object))
      : null;
    const nextSphereId = layerId.startsWith(POINT_LAYER_PREFIX)
      ? (info.object?.properties?.ID ?? null)
      : null;
    // Fin walls are quad pick targets; the cursor mirrors that without
    // touching the pylon/sphere hover state.
    const nextFin = layerId === RIG_FIN_WALL_LAYER;
    setHoveredPylonKey(prev => (prev === nextPylonKey ? prev : nextPylonKey));
    setHoveredSphereId(prev => (prev === nextSphereId ? prev : nextSphereId));
    setHoveredFin(prev => (prev === nextFin ? prev : nextFin));
  }, []);

  // With the rig on, the focused tower's own point cloud is hidden: 40+ bright
  // symbols bury the lattice, the band collars and the ΔU/ΔE vectors. Other
  // towers keep their normal symbols, and both charts read `features`, so the
  // pylon chart and the timeline are unaffected.
  const hiddenPointKey = rigEnabled ? selectedPylonKey : null;

  // Split once per data load: near-zero points become spheres, everything else
  // (including missing VEL_AVG) keeps the 3D arrow composite.
  const { arrowFeatures, sphereFeatures } = useMemo(() => {
    const arrows = [];
    const spheres = [];
    for (const feature of features) {
      if (hiddenPointKey != null && getPointJoinKey(feature) === hiddenPointKey) continue;
      (isNearZeroVelAvg(feature) ? spheres : arrows).push(feature);
    }
    return { arrowFeatures: arrows, sphereFeatures: spheres };
  }, [features, hiddenPointKey]);

  const layers = useMemo(() => {
    const terrainLayer = new CogTerrainLayer({
      id: 'terrain-elevation',
      elevationData: TERRAIN_URL,
      isTiled: true,
      tileSize: 256,
      minZoom: 10,
      maxZoom: 15,
      operation: 'terrain+draw',
      onZRangeUpdate,
      pickable: false,
      terrainOptions: TERRAIN_OPTIONS,
    });

    // zRange keeps the draped tiles from being frustum-culled in tilted views.
    const satelliteLayer = new TileLayer({
      id: 'satellite-base',
      data: SATELLITE_TILE_URL,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      zRange,
      extensions: [new TerrainExtension()],
      renderSubLayers: (props) => {
        const { west, south, east, north } = props.tile.bbox;
        return new BitmapLayer(props, {
          data: undefined,
          image: props.data,
          bounds: [west, south, east, north],
          // Cool and dim the imagery slightly while the rig is on so the ribbons,
          // collars and vectors keep their contrast against daylight satellite.
          tintColor: rigEnabled ? [175, 182, 195] : [255, 255, 255],
          updateTriggers: { tintColor: [rigEnabled] },
        });
      },
    });

    // One layer per pylon type: SimpleMeshLayer takes a single mesh, so the typ
    // has to be expressed as separate layers with stable ids and mesh URLs.
    // Anchoring at z=0 lets TerrainExtension offset mode snap the base to the
    // COG terrain height map written by the terrain layer above.
    const pylonLayers = PYLON_MODELS.map(({ typ, nativeHeight, mesh }) => {
      const fallbackHeight = pylonGroups.meanHeight[typ] ?? nativeHeight;
      return new SimpleMeshLayer({
        id: `pylons-${typ}`,
        data: pylonGroups.groups[typ],
        mesh,
        loaders: [OBJLoader],
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], 0],
        // Scale the native-size OBJ up to the tower's real height.
        getScale: (d) => {
          const s = (getPylonHeight(d) ?? fallbackHeight) / nativeHeight;
          return [s, s, s];
        },
        // Bearing-driven yaw: per-feature `azimuth`, default otherwise.
        getOrientation: getPylonOrientation,
        getColor: (d) => {
          const key = getPylonJoinKey(d);
          const highlighted = key != null
            && (key === selectedPylonKey || key === hoveredPylonKey);
          return highlighted ? [...SELECTION_COLOR, 255] : PYLON_COLOR;
        },
        updateTriggers: { getColor: [selectedPylonKey, hoveredPylonKey] },
        material: { ambient: 0.42, diffuse: 0.65, shininess: 24, specularColor: [60, 64, 70] },
        extensions: [new TerrainExtension()],
        terrainDrawMode: 'offset',
        pickable: true,
      });
    });

    // Invisible pick target per pylon: one solid cylinder covering the tower
    // footprint and full height, so clicks/hover land anywhere on the silhouette
    // instead of only on the steel triangles.
    const pylonHitLayer = new SimpleMeshLayer({
      id: 'pylons-hitbox',
      data: pylonHitData,
      mesh: PYLON_HIT_MESH,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      // Geometry spans z = -0.5..0.5, so lifting by height / 2 puts the base at
      // 0 and the top at `height`; TerrainExtension offset adds the ground height.
      getPosition: (d) => [
        d.feature.geometry.coordinates[0],
        d.feature.geometry.coordinates[1],
        d.height / 2,
      ],
      getScale: (d) => [d.radius, d.radius, d.height],
      getOrientation: () => [0, 0, 0],
      // Invisible in the color pass; still drawn into the picking buffer, because
      // picking colors are encoded independently of getColor's alpha.
      getColor: () => [0, 0, 0, 0],
      // Picked normally (terrain still occludes it) but never writes depth, so the
      // arrow layers drawn afterwards overwrite its pick pixels wherever an
      // arrow renders and keep click priority.
      parameters: { depthWriteEnabled: false },
      extensions: [new TerrainExtension()],
      terrainDrawMode: 'offset',
      pickable: true,
    });

    // Shared point-symbol accessor: chart hover paints red, a direct selection
    // or map hover keeps the cyan highlight, otherwise the VEL_AVG ramp. Arrows
    // and spheres use it so highlight behaviour stays identical.
    const getPointSymbolColor = (d) => {
      const id = d.properties?.ID;
      if (hoveredPointId != null && String(id) === String(hoveredPointId)) {
        return CHART_HOVER_COLOR;
      }
      const isHighlighted = [selectedId, hoveredSphereId].some(
        other => other != null && String(id) === String(other),
      );
      return isHighlighted ? [...SELECTION_COLOR, 255] : getRgba(d, colorScale);
    };
    const colorUpdateTriggers = {
      getColor: [selectedId, hoveredSphereId, hoveredPointId],
    };
    const getAnchorPosition = (d) => [
      d.geometry.coordinates[0],
      d.geometry.coordinates[1],
      getPointElevation(d),
    ];

    // Non-near-zero points render as the 3D LOS round-cap arrow composite (rear
    // cap, body, two wing rods, two wing-tip caps, arrow tip). The accessor is
    // shared by all seven parts, so the pylon-linked selection highlight applies
    // to the whole composite too.
    const arrowLayers = build3dLosArrowLayers({
      idPrefix: POINT_LAYER_PREFIX,
      data: arrowFeatures,
      zoom,
      orbit: activeTrack.orbit,
      pickable: true,
      getPosition: getAnchorPosition,
      // Offset mode shifts every part by the terrain height sampled under its
      // anchor, keeping the composite rigid while grounding it.
      extensions: [new TerrainExtension()],
      terrainDrawMode: 'offset',
      getColor: getPointSymbolColor,
      updateTriggers: colorUpdateTriggers,
    });

    // |VEL_AVG| <= 0.5 renders as a sphere instead; same anchor and colour
    // accessor, and the builder lifts it by its own radius.
    const sphereLayer = build3dLosSphereLayer({
      id: `${POINT_LAYER_PREFIX}-spheres`,
      data: sphereFeatures,
      zoom,
      radiusMeters: 1.6,
      pickable: true,
      getPosition: getAnchorPosition,
      extensions: [new TerrainExtension()],
      terrainDrawMode: 'offset',
      getColor: getPointSymbolColor,
      updateTriggers: colorUpdateTriggers,
    });

    // ---- Multi-track rig ---------------------------------------------------
    // Fin walls are vertical quads: `_normalize: false` keeps them planar,
    // `_full3d: true` lets earcut tessellate them (a vertical quad is degenerate
    // in XY, so without it no triangles are emitted and the wall is invisible),
    // and the explicit `.flat()` is what `_normalize: false` requires.
    const rigLayers = [];

    // Task 2's z-anchor gate, made reproducible: with `?debugRig=1` the focused
    // tower gets one 1 m marker per band at `terrainAtPylon + bandZ`, the same
    // absolute z the fins use, so it must land on the tower (lower third /
    // mid-shaft / cross-arms). Not rendered on a normal visit.
    if (debugRig && focusedPylon && Number.isFinite(focusedPylon.terrainElevation)) {
      rigLayers.push(new ScatterplotLayer({
        id: RIG_DEBUG_MARKER_LAYER,
        data: focusedPylon.bandZ.map((bandZ, band) => ({
          position: [
            focusedPylon.lon,
            focusedPylon.lat,
            focusedPylon.terrainElevation + bandZ,
          ],
          band,
        })),
        getPosition: (d) => d.position,
        radiusUnits: 'meters',
        getRadius: 1,
        getFillColor: (d) => (d.band === 1 ? [255, 140, 0, 220] : [255, 0, 255, 220]),
        pickable: false,
      }));
    }

    if (rigEnabled && finData.walls.length > 0) {
      rigLayers.push(new SolidPolygonLayer({
        id: RIG_FIN_WALL_LAYER,
        data: finData.walls,
        getPolygon: (d) => d.polygon.flat(),
        getFillColor: (d) => d.fillColor,
        extruded: false,
        _normalize: false,
        _full3d: true,
        pickable: true,
      }));
    }

    // Curves: two passes per track — a wide translucent halo under a crisp core —
    // so every timeline reads as a glowing glass edge. The 146A track keeps its
    // own dashed layers (dash on halo and core alike) instead of a per-feature
    // dash ternary.
    if (finData.solid.length > 0) {
      rigLayers.push(new PathLayer({
        id: RIG_FIN_SOLID_GLOW_LAYER,
        data: finData.solid,
        getPath: (d) => d.path,
        getColor: (d) => [d.color[0], d.color[1], d.color[2], RIG_CURVE_GLOW_ALPHA],
        getWidth: RIG_CURVE_GLOW_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: true,
        capRounded: true,
        pickable: false,
      }));
      rigLayers.push(new PathLayer({
        id: RIG_FIN_SOLID_LAYER,
        data: finData.solid,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: RIG_CURVE_CORE_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: true,
        capRounded: true,
        pickable: false,
      }));
    }

    if (finData.dashed.length > 0) {
      // Round joints at sub-pixel spacing turn a dashed line into a scribble; the
      // dashed ribbon uses butt joints and a coarser pattern on both passes.
      rigLayers.push(new PathLayer({
        id: RIG_FIN_DASHED_GLOW_LAYER,
        data: finData.dashed,
        getPath: (d) => d.path,
        getColor: (d) => [d.color[0], d.color[1], d.color[2], RIG_CURVE_GLOW_ALPHA],
        getWidth: RIG_CURVE_GLOW_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: false,
        capRounded: false,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: () => [10, 5],
      }));
      rigLayers.push(new PathLayer({
        id: RIG_FIN_DASHED_LAYER,
        data: finData.dashed,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        getWidth: RIG_CURVE_CORE_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: false,
        capRounded: false,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: () => [10, 5],
      }));
    }

    // 0 mm zero line: dashed white, drawn per ribbon so the reader can tell
    // above-0 from below-0 against grass.
    if (finData.baselines.length > 0) {
      rigLayers.push(new PathLayer({
        id: RIG_FIN_BASELINE_LAYER,
        data: finData.baselines,
        getPath: (d) => d.path,
        getColor: RIG_BASELINE_COLOR,
        getWidth: RIG_BASELINE_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: false,
        capRounded: false,
        pickable: false,
        extensions: [new PathStyleExtension({ dash: true })],
        getDashArray: () => RIG_BASELINE_DASH,
      }));
    }

    // Collar rings tie every ribbon to its structural band on the tower.
    if (finData.collars.length > 0) {
      rigLayers.push(new PathLayer({
        id: RIG_BAND_COLLAR_LAYER,
        data: finData.collars,
        getPath: (d) => d.path,
        getColor: RIG_COLLAR_COLOR,
        getWidth: RIG_COLLAR_WIDTH,
        widthUnits: 'pixels',
        billboard: true,
        jointRounded: true,
        capRounded: false,
        pickable: false,
      }));
    }

    // Terminal nodes: 2014 inner start and 2026 outer tip of every visible run.
    if (finData.anchors.length > 0) {
      rigLayers.push(new ScatterplotLayer({
        id: RIG_FIN_ANCHOR_LAYER,
        data: finData.anchors,
        getPosition: (d) => d.position,
        radiusUnits: 'pixels',
        getRadius: RIG_ANCHOR_RADIUS_PX,
        billboard: true,
        getFillColor: (d) => d.color,
        pickable: false,
      }));
    }

    if (rigMode === RIG_FINS_VECTORS && rigVectors.shafts.length > 0) {
      // z is the sampled ground plus the band height, so shafts and heads share
      // the fins' absolute frame (no per-vertex terrain offset).
      const vectorColor = (d) => {
        const highlighted = d.pylonKey === selectedPylonKey || d.pylonKey === hoveredPylonKey;
        return [...(highlighted ? RIG_FOCUS_VECTOR_COLOR : RIG_VECTOR_COLOR), 255];
      };
      rigLayers.push(new SimpleMeshLayer({
        id: RIG_VECTOR_SHAFT_LAYER,
        data: rigVectors.shafts,
        mesh: RIG_SHAFT_MESH,
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        getPosition: (d) => d.position,
        getOrientation: (d) => d.orientation,
        getScale: (d) => d.scale,
        getColor: vectorColor,
        material: { ambient: 0.5, diffuse: 0.6, shininess: 16, specularColor: [40, 40, 40] },
        pickable: false,
      }));
      rigLayers.push(new SimpleMeshLayer({
        id: RIG_VECTOR_HEAD_LAYER,
        data: rigVectors.heads,
        mesh: RIG_CONE_MESH,
        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
        getPosition: (d) => d.position,
        getOrientation: (d) => d.orientation,
        getScale: (d) => d.scale,
        getColor: vectorColor,
        material: { ambient: 0.5, diffuse: 0.6, shininess: 16, specularColor: [40, 40, 40] },
        pickable: false,
      }));
    }

    return [
      terrainLayer,
      satelliteLayer,
      ...pylonLayers,
      // Before the point symbols on purpose: later layers win overlapping pick
      // pixels, so arrows and spheres keep click priority over pylon hit volumes.
      pylonHitLayer,
      // The rig sits between the towers and the point symbols for the same
      // reason: point arrows keep pick priority where they overlap the fins.
      ...rigLayers,
      ...arrowLayers,
      sphereLayer,
    ];
  }, [
    zRange,
    onZRangeUpdate,
    arrowFeatures,
    sphereFeatures,
    pylonGroups,
    pylonHitData,
    zoom,
    activeTrack.orbit,
    colorScale,
    selectedId,
    hoveredPointId,
    hoveredSphereId,
    selectedPylonKey,
    hoveredPylonKey,
    rigEnabled,
    rigMode,
    finData,
    rigVectors,
    debugRig,
    focusedPylon,
  ]);

  const legendGradient = `linear-gradient(to right, ${colorScale.colors(11).join(', ')})`;

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      colorScheme: 'light',
      background: '#ffffff',
    }}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        getCursor={() => (
          hoveredPylonKey != null || hoveredSphereId != null || hoveredFin ? 'pointer' : 'grab'
        )}
        controller
        layers={layers}
        // Small tolerance so near-misses on thin steel and arrow tips still hit.
        pickingRadius={6}
        onHover={handleHover}
        onClick={(info) => {
          const layerId = info.layer?.id ?? '';
          if (layerId === RIG_FIN_WALL_LAYER) {
            handleFinClick(info.object);
            return;
          }
          if (layerId.startsWith('pylons-')) {
            const key = getPylonJoinKey(getPylonPickFeature(info.object));
            if (key == null) return;
            setHoveredPointId(null);
            setSelectedPylonKey(key);
            return;
          }
          if (layerId.startsWith(POINT_LAYER_PREFIX)) {
            setHoveredPointId(null);
            setSelectedId(info.object?.properties?.ID ?? null);
            return;
          }
          setSelectedId(null);
          setSelectedPylonKey(null);
          setHoveredPointId(null);
        }}
        getTooltip={({ object, layer }) => {
          const layerId = layer?.id ?? '';
          if (layerId === RIG_FIN_WALL_LAYER) {
            const quad = object;
            if (!quad) return null;
            return {
              text: [
                `Pylon ${quad.pylonId ?? '–'} · ${BAND_LABELS[quad.bandIndex] ?? '–'} `
                + `(${quad.count} scatterers)`,
                `${quad.trackId} · ${formatDateMs(quad.dateMs)}`,
                `Smoothed LOS: ${formatSignedMm(quad.value)} mm`,
                'LOS displacement, not vertical',
              ].join('\n'),
            };
          }
          if (layerId.startsWith('pylons-')) {
            const pickedPylon = getPylonPickFeature(object);
            const props = pickedPylon?.properties;
            if (!props) return null;
            const key = getPylonJoinKey(pickedPylon);
            const height = props.height == null || props.height === ''
              ? '–'
              : formatNumber(props.height, 1);
            return {
              text: [
                `Pylon ${props.id ?? '–'} (${props.typ ?? '–'})`,
                `Height: ${height} m`,
                `InSAR points (${activeTrack.id}): ${pointsByPylonKey.get(key)?.length ?? 0}`,
              ].join('\n'),
            };
          }
          if (layerId.startsWith(POINT_LAYER_PREFIX)) {
            const props = object?.properties;
            if (!props) return null;
            return {
              text: [
                `ID: ${props.ID ?? '–'}`,
                `Track: ${activeTrack.id} (${activeTrack.direction})`,
                `VEL_AVG: ${formatNumber(props.VEL_AVG, 2)} mm/yr`,
                `COH: ${formatNumber(props.COH, 2)}`,
                `H_REF: ${formatNumber(props.H_REF, 2)} m`,
                `H_dem: ${formatNumber(props.H_dem, 1)} m`,
              ].join('\n'),
            };
          }
          return null;
        }}
        deviceProps={{ waitForPageLoad: false }}
        className="deckgl-map"
      />

      {isLoading && (
        <div style={{
          ...OVERLAY_CARD_STYLE,
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
        }}>
          Loading data...
        </div>
      )}

      {error && (
        <div style={{
          ...OVERLAY_CARD_STYLE,
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: '60%',
          color: '#a00000',
          border: '1px solid #a00000',
        }}>
          Failed to load Poláky {activeTrack.id} data: {error}
        </div>
      )}

      <div
        role="group"
        aria-label="InSAR track"
        style={{
          ...OVERLAY_CARD_STYLE,
          top: 12,
          left: 12,
        }}
      >
        <div style={OVERLAY_TITLE_STYLE}>Track</div>
        <div style={{ display: 'flex', gap: '3px' }}>
          {TRACKS.map(track => {
            const state = tracks[track.id];
            const isActive = track.id === activeTrackId;
            const isTrackLoading = state?.status === 'loading';
            const hasFailed = state?.status === 'error';
            return (
              <button
                key={track.id}
                type="button"
                onClick={() => handleSelectTrack(track.id)}
                aria-pressed={isActive}
                aria-busy={isTrackLoading || undefined}
                title={hasFailed
                  ? `${track.id} (${track.direction}) failed to load: ${state.error}. Click to retry.`
                  : `${track.id} (${track.direction})`}
                style={trackButtonStyle(isActive, hasFailed)}
              >
                {track.id}
                {isTrackLoading ? ' …' : ''}
              </button>
            );
          })}
        </div>
        <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '8px', display: 'flex', alignItems: 'baseline', gap: '6px' }}>
          <span>Rig</span>
          <span style={{ fontWeight: 400, color: '#777' }}>{rigStatusLabel}</span>
        </div>
        <div role="group" aria-label="Rig mode" style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
          {RIG_MODES.map(mode => (
            <button
              key={mode.id}
              type="button"
              onClick={() => setRigMode(mode.id)}
              aria-pressed={rigMode === mode.id}
              style={trackButtonStyle(rigMode === mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {rigEnabled && (
          <>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Window</div>
            <div role="group" aria-label="Smoothing window" style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
              {WINDOW_OPTIONS.map(days => (
                <button
                  key={days}
                  type="button"
                  onClick={() => setWindowDays(days)}
                  aria-pressed={windowDays === days}
                  title={`Centred rolling mean over ${days} days`}
                  style={trackButtonStyle(windowDays === days)}
                >
                  {days} d
                </button>
              ))}
            </div>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Vertical</div>
            <div role="group" aria-label="Vertical exaggeration" style={{ display: 'flex', gap: '3px' }}>
              {SCALE_OPTIONS.map(scale => (
                <button
                  key={scale}
                  type="button"
                  onClick={() => setScaleMPerMm(scale)}
                  aria-pressed={scaleMPerMm === scale}
                  title={`1 mm → ${scale} m`}
                  style={trackButtonStyle(scaleMPerMm === scale)}
                >
                  ×{Math.round(scale * 1000)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div style={{
        ...OVERLAY_CARD_STYLE,
        left: 12,
        bottom: 12,
      }}
      >
        <div style={OVERLAY_TITLE_STYLE}>VEL_AVG (mm/yr)</div>
        <div style={{ width: '100%', height: '10px', borderRadius: '2px', background: legendGradient }} />
        <div style={{ display: 'flex', marginTop: '2px', color: '#555' }}>
          <span style={{ flex: 1, textAlign: 'left' }}>{POLAKY_VEL_AVG_DOMAIN[0]}</span>
          <span style={{ flex: 1, textAlign: 'center' }}>0</span>
          <span style={{ flex: 1, textAlign: 'right' }}>+{POLAKY_VEL_AVG_DOMAIN[1]}</span>
        </div>
        <div style={{ marginTop: '4px', color: '#555' }}>|VEL_AVG| ≤ 0.5 = sphere</div>

        {rigEnabled && (
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #eee' }}>
            <div style={OVERLAY_TITLE_STYLE}>Rig tracks</div>
            {TRACK_IDS.map(trackId => (
              <div
                key={trackId}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', lineHeight: '16px' }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: '18px',
                    height: '0px',
                    borderTop: trackId === DASHED_TRACK_ID
                      ? `2px dashed rgb(${FIN_TRACK_COLORS[trackId].join(',')})`
                      : `3px solid rgb(${FIN_TRACK_COLORS[trackId].join(',')})`,
                  }}
                />
                <span style={{ fontWeight: 600 }}>{trackId}</span>
                <span style={{ color: '#777' }}>
                  {TRACK_FIN_SIDE[trackId]} fin{trackId === DASHED_TRACK_ID ? ' · dashed' : ''}
                </span>
              </div>
            ))}
            <div style={{ marginTop: '5px', color: '#555' }}>
              LOS displacement, not vertical · vertical exaggeration
              {' '}×{Math.round(scaleMPerMm * 1000)}
            </div>
          </div>
        )}

        {rigEnabled && focusedPylon && (
          <div style={{ marginTop: '8px', paddingTop: '6px', borderTop: '1px solid #eee' }}>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginBottom: '5px' }}>
              ΔU / ΔE · pylon {focusedPylon.id} ({focusedPylon.typ ?? '–'})
            </div>
            {focusedBandSolutions.map(({ band, bandZ, counts, solution }) => (
              <div
                key={band}
                style={{ display: 'flex', gap: '6px', alignItems: 'baseline', color: solution.lowConfidence ? '#a00000' : '#333' }}
              >
                <span style={{ width: '42px', color: '#777' }}>{bandZ.toFixed(1)} m</span>
                {solution.ok ? (
                  <span>
                    ΔU <b>{formatSignedMm(solution.dU, 1)}</b>
                    {' '}· ΔE <b>{formatSignedMm(solution.dE, 1)}</b> {eastLabel(solution.dE)}
                    {' '}· {solution.used.length < 3
                      ? `${solution.used.length} tracks`
                      : `fit ${formatNumber(solution.residualMm, 1)} mm`}
                    {solution.lowConfidence ? ' · low confidence' : ''}
                  </span>
                ) : (
                  <span>
                    insufficient scatterers
                    {' '}({TRACK_IDS.map(id => counts[id]).join('/')})
                  </span>
                )}
              </div>
            ))}
            <div style={{ marginTop: '5px', color: '#777' }}>
              North component dropped · fit is the LSQ residual
            </div>
          </div>
        )}
      </div>

      {(selectedPylonKey != null || selectedFeature) && (
        <div style={{
          position: 'absolute',
          right: 12,
          bottom: 12,
          width: '460px',
          maxWidth: 'calc(100% - 24px)',
          // One card keeps its natural height; both split the available height
          // in the same 560:320 proportion as their standalone sizes.
          height: selectedPylonKey != null && selectedFeature
            ? 'calc(100% - 24px)'
            : selectedPylonKey != null
              ? 'min(560px, calc(100% - 24px))'
              : 'min(320px, calc(100% - 24px))',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          zIndex: 1200,
        }}>
          {selectedPylonKey != null && (
            <div style={{
              position: 'relative',
              flex: selectedFeature ? '5 1 0' : '1 1 auto',
              minHeight: 0,
            }}>
              <FeatureSpaceChart
                featureCollection={pylonFeatureCollection}
                embedded
                showTimeline
                defaultChartType="timeline"
                profileDisabled
                defaultPreset="custom"
                defaultCustomAxes={{ x: 'lon', y: 'lat', z: 'H_REF', color: 'VEL_AVG', size: 'COH' }}
                attributeKeys={chartAttributeKeys}
                colorPalette={BLUE_PALETTE}
                velAvgPalette={velAvgPalette}
                velAvgDomain={POLAKY_VEL_AVG_DOMAIN}
                timelineColor={SETTLEMENT_COLOR}
                symmetricTimelineZ
                timelineColorPicker
                onPointHover={setHoveredPointId}
                onPointClick={setSelectedId}
                onClose={() => {
                  setSelectedPylonKey(null);
                  setHoveredPointId(null);
                }}
                emptyHint={`No ${activeTrack.id} InSAR points are linked to this pylon.`}
                title={(
                  <span style={CHART_TITLE_STYLE}>
                    {`Pylon ${selectedPylon?.properties?.id ?? selectedPylonKey} · ${activeTrack.id}`}
                  </span>
                )}
              />
            </div>
          )}

          {selectedFeature && (
            <div style={{
              position: 'relative',
              flex: selectedPylonKey != null ? '3 1 0' : '1 1 auto',
              minHeight: 0,
            }}>
              <TimelineChart
                feature={selectedFeature}
                trackLabel={activeTrack.id}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

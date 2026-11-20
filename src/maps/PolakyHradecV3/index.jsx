// Forked from src/maps/PolakyHradecV2 for the Poláky/Hradec v3 multi-track rig.
// v2 keeps the point-cloud / pylon work; v3 adds a rig that reads all three
// tracks at once over the focused pylon (up to three separated section ring stacks)
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
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CylinderGeometry } from '@luma.gl/engine';
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
import SectionRingChart from './SectionRingChart';
import { cartoDarkBasemapUrl } from '../basemaps';
import {
  BAND_LABELS,
  BUCKET_OPTIONS,
  DEFAULT_BUCKET_ID,
  DEFAULT_RING_COLOR_MODE,
  DEFAULT_SCALE_M_PER_MM,
  DEFAULT_TRACK_ID,
  PYLON_NATIVE_HEIGHTS,
  RING_STROKE_WIDTH,
  RIG_MODES,
  RIG_OFF,
  RIG_RINGS,
  RING_COLOR_MODES,
  RING_DISPLACEMENT_DOMAIN,
  SCALE_OPTIONS,
  SEASON_STOPS,
  TRACK_IDS,
  TRACKS,
  viridisColor,
} from './tracks';
import {
  buildRigStore,
  getPointJoinKey,
  getPylonHeight,
  getPylonJoinKey,
  getPylonPickFeature,
  loadRigTracks,
  meanHeightByTyp,
} from './rigData';
import { bandMedianAt, buildSectionRingStacks, ringColor } from './bandGeometry';
import { eastLabel, solveBand } from './decomposition';
import { logRigDebug } from './debugRig';
import { TERRAIN_URL, sampleTerrainElevations } from './terrainElevation';

// Measurement tracks, join keys and rig constants live in `tracks.js`;
// `rigData.js` owns the three-track store.

// Basemap: CARTO Dark Matter, resolved through the shared `basemaps.js` helper so
// the CARTO API key (`window.CARTO_API_KEY` / `VITE_CARTO_API_KEY`) is applied
// like every other map in the sandbox.
const BASEMAP_ATTRIBUTION_URL = 'https://carto.com/attributions';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
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
// Native heights come from the OBJ headers (metres, Z-up, base centre at origin),
// re-exported by `tracks.js` so the mesh scale and the rig fallback agree.
// Each instance is scaled to its GeoJSON `height`; see `getPylonHeight` in rigData.
const PYLON_MODELS = [
  { typ: 'dunaj', nativeHeight: PYLON_NATIVE_HEIGHTS.dunaj, mesh: `${PYLON_ASSET_BASE}/dunaj.obj` },
  { typ: 'kocka', nativeHeight: PYLON_NATIVE_HEIGHTS.kocka, mesh: `${PYLON_ASSET_BASE}/kocka.obj` },
  { typ: 'portal', nativeHeight: PYLON_NATIVE_HEIGHTS.portal, mesh: `${PYLON_ASSET_BASE}/portal.obj` },
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
// Separated section ring stack
//
// Rings are `[lon, lat, terrainAtPylon + sectionFraction × height]` in LNGLAT
// metres — one absolute z per ring, anchored on the COG sample
// (`terrainElevation.js`). No terrain extension on either ring layer: a ring must
// stay strictly horizontal, and per-vertex terrain offsets would warp it.
//
// `terrainAtPylon` must come from the COG, not from `_median` / `H_dem`: the
// InSAR heights sit on a different vertical datum (a smooth 43.9–46.1 m above the
// COG at the 18 towers), so anchoring on them floats the rig ~45 m above the
// steel. `baseElevation` stays in the rig store for reporting only.
// ---------------------------------------------------------------------------
const RIG_REFERENCE_RING_LAYER = 'rig-reference-rings';
const RIG_REFERENCE_LABEL_LAYER = 'rig-reference-year-labels';
const RIG_STACK_RING_LAYER = 'rig-stack-rings';
const RIG_HIGHLIGHT_RING_LAYER = 'rig-highlight-rings';
const RIG_DEBUG_MARKER_LAYER = 'rig-debug-band-markers';

/** 0 mm floor/ceiling rings per section: dashed white, hairline, never picked. */
const RIG_REFERENCE_RING_COLOR = [255, 255, 255, 200];
const RIG_REFERENCE_RING_WIDTH = 1.0;
const RIG_REFERENCE_RING_DASH = [6, 4];

// Every stack ring uses the same thin stroke in both series modes, so dense
// stacks stay readable and the time slices never merge into a solid band.

/** Series mode: time-bucket medians vs one ring per acquisition pass. */
const SERIES_MODES = [
  { id: 'smoothed', label: 'Smoothed', title: 'One ring per selected time bucket · band median per bucket' },
  { id: 'raw', label: 'Raw', title: 'One ring per acquisition pass of the active track' },
];

// Layer-id prefix shared by the 3D LOS point symbols (arrow parts and spheres).
const POINT_LAYER_PREFIX = 'vel-avg-arrows';

// Pre-selection opened once on mount: Pylon 9 and one of its linked InSAR points,
// so the map highlight and both charts are visible without a click. The pylon is
// resolved by its business id and then mapped to the join key; the join key
// itself (currently "8") is never hardcoded, and the start point is looked up
// among that tower's own points so the two defaults can never disagree.
const DEFAULT_PYLON_ID = 9;
// Preferred start point; only used while it is still linked to the default pylon.
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
// Translucent graphite on purpose: the basemap is dark, so light cards glare and
// an opaque fill would hide the terrain context around the controls.
const OVERLAY_CARD_STYLE = {
  position: 'absolute',
  zIndex: 10,
  padding: '6px 8px',
  background: 'rgba(32, 35, 41, 0.92)',
  border: '1px solid #484d55',
  borderRadius: '6px',
  boxShadow: '0 2px 8px rgba(0, 0, 0, 0.45)',
  color: '#e8eaed',
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
    border: `1px solid ${failed ? '#ff8a8a' : active ? '#5aa9ff' : '#4a4f57'}`,
    borderRadius: '4px',
    background: active ? '#2f4a6b' : '#2a2d33',
    color: failed ? '#ff8a8a' : '#dfe3e8',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: active ? 600 : 400,
  };
}

// Camera captured from the map — an oblique ENE view of the Poláky line at z15.34.
const INITIAL_VIEW_STATE = {
  longitude: 13.362612,
  latitude: 50.33776,
  zoom: 15.34,
  pitch: 69.05,
  bearing: 67.27,
  minZoom: 8,
  maxZoom: 18,
  maxPitch: 85,
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

// Section labels are lowercase for ids; the tooltip uses the structural names.
// The ring carries its own `bandLabel` (per-type layout), with the dunaj labels
// as a fallback for older rings.
function bandTitle(ring) {
  const label = ring?.bandLabel ?? BAND_LABELS[ring?.bandIndex] ?? 'section';
  return label.charAt(0).toUpperCase() + label.slice(1);
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
  // Shared GeoJSON cache: the point cloud and the rig must not fetch/parse the
  // same track twice.
  const trackFeatureCache = useRef(new Map());
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
  const [rigMode, setRigMode] = useState(RIG_RINGS);
  const [seriesMode, setSeriesMode] = useState('smoothed');
  const [ringColorMode, setRingColorMode] = useState(DEFAULT_RING_COLOR_MODE);
  const [bucketId, setBucketId] = useState(DEFAULT_BUCKET_ID);
  const [scaleMPerMm, setScaleMPerMm] = useState(DEFAULT_SCALE_M_PER_MM);
  const [rigTracks, setRigTracks] = useState(null);
  const [terrainElevations, setTerrainElevations] = useState(null);
  const [hoveredRing, setHoveredRing] = useState(null);
  // Clicked stack ring, kept as an anchor (pylon/section/date): `activeSelectedRing`
  // below re-resolves it to the closest ring of the current stacks, so the cyan
  // highlight and the section chart follow Shift / Bucket / Series / Track changes.
  const [selectedRing, setSelectedRing] = useState(null);
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
  // Displacement rings reuse the VEL_AVG palette over the ±10 mm displacement
  // domain, so the ramp matches the point symbols without saturating.
  const displacementScale = useMemo(
    () => buildPolakyVelAvgScale(activeTrack.orbit).domain([...RING_DISPLACEMENT_DOMAIN]),
    [activeTrack.orbit],
  );

  // One request/parse per track, shared by the point cloud and the rig. The
  // cache is cleared on failure so a retry starts a fresh request.
  const fetchTrackFeatures = useCallback((id) => {
    const cached = trackFeatureCache.current.get(id);
    if (cached) return cached.promise;

    const track = TRACKS.find(t => t.id === id);
    if (!track) return Promise.reject(new Error(`Unknown track ${id}`));

    const controller = new AbortController();
    const promise = (async () => {
      const res = await fetch(track.url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${track.url}`);
      const data = await res.json();
      return Array.isArray(data) ? data : (data.features || []);
    })();
    trackFeatureCache.current.set(id, { promise, controller });
    promise.catch(() => {
      const entry = trackFeatureCache.current.get(id);
      if (entry?.promise === promise) trackFeatureCache.current.delete(id);
    });
    return promise;
  }, []);

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
        const loaded = await fetchTrackFeatures(id);
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
  }, [fetchTrackFeatures]);

  useEffect(() => {
    loadTrack(DEFAULT_TRACK_ID);
  }, [loadTrack]);

  // Abort any pending track request and shared cache fetch on unmount.
  useEffect(() => () => {
    for (const { controller } of inFlight.current.values()) controller.abort();
    inFlight.current.clear();
    for (const { controller } of trackFeatureCache.current.values()) controller.abort();
    trackFeatureCache.current.clear();
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
    // The default point must belong to the default pylon: the pylon chart draws
    // that tower's points, so a point from another tower would desynchronise the
    // timeline. Prefer DEFAULT_POINT_ID when it is still linked, else take the
    // first linked point of the default track.
    const linked = pylonKey == null
      ? EMPTY
      : features.filter(feature => getPointJoinKey(feature) === pylonKey);
    const point = linked.find(feature => (
      String(feature?.properties?.ID) === String(DEFAULT_POINT_ID)
    )) ?? linked[0] ?? null;
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
        const featuresByTrack = await loadRigTracks(controller.signal, fetchTrackFeatures);
        if (controller.signal.aborted) return;
        setRigTracks({ status: 'ready', featuresByTrack, error: null });
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error('❌ Failed to load Poláky rig tracks:', err);
        setRigTracks({ status: 'error', featuresByTrack: null, error: err.message || String(err) });
      }
    })();
    return () => controller.abort();
  }, [fetchTrackFeatures]);

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

  // Join the three tracks to the pylons once both loads have settled. The
  // terrain-independent store is built once; COG samples are merged afterwards
  // so their arrival does not re-scan every track property.
  const rigBaseStore = useMemo(() => {
    if (rigTracks?.status !== 'ready' || !pylonsLoaded || pylonFeatures.length === 0) return null;
    return buildRigStore({
      pylonFeatures,
      featuresByTrack: rigTracks.featuresByTrack,
    });
  }, [rigTracks, pylonsLoaded, pylonFeatures]);

  const rigStore = useMemo(() => {
    if (!rigBaseStore || !terrainElevations) return rigBaseStore;

    const pylons = new Map();
    for (const [key, pylon] of rigBaseStore.pylons) {
      pylons.set(key, { ...pylon, terrainElevation: terrainElevations.get(key) ?? null });
    }
    const missing = [...pylons.values()].filter(p => !Number.isFinite(p.terrainElevation));
    const warnings = missing.length
      ? [
          ...rigBaseStore.warnings,
          `${missing.length} pylon(s) without a terrain sample: ${missing.map(p => p.id).join(', ')}`,
        ]
      : rigBaseStore.warnings;
    return { ...rigBaseStore, pylons, warnings };
  }, [rigBaseStore, terrainElevations]);

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

  // Separated section ring stack for the focused tower and the active track.
  // Smoothed mode draws one bold ring per non-empty time bucket; Raw mode draws
  // one ring per acquisition pass of the active track. Ring z is linear in real
  // time on the union grid either way.
  const ringData = useMemo(() => {
    const empty = { stacks: EMPTY, references: EMPTY };
    if (rigMode !== RIG_RINGS || !focusedPylon || !rigStore) return empty;
    return buildSectionRingStacks({
      pylon: focusedPylon,
      activeTrackId,
      grid: rigStore.grid,
      trackDates: rigStore.trackDates,
      rawMode: seriesMode === 'raw',
      bucketId,
      scaleMPerMm,
    });
  }, [rigMode, focusedPylon, rigStore, activeTrackId, seriesMode, bucketId, scaleMPerMm]);

  // Colour is a cheap post-pass over the memoised geometry, so switching the
  // colour mode never re-runs the band smoothing / median pipeline.
  const ringStacks = useMemo(() => {
    if (ringData.stacks.length === 0) return EMPTY;
    return ringData.stacks.map((ring) => ({
      ...ring,
      color: [...ringColor(ring, ringColorMode, displacementScale), ring.color[3]],
    }));
  }, [ringData, ringColorMode, displacementScale]);

  // The clicked ring re-resolved against the current stacks: after a Shift /
  // Bucket / Series / Track change the anchor date may no longer exist, so the
  // closest ring of the same pylon and section becomes the highlighted one.
  // Requiring the pylon to still be the selected one keeps a stale ring from
  // rendering against another tower.
  const activeSelectedRing = useMemo(() => {
    if (rigMode !== RIG_RINGS || selectedRing == null) return null;
    if (selectedPylonKey !== selectedRing.pylonKey) return null;
    let best = null;
    for (const ring of ringStacks) {
      if (ring.pylonKey !== selectedRing.pylonKey) continue;
      if (ring.bandIndex !== selectedRing.bandIndex) continue;
      if (best == null || Math.abs(ring.dateMs - selectedRing.dateMs)
          < Math.abs(best.dateMs - selectedRing.dateMs)) best = ring;
    }
    return best;
  }, [rigMode, selectedRing, selectedPylonKey, ringStacks]);

  // First/last acquisition year of the union grid; display fallbacks while the
  // rig is still loading.
  const ringYears = useMemo(() => {
    const grid = rigStore?.grid;
    if (!Array.isArray(grid) || grid.length === 0) return null;
    return {
      startYear: new Date(grid[0]).getUTCFullYear(),
      endYear: new Date(grid[grid.length - 1]).getUTCFullYear(),
    };
  }, [rigStore]);

  // One small year label on the east edge of every white reference ring: the
  // floor shows the start year, the ceiling the end year. Only populated sections
  // emit references, so the count follows the layout. The anchor sits exactly on
  // the ring's z with a centre baseline, so the ring runs through the middle of
  // the text.
  const ringYearLabels = useMemo(() => {
    if (rigMode !== RIG_RINGS || !ringYears || ringData.references.length === 0) return EMPTY;
    return ringData.references.map((reference) => {
      const point = reference.path[Math.floor((reference.path.length - 1) / 4)];
      return {
        text: String(reference.kind === 'floor' ? ringYears.startYear : ringYears.endYear),
        position: [point[0], point[1], point[2]],
      };
    });
  }, [rigMode, ringYears, ringData]);

  // Per-band ΔU/ΔE for the focused tower.
  const focusedBandSolutions = useMemo(() => {
    if (!rigEnabled || !focusedPylon || !rigStore || !rigStore.commonEpochMs) return EMPTY;

    const out = [];
    for (let band = 0; band < focusedPylon.bandZ.length; band++) {
      const weights = {};
      const fields = {};
      for (const trackId of TRACK_IDS) {
        weights[trackId] = focusedPylon.nByBandTrack[trackId][band];
        fields[trackId] = bandMedianAt(
          focusedPylon.bands[trackId][band],
          rigStore.commonEpochMs,
          bucketId,
        );
      }
      out.push({
        band,
        bandZ: focusedPylon.bandZ[band],
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
    return out;
  }, [rigEnabled, focusedPylon, rigStore, bucketId]);

  // The camera belongs to the controller (`initialViewState`), exactly like the
  // other maps here: React only mirrors the zoom for the arrow size band.
  const handleViewStateChange = useCallback(({ viewState: next }) => {
    setZoom(next.zoom);
  }, []);

  // `?debugRig=1` acceptance gates. Re-runs on a bucket change so the printed
  // ring numbers follow the control.
  useEffect(() => {
    if (!debugRig || !rigStore) return;
    logRigDebug({ store: rigStore, bucketId });
  }, [debugRig, rigStore, bucketId]);

  // Clicking a ring curve switches to that track, focuses its pylon, highlights
  // the ring in cyan and opens the section's multi-point timeline card. The
  // anchor (not the ring object) is stored so a control change can re-resolve it.
  const handleRingClick = useCallback((ring) => {
    if (!ring || !rigStore) return;

    if (ring.trackId !== activeTrackId) {
      setActiveTrackId(ring.trackId);
      setHoveredPointId(null);
      setHoveredSphereId(null);
      if (tracks[ring.trackId]?.status !== 'ready') loadTrack(ring.trackId);
    }
    setSelectedPylonKey(ring.pylonKey);
    setSelectedId(null);
    setSelectedRing({
      pylonKey: ring.pylonKey,
      bandIndex: ring.bandIndex,
      trackId: ring.trackId,
      dateMs: ring.dateMs,
    });
  }, [rigStore, activeTrackId, tracks, loadTrack]);

  const pylonGroups = useMemo(() => {
    const groups = { kocka: [], dunaj: [], portal: [] };
    let skipped = 0;
    for (const f of pylonFeatures) {
      const typ = f?.properties?.typ;
      if (!groups[typ]) {
        skipped++;
        continue;
      }
      groups[typ].push(f);
    }
    if (skipped) console.warn(`Skipped ${skipped} pylon feature(s) with unknown typ`);
    // Mean of the features that do carry a height, for those that do not. Shared
    // with the rig store so the mesh/hit volume and the ring scaffold agree.
    return { groups, meanHeight: meanHeightByTyp(pylonFeatures) };
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

  // The lower-right panel keeps the section chart only while it has something to
  // show; the two cards stay mutually exclusive (ring click clears the point,
  // point click clears the ring).
  const hasLowerChart = Boolean(selectedFeature || activeSelectedRing);

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
    // Every stack ring is its own pick target; the cursor mirrors that without
    // touching the pylon/sphere hover state. The object is kept so the map can
    // draw a white highlight ring over the hovered one.
    const nextRing = layerId === RIG_STACK_RING_LAYER ? (info.object ?? null) : null;
    setHoveredPylonKey(prev => (prev === nextPylonKey ? prev : nextPylonKey));
    setHoveredSphereId(prev => (prev === nextSphereId ? prev : nextSphereId));
    setHoveredRing(prev => (prev === nextRing ? prev : nextRing));
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

  // Every layer is built on the first render, like v2: `zRange` starts as `null`
  // and the COG reports its bounds a frame or two later. The draped content then
  // settles vertically under a stationary camera; the controller-owned initial
  // view is never blocked, and an unreachable COG cannot blank the map.
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
    const basemapLayer = new TileLayer({
      id: 'basemap-dark',
      data: cartoDarkBasemapUrl,
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
          // Ease the dark basemap back a little further while the rig is on, so the
          // Viridis stack and the white 0 mm rings keep the brightest tones.
          tintColor: rigEnabled ? [205, 210, 220] : [255, 255, 255],
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

    // ---- Separated section ring stack ----------------------------------------
    const rigLayers = [];

    // `?debugRig=1`: one small marker at each section floor and ceiling, in the
    // same absolute z frame as the rings, so the stack frame can be eyeballed
    // against the lattice.
    if (debugRig && focusedPylon && Number.isFinite(focusedPylon.terrainElevation)) {
      const markers = [];
      (focusedPylon.sectionSlots ?? []).forEach(([startFraction, endFraction], band) => {
        for (const fraction of [startFraction, endFraction]) {
          markers.push({
            band,
            fraction,
            position: [
              focusedPylon.lon,
              focusedPylon.lat,
              focusedPylon.terrainElevation + fraction * focusedPylon.height,
            ],
          });
        }
      });
      rigLayers.push(new ScatterplotLayer({
        id: RIG_DEBUG_MARKER_LAYER,
        data: markers,
        getPosition: (d) => d.position,
        radiusUnits: 'meters',
        getRadius: 0.8,
        getFillColor: (d) => (d.band === 1 ? [255, 140, 0, 220] : [255, 0, 255, 220]),
        pickable: false,
      }));
    }

    if (rigMode === RIG_RINGS) {
      // 0 mm floor/ceiling rings per section: dashed white, not pickable.
      if (ringData.references.length > 0) {
        rigLayers.push(new PathLayer({
          id: RIG_REFERENCE_RING_LAYER,
          data: ringData.references,
          getPath: (d) => d.path,
          getColor: RIG_REFERENCE_RING_COLOR,
          getWidth: RIG_REFERENCE_RING_WIDTH,
          widthUnits: 'pixels',
          billboard: true,
          jointRounded: true,
          capRounded: true,
          pickable: false,
          extensions: [new PathStyleExtension({ dash: true })],
          getDashArray: () => RIG_REFERENCE_RING_DASH,
        }));
      }

      // Start/end year on every section's floor/ceiling reference ring.
      if (ringYearLabels.length > 0) {
        rigLayers.push(new TextLayer({
          id: RIG_REFERENCE_LABEL_LAYER,
          data: ringYearLabels,
          getPosition: (d) => d.position,
          getText: (d) => d.text,
          getColor: [232, 236, 241],
          getSize: 2,
          sizeUnits: 'pixels',
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: [8, 0],
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 600,
          characterSet: 'auto',
          billboard: true,
          pickable: false,
        }));
      }

      // One thin horizontal ring per time bucket (or per acquisition pass in
      // Raw), stacked through the section. The ring stays pickable so hover gives
      // date + median LOS and click opens the section chart for that timestep.
      if (ringData.stacks.length > 0) {
        rigLayers.push(new PathLayer({
          id: RIG_STACK_RING_LAYER,
          data: ringStacks,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: RING_STROKE_WIDTH,
          widthUnits: 'pixels',
          billboard: true,
          jointRounded: true,
          capRounded: true,
          pickable: true,
        }));
      }

      // Hover / selection highlight rings: both use the same cyan as the point
      // and pylon highlights, so every "active" thing on the map reads alike.
      // Not pickable, so the thin stack rings underneath keep hover and click.
      const highlightRings = [];
      if (activeSelectedRing) {
        highlightRings.push({
          path: activeSelectedRing.path,
          color: [...SELECTION_COLOR, 255],
          width: 2.8,
        });
      }
      if (hoveredRing) {
        highlightRings.push({ path: hoveredRing.path, color: [...SELECTION_COLOR, 255], width: 3.2 });
      }
      if (highlightRings.length > 0) {
        rigLayers.push(new PathLayer({
          id: RIG_HIGHLIGHT_RING_LAYER,
          data: highlightRings,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          getWidth: (d) => d.width,
          widthUnits: 'pixels',
          billboard: true,
          jointRounded: true,
          capRounded: true,
          pickable: false,
        }));
      }
    }

    return [
      terrainLayer,
      basemapLayer,
      ...pylonLayers,
      // Before the point symbols on purpose: later layers win overlapping pick
      // pixels, so arrows and spheres keep click priority over pylon hit volumes.
      pylonHitLayer,
      // The rig sits between the towers and the point symbols for the same
      // reason: point arrows keep pick priority where they overlap the rings.
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
    ringData,
    ringStacks,
    hoveredRing,
    activeSelectedRing,
    ringYearLabels,
    debugRig,
    focusedPylon,
  ]);

  const legendGradient = `linear-gradient(to right, ${colorScale.colors(11).join(', ')})`;
  // Same 6-stop Viridis as the rings, so the bar is an exact time key.
  const viridisGradient = `linear-gradient(to right, ${[0, 0.2, 0.4, 0.6, 0.8, 1]
    .map(u => `rgb(${viridisColor(u).join(',')})`)
    .join(', ')})`;
  const seasonGradient = `linear-gradient(to right, ${
    SEASON_STOPS.map(stop => `rgb(${stop.join(',')})`).join(', ')
  })`;
  const legendStartYear = ringYears?.startYear ?? 2014;
  const legendEndYear = ringYears?.endYear ?? 2026;
  const legendMidYear = Math.round((legendStartYear + legendEndYear) / 2);

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      colorScheme: 'light',
      background: '#14171b',
    }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        onViewStateChange={handleViewStateChange}
        getCursor={() => (
          hoveredPylonKey != null || hoveredSphereId != null || hoveredRing != null ? 'pointer' : 'grab'
        )}
        controller
        layers={layers}
        // Small tolerance so near-misses on thin steel and arrow tips still hit.
        pickingRadius={6}
        onHover={handleHover}
        onClick={(info) => {
          const layerId = info.layer?.id ?? '';
          if (layerId === RIG_STACK_RING_LAYER) {
            handleRingClick(info.object);
            return;
          }
          if (layerId.startsWith('pylons-')) {
            const key = getPylonJoinKey(getPylonPickFeature(info.object));
            if (key == null) return;
            setHoveredPointId(null);
            setSelectedPylonKey(key);
            // A ring belongs to the pylon it was clicked on; focusing another
            // tower must not leave a stale cyan highlight behind.
            setSelectedRing(null);
            return;
          }
          if (layerId.startsWith(POINT_LAYER_PREFIX)) {
            setHoveredPointId(null);
            setSelectedId(info.object?.properties?.ID ?? null);
            setSelectedRing(null);
            return;
          }
          setSelectedId(null);
          setSelectedPylonKey(null);
          setHoveredPointId(null);
          setSelectedRing(null);
        }}
        getTooltip={({ object, layer }) => {
          const layerId = layer?.id ?? '';
          if (layerId === RIG_STACK_RING_LAYER) {
            const ring = object;
            if (!ring) return null;
            return {
              text: [
                `Pylon ${ring.pylonId ?? '–'} · ${bandTitle(ring)} (${ring.count} pts)`,
                `${ring.trackId} · ${formatDateMs(ring.dateMs)} (${seriesMode === 'raw' ? 'raw pass' : ring.bucketId})`,
                `Median LOS: ${formatSignedMm(ring.valueMm)} mm`,
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
          color: '#ff9b9b',
          border: '1px solid #ff9b9b',
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
          <span style={{ fontWeight: 400, color: '#9aa0a8' }}>{rigStatusLabel}</span>
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
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Color</div>
            <div role="group" aria-label="Ring color mode" style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
              {RING_COLOR_MODES.map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setRingColorMode(mode.id)}
                  aria-pressed={ringColorMode === mode.id}
                  title={mode.title}
                  style={trackButtonStyle(ringColorMode === mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Series</div>
            <div role="group" aria-label="Series mode" style={{ display: 'flex', gap: '3px' }}>
              {SERIES_MODES.map(mode => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setSeriesMode(mode.id)}
                  aria-pressed={seriesMode === mode.id}
                  title={mode.title}
                  style={trackButtonStyle(seriesMode === mode.id)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Bucket</div>
            <div role="group" aria-label="Time bucket" style={{ display: 'flex', gap: '3px', flexWrap: 'wrap' }}>
              {BUCKET_OPTIONS.map(spec => {
                const active = seriesMode === 'smoothed' && bucketId === spec.id;
                return (
                  <button
                    key={spec.id}
                    type="button"
                    onClick={() => setBucketId(spec.id)}
                    aria-pressed={active}
                    disabled={seriesMode === 'raw'}
                    title={spec.title}
                    style={{ ...trackButtonStyle(active), opacity: seriesMode === 'raw' ? 0.4 : 1 }}
                  >
                    {spec.label}
                  </button>
                );
              })}
            </div>
            <div style={{ ...OVERLAY_TITLE_STYLE, marginTop: '6px' }}>Shift</div>
            <div role="group" aria-label="Ring shift exaggeration" style={{ display: 'flex', gap: '3px' }}>
              {SCALE_OPTIONS.map(scale => (
                <button
                  key={scale}
                  type="button"
                  onClick={() => setScaleMPerMm(scale)}
                  aria-pressed={scaleMPerMm === scale}
                  title={`1 mm of LOS becomes ${scale} m of ring shift`}
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
        <div style={OVERLAY_TITLE_STYLE} title="|VEL_AVG| ≤ 0.5 mm/yr renders as a sphere">
          VEL_AVG (mm/yr)
        </div>
        <div style={{ width: '100%', height: '7px', borderRadius: '2px', background: legendGradient }} />
        <div style={{ display: 'flex', marginTop: '1px', color: '#b3b8bf' }}>
          <span style={{ flex: 1, textAlign: 'left' }}>{POLAKY_VEL_AVG_DOMAIN[0]}</span>
          <span style={{ flex: 1, textAlign: 'center' }}>0</span>
          <span style={{ flex: 1, textAlign: 'right' }}>+{POLAKY_VEL_AVG_DOMAIN[1]}</span>
        </div>

        {rigEnabled && (
          <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px solid #3b4048' }}>
            {ringColorMode === 'time' && (
              <>
                <div style={OVERLAY_TITLE_STYLE}>Time (Viridis)</div>
                <div style={{ width: '100%', height: '7px', borderRadius: '2px', background: viridisGradient }} />
                <div style={{ display: 'flex', marginTop: '1px', color: '#b3b8bf' }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>{legendStartYear}</span>
                  <span style={{ flex: 1, textAlign: 'center' }}>{legendMidYear}</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>{legendEndYear}</span>
                </div>
              </>
            )}
            {ringColorMode === 'season' && (
              <>
                <div style={OVERLAY_TITLE_STYLE}>Season (Thermal Cycle)</div>
                <div style={{ width: '100%', height: '7px', borderRadius: '2px', background: seasonGradient }} />
                <div style={{ display: 'flex', marginTop: '1px', color: '#b3b8bf' }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>Winter</span>
                  <span style={{ flex: 1, textAlign: 'center' }}>Spring/Autumn</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>Summer</span>
                </div>
              </>
            )}
            {ringColorMode === 'displacement' && (
              <>
                <div style={OVERLAY_TITLE_STYLE}>LOS Displacement (mm)</div>
                <div style={{ width: '100%', height: '7px', borderRadius: '2px', background: legendGradient }} />
                <div style={{ display: 'flex', marginTop: '1px', color: '#b3b8bf' }}>
                  <span style={{ flex: 1, textAlign: 'left' }}>{RING_DISPLACEMENT_DOMAIN[0]}</span>
                  <span style={{ flex: 1, textAlign: 'center' }}>0</span>
                  <span style={{ flex: 1, textAlign: 'right' }}>+{RING_DISPLACEMENT_DOMAIN[1]}</span>
                </div>
                <div style={{ color: '#9aa0a8', fontSize: '10px', lineHeight: '13px' }}>
                  Away / subsidence ← 0 → Toward
                </div>
              </>
            )}
            <div style={{ marginTop: '3px', color: '#b3b8bf', fontSize: '10px', lineHeight: '13px' }}>
              Ring height = time ↑ {legendStartYear}→{legendEndYear} · shift = LOS ×{Math.round(scaleMPerMm * 1000)}
            </div>
            <div style={{ color: '#9aa0a8', fontSize: '10px', lineHeight: '13px' }}>
              White dashed = 0 mm · not vertical
            </div>
          </div>
        )}

        {rigEnabled && focusedPylon && (
          <div style={{ marginTop: '4px', paddingTop: '4px', borderTop: '1px solid #3b4048' }}>
            <div
              style={{ ...OVERLAY_TITLE_STYLE, marginBottom: '3px' }}
              title="North component dropped · fit is the LSQ residual"
            >
              ΔU / ΔE · pylon {focusedPylon.id} ({focusedPylon.typ ?? '–'})
            </div>
            {focusedBandSolutions.map(({ band, bandZ, counts, solution }) => (
              <div
                key={band}
                style={{ display: 'flex', gap: '6px', alignItems: 'baseline', color: solution.lowConfidence ? '#ff8a8a' : '#e8eaed' }}
              >
                <span style={{ width: '42px', color: '#9aa0a8' }}>{bandZ.toFixed(1)} m</span>
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
          </div>
        )}

        <div style={{ marginTop: '4px', color: '#9aa0a8', fontSize: '9px' }}>
          Basemap:{' '}
          <a
            href={BASEMAP_ATTRIBUTION_URL}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#c6ccd4' }}
          >
            © CARTO
          </a>
          ,{' '}
          <a
            href={OSM_COPYRIGHT_URL}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#c6ccd4' }}
          >
            © OpenStreetMap contributors
          </a>
        </div>
      </div>

      {(selectedPylonKey != null || hasLowerChart) && (
        <div style={{
          position: 'absolute',
          right: 12,
          bottom: 12,
          width: '460px',
          maxWidth: 'calc(100% - 24px)',
          // One card keeps its natural height; two split the available height
          // in the same 560:320 proportion as their standalone sizes.
          height: selectedPylonKey != null && hasLowerChart
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
              flex: hasLowerChart ? '5 1 0' : '1 1 auto',
              minHeight: 0,
            }}>
              <FeatureSpaceChart
                featureCollection={pylonFeatureCollection}
                embedded
                dark
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
                // The chart's own point click never goes through the DeckGL
                // handler, so it has to release the ring explicitly; otherwise a
                // cyan ring would stay on the map behind the TimelineChart.
                onPointClick={(id) => {
                  setSelectedId(id);
                  setSelectedRing(null);
                }}
                onClose={() => {
                  setSelectedPylonKey(null);
                  setHoveredPointId(null);
                  setSelectedRing(null);
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

          {!selectedFeature && activeSelectedRing && focusedPylon && (
            <div style={{
              position: 'relative',
              flex: selectedPylonKey != null ? '3 1 0' : '1 1 auto',
              minHeight: 0,
            }}>
              <SectionRingChart
                ring={activeSelectedRing}
                pylon={focusedPylon}
                rawMode={seriesMode === 'raw'}
                bucketId={bucketId}
                activeDates={rigStore?.trackDates?.[activeTrackId] ?? rigStore?.grid ?? EMPTY}
                onClose={() => setSelectedRing(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

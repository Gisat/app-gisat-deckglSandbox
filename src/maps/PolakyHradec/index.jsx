import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import chroma from 'chroma-js';
import { build3dLosArrowLayers } from '../../layers/factory/build3dLosArrowLayers';
import { BLUE_PALETTE, FeatureSpaceChart } from '../../components/FeatureSpaceChart3D';
import TimelineChart from './TimelineChart';

const DATA_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_95D_PS.geojson';
const TERRAIN_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/EL-GRID_COGeoN.tif';
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

// Pylon <-> InSAR join. The pylon GeoJSON spells the join property `index_righ`
// (no trailing "t"), while the points use `index_right`; support both.
function getPylonJoinKey(feature) {
  const raw = feature?.properties?.index_right ?? feature?.properties?.index_righ;
  return raw == null || raw === '' ? null : String(raw);
}

function getPointJoinKey(feature) {
  const raw = feature?.properties?.index_right;
  return raw == null || raw === '' ? null : String(raw);
}

// Stable empty array so memoised selections do not retrigger chart transforms.
const EMPTY = [];

// Layer-id prefix shared by the seven 3D LOS arrow sublayers.
const ARROW_LAYER_PREFIX = 'vel-avg-arrows';

// Exact 3d-feature-charts ramp (red -> yellow -> teal) on the VEL_AVG domain.
const colorScale = chroma
  .scale([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
  .domain([-1, 1]);

// Shared cyan for every "selected" or hovered highlight on the map.
const SELECTION_COLOR = [66, 212, 244];
// Chart hover highlight, matching the chart's own red point highlight.
const CHART_HOVER_COLOR = [255, 0, 0, 255];

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

// Arrows use the measured ellipsoidal height H as their anchor, with no datum
// conversion. H is 368.5-452.5 m across the site while the orthometric EL-GRID
// terrain is ~45 m lower, so the arrows intentionally float above the draped
// surface. The arrow builder adds the small per-feature vector raise above H.
function getElevation(feature) {
  const height = Number(feature?.properties?.H);
  return Number.isFinite(height) ? height : 0;
}

// GeoJSON height is the real tower height in metres, so it is used to scale the
// native-size OBJ; six features have height: null and fall back to a type mean.
function getPylonHeight(feature) {
  const height = Number(feature?.properties?.height);
  return Number.isFinite(height) && height > 0 ? height : null;
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

function getRgba(feature) {
  // chroma 2.x scales extrapolate outside the domain; clamp so the few stations
  // past ±1 stay at the ramp endpoints instead of producing bad channels.
  const value = Number(feature?.properties?.VEL_AVG ?? 0);
  const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const [r, g, b] = colorScale(clamped).rgb();
  return [r, g, b, 255];
}

function formatNumber(value, digits) {
  // Number(null) is 0, so reject empty values before coercing: a missing
  // attribute must read as "no data", not as a real zero.
  if (value == null || value === '') return '–';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

export default function PolakyHradec() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();
  const [features, setFeatures] = useState([]);
  const [pylonFeatures, setPylonFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
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

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${DATA_URL}`);
        const data = await res.json();
        // Handle both FeatureCollection and direct array formats
        const loaded = Array.isArray(data) ? data : (data.features || []);
        if (!cancelled) {
          setFeatures(loaded);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('❌ Failed to load Poláky data:', err);
        if (!cancelled) {
          setError(err.message || String(err));
          setIsLoading(false);
        }
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

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
      }
    };

    loadPylons();
    return () => {
      cancelled = true;
    };
  }, []);

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

  const selectedFeature = useMemo(() => {
    if (selectedId == null) return null;
    return features.find(f => String(f.properties?.ID) === String(selectedId)) ?? null;
  }, [features, selectedId]);

  // Attributes offered by the 3D chart: the geometry-derived position, then
  // every numeric GeoJSON property except LON/LAT (duplicates of the geometry)
  // and the flat `d_YYYYMMDD` displacement timeline.
  const chartAttributeKeys = useMemo(() => {
    const keys = new Set();
    for (const feature of features) {
      for (const [key, value] of Object.entries(feature.properties ?? {})) {
        if (key === 'LON' || key === 'LAT') continue;
        if (!/^d_\d{8}$/.test(key) && typeof value === 'number' && Number.isFinite(value)) {
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
    const nextPylonKey = layerId.startsWith('pylons-') ? getPylonJoinKey(info.object) : null;
    const nextSphereId = layerId.startsWith(ARROW_LAYER_PREFIX)
      ? (info.object?.properties?.ID ?? null)
      : null;
    setHoveredPylonKey(prev => (prev === nextPylonKey ? prev : nextPylonKey));
    setHoveredSphereId(prev => (prev === nextSphereId ? prev : nextSphereId));
  }, []);

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

    // Every point renders as a 3D LOS round-cap arrow composite (rear cap, body,
    // two wing rods, two wing-tip caps, arrow tip). Chart hover paints the
    // matching arrow red; a directly selected/hovered arrow keeps the shared
    // highlight cyan. The accessor is shared by all seven arrow parts, so the
    // pylon-linked selection highlight applies to the whole composite too.
    const arrowLayers = build3dLosArrowLayers({
      idPrefix: ARROW_LAYER_PREFIX,
      data: features,
      zoom,
      orbit: 'D',
      pickable: true,
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getColor: (d) => {
        const id = d.properties?.ID;
        if (hoveredPointId != null && String(id) === String(hoveredPointId)) {
          return CHART_HOVER_COLOR;
        }
        const isHighlighted = [selectedId, hoveredSphereId].some(
          other => other != null && String(id) === String(other),
        );
        return isHighlighted ? [...SELECTION_COLOR, 255] : getRgba(d);
      },
      updateTriggers: {
        getColor: [
          selectedId,
          hoveredSphereId,
          hoveredPointId,
        ],
      },
    });

    return [
      terrainLayer,
      satelliteLayer,
      ...pylonLayers,
      ...arrowLayers,
    ];
  }, [
    zRange,
    onZRangeUpdate,
    features,
    pylonGroups,
    zoom,
    selectedId,
    hoveredPointId,
    hoveredSphereId,
    selectedPylonKey,
    hoveredPylonKey,
  ]);

  const legendGradient = `linear-gradient(to right, ${colorScale.colors(10).join(', ')})`;

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
        initialViewState={INITIAL_VIEW_STATE}
        onViewStateChange={({ viewState }) => setZoom(viewState.zoom)}
        getCursor={() => (hoveredPylonKey != null || hoveredSphereId != null ? 'pointer' : 'grab')}
        controller
        layers={layers}
        onHover={handleHover}
        onClick={(info) => {
          const layerId = info.layer?.id ?? '';
          if (layerId.startsWith('pylons-')) {
            const key = getPylonJoinKey(info.object);
            if (key == null) return;
            setHoveredPointId(null);
            setSelectedPylonKey(key);
            return;
          }
          if (layerId.startsWith(ARROW_LAYER_PREFIX)) {
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
          if (layerId.startsWith('pylons-')) {
            const props = object?.properties;
            if (!props) return null;
            const key = getPylonJoinKey(object);
            const height = props.height == null || props.height === ''
              ? '–'
              : formatNumber(props.height, 1);
            return {
              text: [
                `Pylon ${props.id ?? '–'} (${props.typ ?? '–'})`,
                `Height: ${height} m`,
                `InSAR points: ${pointsByPylonKey.get(key)?.length ?? 0}`,
              ].join('\n'),
            };
          }
          if (layerId.startsWith(ARROW_LAYER_PREFIX)) {
            const props = object?.properties;
            if (!props) return null;
            return {
              text: [
                `ID: ${props.ID ?? '–'}`,
                `VEL_AVG: ${formatNumber(props.VEL_AVG, 2)} mm/yr`,
                `COH: ${formatNumber(props.COH, 2)}`,
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
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.7)',
          color: 'white',
          padding: '10px',
          borderRadius: '4px',
        }}>
          Loading data...
        </div>
      )}

      {error && (
        <div style={{
          position: 'absolute',
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          maxWidth: '60%',
          background: 'rgba(160,0,0,0.85)',
          color: 'white',
          padding: '10px',
          borderRadius: '4px',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '12px',
        }}>
          Failed to load Poláky data: {error}
        </div>
      )}

      <div style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        zIndex: 10,
        padding: '8px 10px',
        background: 'rgba(255, 255, 255, 0.9)',
        border: '1px solid #ddd',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#333',
      }}
      >
        <div style={{ marginBottom: '4px', fontWeight: 600 }}>VEL_AVG (mm/yr)</div>
        <div style={{ width: '180px', height: '10px', borderRadius: '2px', background: legendGradient }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#555' }}>
          <span>-1</span>
          <span>0</span>
          <span>+1</span>
        </div>
        <div style={{ marginTop: '4px', color: '#555' }}>Arrow length = |VEL_REL| · thickness = REL_LEN</div>
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
                onPointHover={setHoveredPointId}
                onPointClick={setSelectedId}
                onClose={() => {
                  setSelectedPylonKey(null);
                  setHoveredPointId(null);
                }}
                emptyHint="No InSAR points are linked to this pylon."
                title={`Poláky · Pylon ${selectedPylon?.properties?.id ?? selectedPylonKey} · 3D feature space`}
              />
            </div>
          )}

          {selectedFeature && (
            <div style={{
              position: 'relative',
              flex: selectedPylonKey != null ? '3 1 0' : '1 1 auto',
              minHeight: 0,
            }}>
              <TimelineChart feature={selectedFeature} onClose={() => setSelectedId(null)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

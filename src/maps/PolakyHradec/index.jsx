import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { SphereGeometry } from '@luma.gl/engine';
import { CogTerrainLayer, extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import chroma from 'chroma-js';
import { scaleLinear } from 'd3-scale';
import { DrawingOverlay, normalizeGeometry, pointInPolygon } from '../../components/PointSelection';
import { BLUE_PALETTE, FeatureSpaceChart } from '../../components/FeatureSpaceChart3D';
import TimelineChart from './TimelineChart';
import SelectionToolbar from './SelectionToolbar';

const DATA_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_95D_PS.geojson';
const TERRAIN_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/EL-GRID_COGeoN.tif';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const PYLONS_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/sloupy.geojson';
const PYLON_ASSET_BASE = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets';

const PYLON_COLOR = [183, 188, 193, 255];
// Native heights come from the OBJ headers (metres, Z-up, base centre at origin).
// Each instance is scaled to its GeoJSON `height`; see getPylonHeight below.
const PYLON_MODELS = [
  { typ: 'dunaj', nativeHeight: 40.0, mesh: `${PYLON_ASSET_BASE}/dunaj.obj` },
  { typ: 'kocka', nativeHeight: 26.7, mesh: `${PYLON_ASSET_BASE}/kocka.obj` },
  { typ: 'portal', nativeHeight: 29.169, mesh: `${PYLON_ASSET_BASE}/portal.obj` },
];

// Exact 3d-feature-charts ramp (red -> yellow -> teal) on the VEL_AVG domain.
const colorScale = chroma
  .scale([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
  .domain([-1, 1]);

const sphereGeometry = new SphereGeometry();

// Sphere radius in metres (LNGLAT positions are world units, i.e. metres),
// scaled by coherence: larger sphere = more coherent point.
const SPHERE_RADIUS_FALLBACK = 4;
const coherenceSizeScale = scaleLinear([0.5, 1], [2, 6]).clamp(true);

// Shared cyan for every "selected" highlight on the map.
const SELECTION_COLOR = [66, 212, 244];

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

// Spheres use the measured ellipsoidal height H as-is, with no datum conversion.
// H is 368.5-452.5 m across the site while the orthometric EL-GRID terrain is
// ~45 m lower, so spheres intentionally float above the draped surface.
function getSphereRadius(feature) {
  const coherence = Number(feature?.properties?.COH);
  return Number.isFinite(coherence) ? coherenceSizeScale(coherence) : SPHERE_RADIUS_FALLBACK;
}

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

function getRgba(feature) {
  // chroma 2.x scales extrapolate outside the domain; clamp so the few stations
  // past ±1 stay at the ramp endpoints instead of producing bad channels.
  const value = Number(feature?.properties?.VEL_AVG ?? 0);
  const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const [r, g, b] = colorScale(clamped).rgb();
  return [r, g, b, 255];
}

function formatNumber(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

export default function PolakyHradec() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();
  const [features, setFeatures] = useState([]);
  const [pylonFeatures, setPylonFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  // 3D chart panel + drawing state.
  const [showChart, setShowChart] = useState(true);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [selectionMode, setSelectionMode] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawnGeometry, setDrawnGeometry] = useState(null);
  const [selectedFeatures, setSelectedFeatures] = useState(null);
  const [hoveredPointId, setHoveredPointId] = useState(null);

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

  const hoveredFeature = useMemo(() => {
    if (hoveredPointId == null) return null;
    return features.find(f => String(f.properties?.ID) === String(hoveredPointId)) ?? null;
  }, [features, hoveredPointId]);

  // Circle/polygon selection for the 3D feature-space chart.
  const applySelection = useCallback((geometry) => {
    const selected = features.filter(feature => {
      const [lon, lat] = feature.geometry?.coordinates ?? [];
      return Number.isFinite(lon) && Number.isFinite(lat) && pointInPolygon([lon, lat], geometry);
    });

    setSelectedFeatures({
      type: 'FeatureCollection',
      features: selected.map(feature => ({
        type: 'Feature',
        id: feature.properties?.ID ?? null,
        geometry: feature.geometry,
        properties: {
          ...feature.properties,
          point_id: feature.properties?.ID ?? null,
        },
      })),
    });
  }, [features]);

  // Re-run when the drawn geometry changes and again once the GeoJSON arrives
  // (a selection drawn before the fetch resolves would otherwise stay empty).
  useEffect(() => {
    if (drawnGeometry) applySelection(drawnGeometry);
  }, [applySelection, drawnGeometry]);

  const handleModeChange = useCallback((mode) => {
    if (selectionMode === mode) {
      setSelectionMode(null);
      setIsDrawing(false);
    } else {
      setSelectionMode(mode);
      setIsDrawing(true);
    }
  }, [selectionMode]);

  const handleGeometryComplete = useCallback((mode, coords) => {
    const geoCoords = coords
      .map(c => (Array.isArray(c) ? c : c?.geo))
      .filter(c => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));

    const geometry = normalizeGeometry(mode, geoCoords, 0);
    setIsDrawing(false);
    // The selection itself is applied by the effect above.
    if (geometry) setDrawnGeometry(geometry);
  }, []);

  const handleClear = useCallback(() => {
    setSelectionMode(null);
    setIsDrawing(false);
    setDrawnGeometry(null);
    setSelectedFeatures(null);
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
      // Picking the terrain is only needed while drawing a selection: it yields
      // the true 3D click coordinate (pickable: '3d').
      pickable: isDrawing ? '3d' : false,
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

    // Persistent outline of the circle/polygon used for the chart selection.
    const selectionBoundaryLayer = drawnGeometry
      ? new GeoJsonLayer({
          id: 'selection-boundary',
          data: { type: 'Feature', properties: {}, geometry: drawnGeometry },
          filled: true,
          stroked: true,
          getFillColor: [...SELECTION_COLOR, 40],
          getLineColor: [...SELECTION_COLOR, 220],
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          lineWidthMinPixels: 2,
          pickable: false,
        })
      : null;

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
        // The data carries no bearing, so pylons stay axis-aligned.
        getOrientation: () => [0, 0, 0],
        getColor: () => PYLON_COLOR,
        material: { ambient: 0.42, diffuse: 0.65, shininess: 24, specularColor: [60, 64, 70] },
        extensions: [new TerrainExtension()],
        terrainDrawMode: 'offset',
        pickable: false,
      });
    });

    const sphereLayer = new SimpleMeshLayer({
      id: 'vel-avg-spheres',
      data: features,
      mesh: sphereGeometry,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      pickable: true,
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getColor: getRgba,
      // Selection is shown by the ring, not by scaling the mesh.
      getScale: (d) => {
        const radius = getSphereRadius(d);
        return [radius, radius, radius];
      },
    });

    // SimpleMeshLayer has no outline, so mark the selection with a billboard ring.
    const selectionRing = new ScatterplotLayer({
      id: 'selected-point-ring',
      data: selectedFeature ? [selectedFeature] : [],
      pickable: false,
      filled: false,
      stroked: true,
      billboard: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getRadius: 8,
      getLineWidth: 2,
      getLineColor: [66, 212, 244, 255],
    });

    // Ring around every point selected by the circle/polygon drawing.
    const selectedPointsRing = new ScatterplotLayer({
      id: 'selected-points-rings',
      data: selectedFeatures?.features ?? [],
      pickable: false,
      filled: false,
      stroked: true,
      billboard: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getRadius: 5,
      getLineWidth: 1.5,
      getLineColor: [...SELECTION_COLOR, 255],
    });

    // Chart hover -> map highlight (red, matching the other sandbox maps).
    const hoveredRing = new ScatterplotLayer({
      id: 'hovered-point-ring',
      data: hoveredFeature ? [hoveredFeature] : [],
      pickable: false,
      filled: false,
      stroked: true,
      billboard: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getRadius: 7,
      getLineWidth: 2,
      getLineColor: [255, 0, 0, 255],
    });

    return [
      terrainLayer,
      satelliteLayer,
      selectionBoundaryLayer,
      ...pylonLayers,
      sphereLayer,
      selectedPointsRing,
      selectionRing,
      hoveredRing,
    ].filter(Boolean);
  }, [
    zRange,
    onZRangeUpdate,
    features,
    pylonGroups,
    selectedFeature,
    hoveredFeature,
    isDrawing,
    drawnGeometry,
    selectedFeatures,
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
        onViewStateChange={({ viewState: next }) => setViewState(next)}
        getCursor={() => (isDrawing ? 'crosshair' : 'grab')}
        controller={{
          dragRotate: !isDrawing,
          touchRotate: !isDrawing,
          dragPan: !isDrawing,
          scrollZoom: !isDrawing,
          keyboard: !isDrawing,
        }}
        layers={layers}
        onClick={(info) => {
          if (isDrawing) {
            // The 3D overlay listens for these events (DrawingOverlay is3D).
            const terrain = extractTerrainCoordinate(info);
            const lon = terrain?.longitude ?? info.coordinate?.[0];
            const lat = terrain?.latitude ?? info.coordinate?.[1];
            if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
            window.dispatchEvent(new CustomEvent('map3dDrawingClick', {
              detail: {
                geo: [lon, lat],
                screenPos: [info.x, info.y],
                elevation: terrain?.elevation ?? info.coordinate?.[2],
              },
            }));
            return;
          }
          setSelectedId(info.object?.properties?.ID ?? null);
        }}
        onDoubleClick={(info) => {
          if (isDrawing) {
            // Finish the polygon without deck.gl zooming on the double-click.
            info.isPrimary = false;
            info.rightButton = false;
            info.leftButton = false;
            info.middleButton = false;
            // deck.gl swallows the native dblclick on its canvas, so finalize
            // through the same event DrawingOverlay uses for its finish button.
            window.dispatchEvent(new CustomEvent('finalizeDrawing'));
          }
        }}
        getTooltip={({ object }) => {
          if (isDrawing) return null;
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
        }}
        deviceProps={{ waitForPageLoad: false }}
        className="deckgl-map"
      />

      <DrawingOverlay
        viewState={viewState}
        selectionMode={selectionMode}
        isDrawing={isDrawing}
        onGeometryComplete={handleGeometryComplete}
        bufferDistance={0}
        is3D
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

      <SelectionToolbar
        selectionMode={selectionMode}
        isDrawing={isDrawing}
        selectedCount={selectedFeatures?.features.length ?? 0}
        onModeChange={handleModeChange}
        onClear={handleClear}
      />

      <button
        type="button"
        onClick={() => setShowChart(v => !v)}
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 1200,
          padding: '6px 12px',
          border: '1px solid #ccc',
          borderRadius: '6px',
          background: showChart ? '#0066cc' : 'rgba(255, 255, 255, 0.95)',
          color: showChart ? '#fff' : '#333',
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        }}
      >
        {showChart ? 'Hide 3D chart' : '3D chart'}
      </button>

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
        <div style={{ marginTop: '4px', color: '#555' }}>Sphere size = COH</div>
      </div>

      {selectedFeature && (
        <TimelineChart feature={selectedFeature} onClose={() => setSelectedId(null)} />
      )}

      {showChart && (
        <div style={{
          position: 'absolute',
          right: 12,
          bottom: 344,
          width: '460px',
          maxWidth: 'calc(100% - 24px)',
          height: '380px',
          zIndex: 1100,
        }}>
          <FeatureSpaceChart
            featureCollection={selectedFeatures}
            embedded
            profileDisabled
            defaultPreset="custom"
            defaultCustomAxes={{ x: 'lon', y: 'lat', z: 'H_REF', color: 'VEL_AVG', size: 'COH' }}
            attributeKeys={chartAttributeKeys}
            colorPalette={BLUE_PALETTE}
            onPointHover={setHoveredPointId}
            title="Poláky · 3D feature space"
          />
        </div>
      )}
    </div>
  );
}

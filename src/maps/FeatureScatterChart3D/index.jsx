import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DeckGL } from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, GeoJsonLayer, ScatterplotLayer, SolidPolygonLayer, PathLayer } from '@deck.gl/layers';
import { CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { SelectionControls, DrawingOverlay, pointInPolygon, normalizeGeometry, buildLineCorridor } from '../../components/PointSelection';
import { FeatureSpaceChart, buildCurtainGeometry, curtainZDomain, hexToRgba, TREND_WINDOWS, TREND_TIMELINE, SETTLEMENT_KEYS, withSettlement, MAP_VELOCITY_COLORS, getColorDomain } from '../../components/FeatureSpaceChart3D';
import { buildProfileSamples, sampleLineSelection } from '../../components/2DLineProfile';
import chroma from 'chroma-js';
import { scaleLinear } from 'd3-scale';

const INITIAL_VIEW_STATE = {
  longitude: 38.561713,
  latitude:   35.860611,
  zoom: 16,
  pitch: 0,
  bearing: 0,
};

// Tabqa (Syria) pre-calculated relief "glaze" DEM, copied from the Tabqa dam map.
const PRECALCULATED_GLAZE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_tabqa_kudairan_cropped_final_glaze_overlay_z4_bilinear_cog.tif';
const DATA_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/Tabqua_LOS_selected.geojson';

// Map marker colours share the (reversed) chart scale so red = negative.
const colorScale = chroma
  .scale(MAP_VELOCITY_COLORS)
  .domain([-3, 3]);

// Per-point scatter radius (pixels) from |VEL_REL|.
const sizeScale = scaleLinear([0, 5], [3, 8]).clamp(true);

// Fill alpha for the trend-window curtains (transparent walls, one per window).
const TREND_WALL_ALPHA = 55;

// Shared highlight colour for a selection: used both for the selected point
// borders and for the persistent selection-boundary layer, so they always match.
const SELECTION_COLOR = [66, 212, 244];

/** One curtain per raw trend window, on a single shared Z domain. */
function buildTrendCurtains(samples) {
  const domain = curtainZDomain(samples, TREND_WINDOWS.map((w) => w.key));
  if (!domain) return [];
  return TREND_WINDOWS
    .map((w) => ({ key: w.key, color: w.color, geometry: buildCurtainGeometry(samples, w.key, { domain }) }))
    .filter((c) => c.geometry.quads.length > 0);
}

/**
 * One curtain per settlement timeline step, all on a single shared Z domain so
 * their heights are comparable. The per-step cumulative-settlement values are
 * materialised on the samples via `withSettlement`.
 */
function buildSettlementCurtains(samples) {
  const withValues = withSettlement(samples);
  const domain = curtainZDomain(withValues, SETTLEMENT_KEYS);
  if (!domain) return [];
  return SETTLEMENT_KEYS
    .map((key, i) => ({ key, color: TREND_TIMELINE[i].color, geometry: buildCurtainGeometry(withValues, key, { domain }) }))
    .filter((c) => c.geometry.quads.length > 0);
}

/** Flat 2D map view (no rotation); avoids a new MapView per render. */
const mapView = new MapView({ repeat: true });

// Helper to consistently get a point's ID (Tabqa: ID, fallback fid).
const getPointId = (feature) => {
  if (!feature) return null;
  const p = feature.properties;
  if (p) {
    const id = p.ID ?? p.fid;
    if (id !== undefined && id !== null) return id;
  }
  if (feature.id !== undefined && feature.id !== null) return feature.id;
  if (feature.geometry?.coordinates?.length >= 2) {
    return `${feature.geometry.coordinates[0]}_${feature.geometry.coordinates[1]}`;
  }
  return null;
};

export default function FeatureScatterChart3D() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [selectionMode, setSelectionMode] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [bufferDistance, setBufferDistance] = useState(20);
  const [drawnGeometry, setDrawnGeometry] = useState(null);
  const [selectedPoints, setSelectedPoints] = useState([]);
  const [selectedFeatures, setSelectedFeatures] = useState(null);
  const [hoveredPointId, setHoveredPointId] = useState(null);
  const [allFeatures, setAllFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [drawnLineCoords, setDrawnLineCoords] = useState(null);
  // The 3D feature-space chart is the whole point of this app, so it starts open.
  const [showFeatureSpace, setShowFeatureSpace] = useState(true);
  // Effective chart mode / profile view / Z attribute / basis, reported by
  // FeatureSpaceChart.
  const [chartState, setChartState] = useState(null);

  const mapContainerRef = useRef(null);

  // Handle double-click to finish drawing
  useEffect(() => {
    const handleDblClick = () => {
      if (isDrawing && drawnGeometry) {
        setIsDrawing(false);
      }
    };

    const container = mapContainerRef.current;
    if (container) {
      container.addEventListener('dblclick', handleDblClick);
      return () => container.removeEventListener('dblclick', handleDblClick);
    }
  }, [isDrawing, drawnGeometry]);

  // Auto-start drawing when selection mode is activated
  useEffect(() => {
    if (selectionMode) {
      setIsDrawing(true);
    }
  }, [selectionMode]);

  // Load GeoJSON data on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const res = await fetch(DATA_URL);
        const data = await res.json();
        // Handle both FeatureCollection and direct array formats
        let features = Array.isArray(data) ? data : (data.features || []);
        setAllFeatures(features);
        setIsLoading(false);
      } catch (err) {
        console.error('❌ Failed to load data:', err);
        setIsLoading(false);
      }
    };
    loadData();
  }, []);

  // String keys: Tabqa `ID`s are numeric, and lookups use String(pointId).
  const selectedIdsSet = new Set(selectedPoints.map(p => String(p.id)));

  const baseMapLayer = new TileLayer({
    id: 'osm-basemap',
    data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props) => {
      const { west, south, east, north } = props.tile.bbox;
      return new BitmapLayer(props, {
        data: null,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });

  const precalculatedGlaze = new CogBitmapLayer({
    id: 'glaze-precalculated',
    rasterData: PRECALCULATED_GLAZE_URL,
    isTiled: true,
    opacity: 0.2,
    cogBitmapOptions: {
      type: 'image',
      useHeatMap: true,
      colorScaleValueRange: [0, 255],
      colorScale: ['#283250', '#283250'],
      useDataForOpacity: true,
    },
  });

  const isPointSelected = (feature) => {
    const pointId = getPointId(feature);
    return pointId ? selectedIdsSet.has(String(pointId)) : false;
  };

  // Chart-driven hover: `hoveredPointId` is reported by FeatureSpaceChart and
  // holds the same id space as the InSAR points (and the curtain nodes).
  const isHovered = (id) => hoveredPointId != null && String(hoveredPointId) === String(id);

  const pointLayer = new ScatterplotLayer({
    id: 'points-2d',
    data: allFeatures,
    pickable: true,
    getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
    getRadius: (d) => {
      const size = sizeScale(Math.abs(d.properties?.VEL_REL || 0));
      return isPointSelected(d) ? size * 1.3 : size;
    },
    radiusUnits: 'pixels',
    radiusMinPixels: 1,
    radiusMaxPixels: 20,
    billboard: true,
    // Selection/hover is shown as a border only, so the fill keeps encoding
    // VEL_REL through the colour scale.
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineColor: (d) => {
      if (isHovered(getPointId(d))) {
        return [255, 0, 0, 255]; // red border for hovered
      }

      if (isPointSelected(d)) {
        return [...SELECTION_COLOR, 255]; // cyan border for selected
      }

      return [0, 0, 0, 0];
    },
    getLineWidth: (d) => {
      if (isHovered(getPointId(d))) {
        return 2;
      }

      if (isPointSelected(d)) {
        return 2;
      }

      return 0;
    },
    getFillColor: (d) => {
      if (selectedIdsSet.size > 0 && !isPointSelected(d)) {
        return [200, 200, 200, 100]; // grey for dimmed
      }

      return [...colorScale(d.properties?.VEL_REL || 0).rgb(), 255];
    },
    updateTriggers: {
      getFillColor: [selectedPoints, hoveredPointId],
      getRadius: [selectedPoints],
      getLineColor: [selectedPoints, hoveredPointId],
      getLineWidth: [selectedPoints, hoveredPointId]
    }
  });

  // `geometry` is the normalised polygon for circle/polygon modes. Line mode
  // instead uses a perpendicular projection of `lineCoords` (flat-ended: a point
  // is kept only when its perpendicular foot lands inside the line and within
  // the buffer), so no turf corridor is involved.
  const applySelection = useCallback((geometry, mode, lineCoords) => {
    const selected = mode === 'line'
      ? sampleLineSelection(allFeatures, lineCoords, bufferDistance).map(r => r.feature)
      : allFeatures.filter(feature => {
          const [lon, lat] = feature.geometry?.coordinates || [0, 0];
          return pointInPolygon([lon, lat], geometry);
        });

    const result = selected.map(f => ({
      id: getPointId(f) ?? `${f.geometry?.coordinates?.[0]}_${f.geometry?.coordinates?.[1]}`,
      properties: f.properties
    }));

    setSelectedPoints(result);

    setSelectedFeatures({
      type: 'FeatureCollection',
      features: selected.map(f => {
        const pointId = getPointId(f);
        return {
          type: 'Feature',
          id: pointId,
          geometry: f.geometry,
          properties: {
            ...f.properties,
            point_id: pointId,
          }
        };
      })
    });
  }, [allFeatures, bufferDistance]);

  const handleGeometryComplete = (geometry, mode, coords) => {
    if (!geometry) return;

    setDrawnGeometry(geometry);
    setIsDrawing(false);

    if (mode === 'line') {
      const geoCoords = coords.map(c => c.geo || c);
      setDrawnLineCoords(geoCoords);
      applySelection(geometry, 'line', geoCoords);
    } else {
      setDrawnLineCoords(null);
      applySelection(geometry, mode, null);
    }
  };

  // SelectionControls owns no state of its own (unlike SelectionAnalysisPanel),
  // so the mode/geometry wiring the panel used to provide must live here.
  const handleModeChange = (newMode) => {
    if (selectionMode === newMode) {
      setSelectionMode(null);
      setIsDrawing(false);
    } else {
      setSelectionMode(newMode);
      setIsDrawing(true);
    }
  };

  const handleGeometryCompleteInternal = (mode, coords, buffer) => {
    // Coords can be an array of [lon, lat] or an array of {geo: [lon, lat], ...} for 3D.
    // Extract the numerical coordinates before passing to turf/normalize functions.
    const geoCoords = coords.map(c => (Array.isArray(c) ? c : c.geo));
    const geometry = normalizeGeometry(mode, geoCoords, buffer);
    // Pass the original geometry AND the original coords back up.
    handleGeometryComplete(geometry, mode, coords);
  };

  const handleClear = () => {
    setSelectedPoints([]);
    setDrawnGeometry(null);
    setSelectedFeatures(null);
    setDrawnLineCoords(null);
    setSelectionMode(null);
    setIsDrawing(false);
  };

  // Re-run the line projection when the buffer distance changes, and again once
  // the GeoJSON arrives: a line completed before the fetch resolves would
  // otherwise select from the still-empty `allFeatures` and stay empty until the
  // buffer changed.
  useEffect(() => {
    if (selectionMode !== 'line' || !drawnLineCoords || drawnLineCoords.length < 2) return;
    applySelection(null, 'line', drawnLineCoords);
  }, [bufferDistance, drawnLineCoords, selectionMode, applySelection]);

  // Ordered single-curve profile samples for the 3D chart (app-owned; the chart
  // module stays portable and only consumes the prepared samples, then lets the
  // user switch the Y/Z axes client-side).
  const profileSamples = useMemo(
    () => buildProfileSamples(selectedFeatures, drawnLineCoords),
    [selectedFeatures, drawnLineCoords],
  );

  // The 3D line-profile mode is only offered while the line tool is in use (or
  // once a line selection has been drawn).
  const showProfile = selectionMode === 'line'
    || (Array.isArray(drawnLineCoords) && drawnLineCoords.length >= 2);
  // A polygon/circle selection has no line, so the chart's profile mode is off.
  const profileDisabled = selectionMode === 'polygon' || selectionMode === 'circle';

  // The attribute curtain exists only when a line selection is present AND the
  // chart is in the 3D line-profile Attribute view on the Lon/Lat basis (the
  // Trend view keeps a stale `basis`, so gate on the view too).
  const lineActive = Array.isArray(drawnLineCoords) && drawnLineCoords.length >= 2;
  const curtainZKey = (chartState?.mode === 'profile'
    && chartState?.view === 'attributes'
    && chartState?.basis === 'plan')
    ? chartState.zKey
    : null;
  const curtain = useMemo(
    () => (lineActive && curtainZKey ? buildCurtainGeometry(profileSamples, curtainZKey) : null),
    [lineActive, curtainZKey, profileSamples],
  );
  const curtainScale = useMemo(
    () => (curtainZKey
      ? chroma.scale(MAP_VELOCITY_COLORS).domain(getColorDomain(curtainZKey, profileSamples))
      : null),
    [curtainZKey, profileSamples],
  );

  // The Trend view stacks one curtain per series on a single shared Z domain:
  // raw per-window displacement for `windows`, cumulative settlement per timeline
  // step for `profiles`. `points` (one curve per location) has no curtain.
  const trendShape = chartState?.mode === 'profile' && chartState?.view === 'trend'
    ? chartState.trendLines
    : null;
  const trendCurtains = useMemo(() => {
    if (!lineActive) return [];
    if (trendShape === 'windows') return buildTrendCurtains(profileSamples);
    if (trendShape === 'profiles') return buildSettlementCurtains(profileSamples);
    return [];
  }, [lineActive, trendShape, profileSamples]);

  // One curtain = walls + top/base edges + nodes; callers supply the colours (a
  // value-driven scale for the attribute curtain, a flat window colour for the
  // trend curtains).
  const curtainLayerSet = (id, geometry, { fillColor, nodeColor, lineColor }) => [
    new SolidPolygonLayer({
      id: `${id}-walls`,
      data: geometry.quads,
      // deck.gl's tesselator wants "already normalized" flat positions when
      // `_normalize` is off, so flatten the nested ring here.
      getPolygon: (d) => d.polygon.flat(),
      getFillColor: fillColor,
      extruded: false,
      // Keep the vertical walls planar instead of geodesically normalising them
      // back onto the earth surface, and tessellate in the plane that actually
      // has area (a vertical quad is degenerate in XY, so without `_full3d`
      // earcut emits no triangles and the wall is invisible).
      _normalize: false,
      _full3d: true,
      pickable: false,
    }),
    new PathLayer({
      id: `${id}-edge`,
      data: [geometry.path],
      getPath: (d) => d,
      getColor: lineColor,
      widthUnits: 'pixels',
      getWidth: 2,
      pickable: false,
    }),
    new PathLayer({
      id: `${id}-base`,
      data: [geometry.base],
      getPath: (d) => d,
      getColor: lineColor,
      widthUnits: 'pixels',
      getWidth: 2,
      pickable: false,
    }),
    new ScatterplotLayer({
      id: `${id}-nodes`,
      data: geometry.nodes,
      getPosition: (d) => d.position,
      radiusUnits: 'pixels',
      getRadius: 3,
      radiusMinPixels: 2,
      radiusMaxPixels: 8,
      billboard: true,
      getFillColor: nodeColor,
      // Mirror the chart-hover highlight: a red outline on the node whose id the
      // chart reports via `onPointHover` (same ids as the InSAR points).
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: (d) => (isHovered(d.id) ? 2 : 0),
      getLineColor: (d) => (isHovered(d.id) ? [255, 0, 0, 255] : [0, 0, 0, 0]),
      updateTriggers: {
        getLineWidth: [hoveredPointId],
        getLineColor: [hoveredPointId],
      },
      pickable: false,
    }),
  ];

  const curtainLayers = [];
  if (curtain && curtain.quads.length > 0) {
    curtainLayers.push(...curtainLayerSet('curtain', curtain, {
      fillColor: (d) => [...curtainScale(d.value).rgb(), 150],
      nodeColor: (d) => [...curtainScale(d.value).rgb(), 255],
      lineColor: [110, 110, 110, 220],
    }));
  }
  for (const tc of trendCurtains) {
    const color = hexToRgba(tc.color, 255);
    curtainLayers.push(...curtainLayerSet(`trend-curtain-${tc.key}`, tc.geometry, {
      fillColor: hexToRgba(tc.color, TREND_WALL_ALPHA),
      nodeColor: color,
      lineColor: color,
    }));
  }

  // Persistent selection boundary, kept on the map after drawing finishes (unlike
  // the transient canvas overlay, which is cleared once drawing stops). For line
  // mode the boundary is a flat-ended (butt-cap) buffer corridor around the line,
  // rebuilt from `drawnLineCoords` so it tracks the buffer-distance slider live and
  // matches the flat-ended line selection (`sampleLineSelection`).
  const selectionBoundary = useMemo(() => {
    if (selectionMode === 'line' && Array.isArray(drawnLineCoords) && drawnLineCoords.length >= 2) {
      return buildLineCorridor(drawnLineCoords, bufferDistance);
    }
    return drawnGeometry;
  }, [selectionMode, drawnLineCoords, bufferDistance, drawnGeometry]);

  const selectionBoundaryLayer = selectionBoundary
    ? new GeoJsonLayer({
        id: 'selection-boundary',
        data: { type: 'Feature', properties: {}, geometry: selectionBoundary },
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

  const layers = [
    baseMapLayer,
    precalculatedGlaze,
    selectionBoundaryLayer,
    pointLayer,
    ...curtainLayers,
  ].filter(Boolean);

  return (
    <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        getCursor={() => isDrawing ? 'crosshair' : 'grab'}
        onDoubleClick={(info) => {
          if (isDrawing) {
            // Prevent zoom on double-click during drawing
            info.isPrimary = false;
            info.rightButton = false;
            info.leftButton = false;
            info.middleButton = false;
          }
        }}
        controller={{
          dragPan: !isDrawing,
          scrollZoom: !isDrawing,
          dragRotate: !isDrawing,
          doubleClickZoom: !isDrawing,
        }}
        views={mapView}
        layers={layers}
        className="deckgl-map"
      />

      {isLoading && (
        <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '10px', borderRadius: '4px' }}>
          Loading data...
        </div>
      )}

      <SelectionControls
        top="10px"
        left="10px"
        selectionMode={selectionMode}
        onModeChange={handleModeChange}
        bufferDistance={bufferDistance}
        onBufferChange={setBufferDistance}
        bufferMin={10}
        bufferMax={200}
        selectedCount={selectedPoints.length}
        onClear={handleClear}
        showLineProfileToggle={false}
        isLoadingBackend={isLoading}
      />

      <DrawingOverlay
        viewState={viewState}
        selectionMode={selectionMode}
        isDrawing={isDrawing}
        onGeometryComplete={handleGeometryCompleteInternal}
        bufferDistance={bufferDistance}
        is3D={false}
      />

      <button
        onClick={() => setShowFeatureSpace(v => !v)}
        style={{
          position: 'absolute',
          top: '10px',
          right: showFeatureSpace ? 'calc(min(45%, 720px) + 10px)' : '10px',
          background: showFeatureSpace ? '#0066cc' : 'rgba(255, 255, 255, 0.95)',
          color: showFeatureSpace ? '#fff' : '#333',
          border: '1px solid #ccc',
          borderRadius: '6px',
          padding: '6px 12px',
          cursor: 'pointer',
          fontSize: '12px',
          fontFamily: 'system-ui, sans-serif',
          fontWeight: 600,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          zIndex: 1200,
        }}
      >
        {showFeatureSpace ? 'Hide 3D feature space' : '3D feature space'}
      </button>

      {showFeatureSpace && (
        <FeatureSpaceChart
          featureCollection={selectedFeatures}
          profileSamples={profileSamples}
          showProfile={showProfile}
          profileDisabled={profileDisabled}
          onPointHover={setHoveredPointId}
          onStateChange={setChartState}
        />
      )}
    </div>
  );
}

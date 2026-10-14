import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { DeckGL } from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { SelectionControls, DrawingOverlay, pointInPolygon, normalizeGeometry } from '../../components/PointSelection';
import { FeatureSpaceChart } from '../../components/FeatureSpaceChart3D';
import { buildProfileSamples } from '../../components/2DLineProfile';
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

const colorScale = chroma
  .scale([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
  .domain([-3, 3]);

// Per-point scatter radius (pixels) from |VEL_REL|.
const sizeScale = scaleLinear([0, 5], [3, 8]).clamp(true);

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
      const pointId = getPointId(d);

      if (hoveredPointId && String(hoveredPointId) === String(pointId)) {
        return [255, 0, 0, 255]; // red border for hovered
      }

      if (isPointSelected(d)) {
        return [66, 212, 244, 255]; // cyan border for selected
      }

      return [0, 0, 0, 0];
    },
    getLineWidth: (d) => {
      const pointId = getPointId(d);

      if (hoveredPointId && String(hoveredPointId) === String(pointId)) {
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

  const applySelection = useCallback((geometry) => {
    const selected = allFeatures.filter(feature => {
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
  }, [allFeatures]);

  const handleGeometryComplete = (geometry, mode, coords) => {
    if (!geometry) return;

    setDrawnGeometry(geometry);
    setIsDrawing(false);

    if (mode === 'line') {
      const geoCoords = coords.map(c => c.geo || c);
      setDrawnLineCoords(geoCoords);
    } else {
      setDrawnLineCoords(null);
    }

    applySelection(geometry);
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

  // Recompute the line corridor and re-select when the buffer distance changes,
  // and again once the GeoJSON arrives: a line completed before the fetch
  // resolves would otherwise select from the still-empty `allFeatures` and its
  // corridor would stay empty until the buffer changed.
  useEffect(() => {
    if (selectionMode !== 'line' || !drawnLineCoords || drawnLineCoords.length < 2) return;
    const newGeometry = normalizeGeometry('line', drawnLineCoords, bufferDistance);
    if (newGeometry) {
      setDrawnGeometry(newGeometry);
      applySelection(newGeometry);
    }
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

  const layers = [
    baseMapLayer,
    precalculatedGlaze,
    pointLayer,
  ];

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
          onPointHover={setHoveredPointId}
        />
      )}
    </div>
  );
}

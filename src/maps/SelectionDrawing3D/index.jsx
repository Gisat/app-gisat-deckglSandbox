import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { DeckGL } from '@deck.gl/react';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SelectionAnalysisPanel, pointInPolygon, normalizeGeometry } from '../../components/PointSelection';
import { setDeckGLInstance } from '../../components/PointSelection/drawingUtils';
import { CogTerrainLayer, extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';
import chroma from 'chroma-js';
import { scaleLinear } from 'd3-scale';
import { calculateProfileData } from '../../components/2DLineProfile';

const INITIAL_VIEW_STATE = {
  longitude: 14.015511800867504,
  latitude: 50.571906640192161,
  zoom: 14.5,
  pitch: 50,
  bearing: 0,
};

const colorScale = chroma
  .scale([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
  .domain([-5, 5]);

const sphereGeometry = new SphereGeometry();
const sizeScale = scaleLinear([0, 5], [2, 7]).clamp(true);

// Data URL
const DATA_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3.json';

// Helper to consistently get a point's ID
const getPointId = (feature) => {
    if (!feature || !feature.properties) return null;
    return feature.properties.id_global ?? feature.properties.id_orig;
};

export default function SelectionDrawing3D() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [selectionMode, setSelectionMode] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [bufferDistance, setBufferDistance] = useState(100);
  const [drawnGeometry, setDrawnGeometry] = useState(null);
  const [selectedPoints, setSelectedPoints] = useState([]);
  const [selectedFeatures, setSelectedFeatures] = useState(null);
  const [hoveredPointId, setHoveredPointId] = useState(null);
  const [allFeatures, setAllFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [drawnLineCoords, setDrawnLineCoords] = useState(null);

  const mapContainerRef = useRef(null);
  const deckGLRef = useRef(null);

  // Set DeckGL instance for terrain picking utilities
  useEffect(() => {
    if (deckGLRef.current) setDeckGLInstance(deckGLRef.current);
  }, []);

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

  const selectedIdsSet = new Set(selectedPoints.map(p => p.id));

  const baseMapLayer = new TileLayer({
    id: 'tile-layer-selection-drawing',
    data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
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

  const terrainLayer = new CogTerrainLayer({
    id: 'terrain-layer',
    elevationData: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/LITC52_53_4g_5m_4326_cog_nodata.tif',
    minZoom: 12,
    maxZoom: 14,
    isTiled: true,
    useChannel: null,
    tileSize: 256,
    operation: 'terrain+draw',
    pickable: '3d',
    visible: true,
    terrainOptions: {
      useSwissRelief: true,
      useHeatMap: true,
      colorScale: [[200, 200, 200], [180, 180, 180]],
      type: 'terrain',
    },
  });

  const isPointSelected = (feature) => {
    const pointId = getPointId(feature);
    return pointId ? selectedIdsSet.has(String(pointId)) : false;
  };

  const meshLayer = new SimpleMeshLayer({
    id: 'mesh-3d-selection-drawing',
    data: allFeatures,
    mesh: sphereGeometry,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    pickable: true,
    getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm || 0],
    getColor: (d) => {
      const pointId = getPointId(d);
      
      if (hoveredPointId && String(hoveredPointId) === String(pointId)) {
        return [255, 0, 0, 255]; // Bright red for hovered
      }
      
      if (isPointSelected(d)) {
        return [66, 212, 244, 255]; // cyan for selected
      }
      
      if (selectedIdsSet.size > 0) {
        return [200, 200, 200, 100]; // grey for dimmed
      }
      
      return [...colorScale(d.properties?.vel_rel || 0).rgb(), 255];
    },
    getScale: (d) => {
      const size = sizeScale(Math.abs(d.properties?.vel_rel || 0));
      const isSelected = isPointSelected(d);
      return [isSelected ? size * 1.3 : size, isSelected ? size * 1.3 : size, isSelected ? size * 1.3 : size];
    },
    updateTriggers: {
      getColor: [selectedPoints, hoveredPointId],
      getScale: [selectedPoints]
    }
  });

  const profileData = useMemo(() => {
    if (selectedFeatures && drawnLineCoords) {
        return calculateProfileData(selectedFeatures, drawnLineCoords, ['vel_rel', 'vel_last']);
    }
    return null;
  }, [selectedFeatures, drawnLineCoords]);

  const applySelection = useCallback((geometry) => {
    const selected = allFeatures.filter(feature => {
      const [lon, lat] = feature.geometry?.coordinates || [0, 0];
      return pointInPolygon([lon, lat], geometry);
    });

    const result = selected.map(f => ({
      id: getPointId(f) ?? `${f.geometry?.coordinates?.[0]}_${f.geometry?.coordinates?.[1]}`,
      properties: f.properties
    }));

    console.log('Selected points:', result);
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
            mean_velocity: f.properties?.vel_rel ?? f.properties?.mean_velocity ?? null,
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

  // Recompute the line corridor and re-select when buffer distance changes after a line is drawn
  useEffect(() => {
    if (selectionMode !== 'line' || !drawnLineCoords || drawnLineCoords.length < 2) return;
    const newGeometry = normalizeGeometry('line', drawnLineCoords, bufferDistance);
    if (newGeometry) {
      setDrawnGeometry(newGeometry);
      applySelection(newGeometry);
    }
  // Only re-run when buffer changes; mode/coords are handled by handleGeometryComplete
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferDistance]);

  const layers = [baseMapLayer, terrainLayer, meshLayer];

  return (
    <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckGL
        ref={deckGLRef}
        initialViewState={INITIAL_VIEW_STATE}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        getCursor={() => isDrawing ? 'crosshair' : 'grab'}
        onClick={(info) => {
          if (isDrawing && selectionMode) {
            // Try to resolve terrain coordinate even when clicking on other layers (click-through)
            const tryUseTerrainPick = async () => {
              // If clicked directly on terrain layer, use extractTerrainCoordinate
              if (info.layer?.id === 'terrain-layer' && info.coordinate) {
                const coord = extractTerrainCoordinate(info);
                if (coord) {
                  window.dispatchEvent(new CustomEvent('map3dDrawingClick', {
                    detail: { geo: [coord.longitude, coord.latitude], screenPos: [info.x, info.y], elevation: coord.elevation }
                  }));
                  return;
                }
              }

              // Otherwise, try explicit pick on the terrain layer via DeckGL instance
              const deck = deckGLRef.current;
              if (deck && typeof deck.pickObject === 'function') {
                const pick = deck.pickObject({ x: info.x, y: info.y, layerIds: ['terrain-layer'], radius: 1 });
                if (pick?.coordinate) {
                  const coord = extractTerrainCoordinate(pick);
                  if (coord) {
                    window.dispatchEvent(new CustomEvent('map3dDrawingClick', {
                      detail: { geo: [coord.longitude, coord.latitude], screenPos: [info.x, info.y], elevation: coord.elevation }
                    }));
                    return;
                  }
                }
              }

              // Fallback to basic coordinate
              window.dispatchEvent(new CustomEvent('map3dDrawingClick', {
                detail: { geo: [info.coordinate?.[0], info.coordinate?.[1]], screenPos: [info.x, info.y], elevation: info.coordinate?.[2] }
              }));
            };

            tryUseTerrainPick();
          }
        }}
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
        layers={layers}
        className="deckgl-map"
      />

      {isLoading && (
        <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '10px', borderRadius: '4px' }}>
          Loading data...
        </div>
      )}

      <SelectionAnalysisPanel
        top="10px"
        left="10px"
        selectionMode={selectionMode}
        onSelectionModeChange={setSelectionMode}
        isDrawing={isDrawing}
        onIsDrawingChange={setIsDrawing}
        bufferDistance={bufferDistance}
        onBufferDistanceChange={setBufferDistance}
        onClear={() => {
          setSelectedPoints([]);
          setDrawnGeometry(null);
          setSelectedFeatures(null);
          setDrawnLineCoords(null);
          setSelectionMode(null);
          setIsDrawing(false);
        }}
        onGeometryComplete={handleGeometryComplete}
        selectedCount={selectedPoints.length}
        selectedFeatures={selectedFeatures}
        profileData={profileData}
        isLoading={isLoading}
        lineProfileMetrics={['vel_rel', 'vel_last']}
        is3D={true}
        viewState={viewState}
        onPointHover={setHoveredPointId}
      />
    </div>
  );
}

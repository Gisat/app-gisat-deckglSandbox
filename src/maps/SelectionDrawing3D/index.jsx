import { useState, useEffect, useRef } from 'react';
import { DeckGL } from '@deck.gl/react';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SelectionControls, DrawingOverlay, TimeSeriesChart, normalizeGeometry, pointInPolygon } from '../../components/PointSelection';
import { setDeckGLInstance } from '../../components/PointSelection/drawingUtils';
import { CogTerrainLayer, extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';
import chroma from 'chroma-js';
import { scaleLinear } from 'd3-scale';

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

export default function SelectionDrawing3D() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [selectionMode, setSelectionMode] = useState(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [bufferDistance, setBufferDistance] = useState(100);
  const [drawnGeometry, setDrawnGeometry] = useState(null);
  const [selectedPoints, setSelectedPoints] = useState([]);
  const [selectedFeatures, setSelectedFeatures] = useState(null);
  const [, setHoveredPointId] = useState(null);
  const [allFeatures, setAllFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

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
    const idGlobal = feature.properties?.id_global;
    const idOrig = feature.properties?.id_orig;
    
    if (idGlobal && selectedIdsSet.has(String(idGlobal))) return true;
    if (idOrig && selectedIdsSet.has(String(idOrig))) return true;
    
    return false;
  };

  const meshLayer = new SimpleMeshLayer({
    id: 'mesh-3d-selection-drawing',
    data: allFeatures,
    mesh: sphereGeometry,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    pickable: true,
    getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm || 0],
    getColor: (d) => {
      if (isPointSelected(d)) {
        return [66, 212, 244, 255]; // cyan - selected
      }
      
      if (selectedIdsSet.size > 0) {
        return [200, 200, 200, 100]; // grey - dimmed
      }
      
      return [...colorScale(d.properties?.vel_rel || 0).rgb(), 255];
    },
    getScale: (d) => {
      const size = sizeScale(Math.abs(d.properties?.vel_rel || 0));
      const isSelected = isPointSelected(d);
      return [isSelected ? size * 1.3 : size, isSelected ? size * 1.3 : size, isSelected ? size * 1.3 : size];
    },
    updateTriggers: {
      getColor: [selectedPoints],
      getScale: [selectedPoints]
    }
  });

  const handleGeometryComplete = (mode, coords, bufferDist = 100) => {
    const geoCoords = coords.map(c => c.geo || c);
    const geometry = normalizeGeometry(mode, geoCoords, bufferDist);
    if (!geometry) return;

    setDrawnGeometry(geometry);
    setIsDrawing(false);

    // Query all features directly against geometry
    const selected = allFeatures.filter(feature => {
      const [lon, lat] = feature.geometry?.coordinates || [0, 0];
      return pointInPolygon([lon, lat], geometry);
    });

    const result = selected.map(f => ({
      id: f.properties?.id_global ?? f.properties?.id_orig ?? `${f.geometry?.coordinates?.[0]}_${f.geometry?.coordinates?.[1]}`,
      properties: f.properties
    }));

    // Log selected points (single retained debug log)
    console.log('Selected points:', result);
    setSelectedPoints(result);

    // Build a simple FeatureCollection for the TimeSeriesChart demo
    const fc = {
      type: 'FeatureCollection',
      features: selected.map(f => ({
        type: 'Feature',
        id: f.id,
        properties: {
          ...f.properties,
          // map available velocity field to mean_velocity expected by chart
          mean_velocity: f.properties?.vel_rel ?? f.properties?.mean_velocity ?? null,
          point_id: f.id,
        }
      }))
    };

    setSelectedFeatures(fc);
  };

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

      <SelectionControls
        selectionMode={selectionMode}
        onModeChange={(newMode) => {
          if (selectionMode === newMode) {
            // toggle off
            setSelectionMode(null);
            setIsDrawing(false);
          } else {
            setSelectionMode(newMode);
            setIsDrawing(true);
          }
        }}
        bufferDistance={bufferDistance}
        onBufferChange={setBufferDistance}
        selectedCount={selectedPoints.length}
        onClear={() => {
          setSelectedPoints([]);
          setDrawnGeometry(null);
          // hide chart when cleared
          setSelectedFeatures(null);
          // keep drawing active if selection mode is still selected
          setIsDrawing(selectionMode ? true : false);
        }}
        top="10px"
        left="10px"
      />

      <DrawingOverlay
        viewState={viewState}
        selectionMode={selectionMode}
        isDrawing={isDrawing}
        onGeometryComplete={handleGeometryComplete}
        bufferDistance={bufferDistance}
        is3D={true}
      />

      {selectedFeatures && (
        <div style={{
          position: 'absolute',
          bottom: '10px',
          left: '10px',
          width: 'calc(50% - 430px)',
          minWidth: '300px',
          zIndex: 999,
        }}>
          <TimeSeriesChart
            selectedFeatures={selectedFeatures}
            isLoading={false}
            onPointHover={setHoveredPointId}
          />
        </div>
      )}
    </div>
  );
}

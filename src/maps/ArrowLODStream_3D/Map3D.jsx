import { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL, WebMercatorViewport } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { SphereGeometry } from '@luma.gl/engine';
import { CogTerrainLayer, extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';
import {_TerrainExtension as TerrainExtension } from "@deck.gl/extensions";

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionControls, DrawingOverlay, TimeSeriesChart, normalizeGeometry, filterPointsByGeometryInBounds } from '../../components/PointSelection';
import ArrowLODTileLayer from '../../layers/ArrowLODTileLayer';
import { setDeckGLInstance } from '../../components/PointSelection/drawingUtils';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0 };
const BACKEND_BASE_URL = import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:5000';
const DATES_API_URL = `${BACKEND_BASE_URL}/api/dates`;
const DATA_API_URL = `${BACKEND_BASE_URL}/api/data`;

const TILE_CACHE_LIMIT = 200;

const sphere = new SphereGeometry({ radius: 1, nlat: 6, nlong: 6 });

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
    .clamp(true);

const sizeScale = scaleLinear().domain([0, 5]).range([1, 10]).clamp(true);

// 🆕 LOD LOGIC
function getTargetTier(zoom) {
    if (zoom >= 15) return 2;
    if (zoom >= 13) return 1;
    return 0;
}

// Map3D Component
function ArrowLODStream3D() {
    const [totalPoints, setTotalPoints] = useState(0);
    const [cacheSize, setCacheSize] = useState(0);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchStatus, setFetchStatus] = useState("Idle");

    // Derive currentTierDisplay from viewState.zoom (not from state)
    const currentTierDisplay = (() => {
        const t = getTargetTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        return `${t} (${percentages[t]})`;
    })();

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);

    const mapContainerRef = useRef(null);
    const deckGLRef = useRef(null);

    // Selection state
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [selectedPointIds, setSelectedPointIds] = useState(new Set());
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedFeatures, setSelectedFeatures] = useState(null);
    const [isSelectingBackend, setIsSelectingBackend] = useState(false);
    const [hoveredPointId, setHoveredPointId] = useState(null);

    const lastProcessedGeometryRef = useRef(null);

    // Set DeckGL instance for terrain picking in drawing utils
    useEffect(() => {
        if (deckGLRef.current) {
            setDeckGLInstance(deckGLRef.current);
        }
    }, []);

    // Selection: Handle geometry completion from drawing overlay
    const handleGeometryComplete = (mode, coords, bufferDist = 100) => {
        // In 3D mode, coords may contain { geo, screenPos, elevation } objects
        // Extract just the geo coordinates for normalizeGeometry
        const geoCoords = coords.map(c => c.geo || c);
        
        const geometry = normalizeGeometry(mode, geoCoords, bufferDist);
        if (!geometry) return;

        setDrawnGeometry(geometry);
        setIsDrawing(false);
    };

    // Selection: Query backend for time-series data
    const queryBackendForSelection = (pointIds) => {
        if (!pointIds || pointIds.length === 0) return;

        setIsSelectingBackend(true);
        
        const payload = {
            point_ids: Array.from(pointIds)
        };

        fetch(`${DATA_API_URL.replace('/api/data', '')}/api/select`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
            .then(res => res.json())
            .then(data => {
                setSelectedFeatures(data);
            })
            .catch(err => {
                console.error('❌ Backend selection error:', err);
                setSelectedFeatures(null);
            })
            .finally(() => setIsSelectingBackend(false));
    };

    // Selection: When selected point IDs change, query backend
    useEffect(() => {
        if (selectedPointIds.size > 0) {
            queryBackendForSelection(selectedPointIds);
        } else {
            setSelectedFeatures(null);
        }
    }, [selectedPointIds]);

    // 🚀 Performance: Debounce fetching in static mode to avoid requests while sliding
    const [debouncedTimeIndex, setDebouncedTimeIndex] = useState(0);

    useEffect(() => {
        if (mode === 'animation') {
            setDebouncedTimeIndex(timeIndex);
        } else {
            const handler = setTimeout(() => {
                setDebouncedTimeIndex(timeIndex);
            }, 500); // 500ms debounce for slider
            return () => clearTimeout(handler);
        }
    }, [timeIndex, mode]);

    // 1. Fetch Dates
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(d => setDates(d))
            .catch(console.error);
    }, []);

    // 2. Animation Loop
    useEffect(() => {
        let interval;
        if (mode === 'animation' && isPlaying && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex(prev => (prev >= dates.length - 1 ? 0 : prev + 1));
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates, mode]);

    // Tile fetching handled inside ArrowLODTileLayer (see src/layers/ArrowLODTileLayer.js)

    const layers = useMemo(() => [
        new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            },
            extensions: [new TerrainExtension()],
        }),
        // 🌍 Temporary terrain layer for testing
        new CogTerrainLayer({
            id: 'terrain-layer',
            elevationData: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/dtm1m_4326_cog_nodata.tif',
            minZoom: 12,
            maxZoom: 17,
            isTiled: true,
            useChannel: 1,
            visible: true,
            pickable: '3d',
            tileSize: 256,
            operation: 'terrain+draw',
            terrainOptions: {
                type: 'terrain',
            }
        }),
        new ArrowLODTileLayer({
            id: 'arrow-lod-tile-layer',
            dataUrl: DATA_API_URL,
            dateIndex: debouncedTimeIndex,
            mode: mode,
            is3D: true,
            columnMap: {
                latitude: 'y',
                longitude: 'x',
                height: 'height',
                size: 'mean_velocity',
                color: 'displacements'
            },
            timeSeries: {
                dates: 'dates',
                displacements: 'displacements'
            },
            onStatusChange: (status) => {
                setTotalPoints(status.totalPoints);
                setCacheSize(status.cacheSize);
                setIsLoading(status.isLoading);
                setFetchStatus(status.isLoading ? "Fetching..." : "Ready");
            },

            renderSubLayers: (props) => {
                const { data } = props;

                if (!data || data.length === 0) return null;

                // Handle geometry-based point filtering (same as Map2D)
                if (drawnGeometry && !isDrawing) {
                    const geometryKey = JSON.stringify(drawnGeometry);
                    const totalRows = data.reduce((sum, td) => sum + td.numRows, 0);
                    const dataKey = `${geometryKey}-${totalRows}-${data.length}`;
                    
                    if (lastProcessedGeometryRef.current !== dataKey) {
                        lastProcessedGeometryRef.current = dataKey;
                        
                        const newSelected = new Set();
                        
                        // Get current viewport bounds
                        const { longitude, latitude, zoom, pitch, bearing } = viewState;
                        const containerWidth = mapContainerRef.current?.clientWidth || 800;
                        const containerHeight = mapContainerRef.current?.clientHeight || 600;
                        
                        const viewport = new WebMercatorViewport({
                            width: containerWidth,
                            height: containerHeight,
                            longitude,
                            latitude,
                            zoom,
                            pitch,
                            bearing
                        });
                        
                        // Calculate bounds using terrain-aware picking when pitch > 0
                        let topLeft, topRight, bottomLeft, bottomRight;
                        
                        if (pitch > 0 && deckGLRef.current) {
                            // Use terrain picking for bounds calculation
                            // Try to pick multiple points to get better coverage
                            try {
                                // Pick from a grid of screen points instead of just corners
                                const gridPoints = [];
                                const gridSize = 5; // 5x5 grid
                                for (let i = 0; i <= gridSize; i++) {
                                    for (let j = 0; j <= gridSize; j++) {
                                        const x = (i / gridSize) * containerWidth;
                                        const y = (j / gridSize) * containerHeight;
                                        const pick = deckGLRef.current.pickObject({ x, y, layerIds: ['terrain-layer'] });
                                        if (pick?.coordinate) {
                                            gridPoints.push(pick.coordinate);
                                        }
                                    }
                                }
                                
                                if (gridPoints.length > 0) {
                                    // Calculate bounds from all grid hits
                                    const lons = gridPoints.map(p => p[0]);
                                    const lats = gridPoints.map(p => p[1]);
                                    const minLon = Math.min(...lons);
                                    const maxLon = Math.max(...lons);
                                    const minLat = Math.min(...lats);
                                    const maxLat = Math.max(...lats);
                                    
                                    topLeft = [minLon, maxLat];
                                    topRight = [maxLon, maxLat];
                                    bottomLeft = [minLon, minLat];
                                    bottomRight = [maxLon, minLat];
                                } else {
                                    topLeft = viewport.unproject([0, 0], { targetZ: 0 });
                                    topRight = viewport.unproject([containerWidth, 0], { targetZ: 0 });
                                    bottomLeft = viewport.unproject([0, containerHeight], { targetZ: 0 });
                                    bottomRight = viewport.unproject([containerWidth, containerHeight], { targetZ: 0 });
                                }
                            } catch (err) {
                                topLeft = viewport.unproject([0, 0], { targetZ: 0 });
                                topRight = viewport.unproject([containerWidth, 0], { targetZ: 0 });
                                bottomLeft = viewport.unproject([0, containerHeight], { targetZ: 0 });
                                bottomRight = viewport.unproject([containerWidth, containerHeight], { targetZ: 0 });
                            }
                        } else {
                            // Flat view: simple unproject
                            topLeft = viewport.unproject([0, 0], { targetZ: 0 });
                            topRight = viewport.unproject([containerWidth, 0], { targetZ: 0 });
                            bottomLeft = viewport.unproject([0, containerHeight], { targetZ: 0 });
                            bottomRight = viewport.unproject([containerWidth, containerHeight], { targetZ: 0 });
                        }
                        
                        const minLon = Math.min(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
                        const maxLon = Math.max(topLeft[0], topRight[0], bottomLeft[0], bottomRight[0]);
                        const minLat = Math.min(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
                        const maxLat = Math.max(topLeft[1], topRight[1], bottomLeft[1], bottomRight[1]);
                        
                        const bounds = [minLon, minLat, maxLon, maxLat];
                        
                        // Filter all visible table data for selected points
                        data.forEach(tableData => {
                            const pointIds = filterPointsByGeometryInBounds(
                                tableData, 
                                drawnGeometry,
                                bounds
                            );
                            pointIds.forEach(id => newSelected.add(id));
                        });

                        if (newSelected.size > 0) {
                            setSelectedPointIds(newSelected);
                        }
                    }
                }

                return data.map((tableData) => {
                    return new SimpleMeshLayer({
                        id: `mesh-layer-${tableData.tableIndex}`,
                        data: Array.from({ length: tableData.numRows }, (_, i) => i),
                        mesh: sphere,
                        extensions: [new TerrainExtension()],
                        getPosition: (rowIndex) => {
                            const { lon, lat } = tableData.getPosition(rowIndex);
                            // Clamp to the terrain surface.
                            return [lon, lat, 0];
                        },

                        getColor: (rowIndex) => {
                            const pointId = tableData.getPointId(rowIndex);
                            
                            // If point is hovered, show bright red
                            if (hoveredPointId === pointId) {
                                return [255, 0, 0, 255];
                            }
                            
                            // If point is selected, highlight it
                            if (selectedPointIds.has(pointId)) {
                                return [66, 212, 244, 255]; // Bright cyan
                            }
                            
                            // If there are selected points, dim unselected
                            if (selectedPointIds.size > 0) {
                                return [200, 200, 200, 100]; // Dim gray
                            }
                            
                            // Normal displacement color
                            const val = tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex);
                            const rgb = colorScale(val);
                            return [rgb[0], rgb[1], rgb[2], 255];
                        },

                        getScale: (rowIndex) => {
                            const meanVelocity = tableData.getMeanVelocity(rowIndex);
                            const size = sizeScale(Math.abs(meanVelocity || 1));
                            return [size, size, size];
                        },

                        updateTriggers: {
                            getColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
                            getPosition: [debouncedTimeIndex, mode]
                        },

                        transitions: {
                            getColor: 0,
                            getPosition: 0
                        },

                        pickable: true
                    });
                });
            }
        })
    ], [debouncedTimeIndex, mode, drawnGeometry, selectedPointIds, hoveredPointId, viewState]);

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                ref={deckGLRef}
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={{
                    dragPan: !isDrawing,
                    doubleClickZoom: !isDrawing,
                    scrollZoom: !isDrawing,
                    touchZoom: !isDrawing,
                    touchRotate: !isDrawing,
                    keyboard: !isDrawing
                }}
                getCursor={() => isDrawing ? 'crosshair' : 'grab'}
                layers={layers}
                onHover={(info) => {
                    // Hover is not used for drawing
                }}
                onClick={(info) => {
                    // In 3D mode with drawing active: use the correct 3D terrain coordinates
                    if (isDrawing) {
                        if (info.layer?.id === 'terrain-layer' && info.coordinate) {
                            const coord = extractTerrainCoordinate(info);
                            if (coord) {
                                // Single click = add point
                                window.dispatchEvent(new CustomEvent('map3dDrawingClick', {
                                    detail: {
                                        geo: [coord.longitude, coord.latitude],
                                        screenPos: [info.x, info.y],
                                        elevation: coord.elevation
                                    }
                                }));
                            }
                        }
                    }
                }}
                onDoubleClick={(info) => {
                    // Prevent DeckGL zoom on double-click during drawing
                    // (DrawingOverlay's document dblclick listener handles finalization)
                    if (isDrawing) {
                        info.rightButton = false;
                        info.leftButton = false;
                        info.middleButton = false;
                    }
                }}
            />

            <HUD
                viewState={viewState}
                currentTierDisplay={currentTierDisplay}
                totalPoints={totalPoints}
                fetchStatus={fetchStatus}
                isLoading={isLoading}
                cacheSize={cacheSize}
                cacheLimit={TILE_CACHE_LIMIT}
            />

            <PlaybackControls
                date={dates[timeIndex]}
                mode={mode}
                isPlaying={isPlaying}
                isLoading={isLoading}
                timeIndex={timeIndex}
                totalDates={dates.length}
                setMode={setMode}
                setIsPlaying={setIsPlaying}
                setTimeIndex={setTimeIndex}
            />

            <DrawingOverlay
                viewState={viewState}
                selectionMode={selectionMode}
                isDrawing={isDrawing}
                onGeometryComplete={handleGeometryComplete}
                bufferDistance={bufferDistance}
                is3D={true}
            />

            <SelectionControls
                selectionMode={selectionMode}
                onModeChange={(mode) => {
                    if (selectionMode === mode) {
                        setSelectionMode(null);
                        setIsDrawing(false);
                    } else {
                        setSelectionMode(mode);
                        setIsDrawing(true);
                    }
                }}
                onClear={() => {
                    setSelectedPointIds(new Set());
                    setDrawnGeometry(null);
                    setSelectedFeatures(null);
                    // keep drawing active if selection mode is still selected
                    setIsDrawing(selectionMode ? true : false);
                }}
                selectedCount={selectedPointIds.size}
                backendFeatureCount={selectedFeatures?.features?.length || 0}
                isLoadingBackend={isSelectingBackend}
                bufferDistance={bufferDistance}
                onBufferChange={setBufferDistance}
            />

            {selectedFeatures && (
                <div style={{
                    position: 'absolute',
                    bottom: '10px',
                    left: '10px',
                    right: '10px',
                    maxWidth: '600px',
                    zIndex: 999,
                }}>
                    <TimeSeriesChart 
                        selectedFeatures={selectedFeatures}
                        isLoading={isSelectingBackend}
                        onPointHover={setHoveredPointId}
                    />
                </div>
            )}
        </div>
    );
}

export default ArrowLODStream3D;

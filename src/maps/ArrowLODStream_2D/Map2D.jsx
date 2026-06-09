import { useEffect, useState, useRef } from 'react';
import { DeckGL, WebMercatorViewport } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionControls, DrawingOverlay, TimeSeriesChart, normalizeGeometry, filterPointsByGeometryInBounds } from '../../components/PointSelection';
import ArrowLODTileLayer from '../../layers/ArrowLODTileLayer';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const BACKEND_BASE_URL = window.BACKEND_API_URL || 'http://localhost:5000';
const DATES_API_URL = `${BACKEND_BASE_URL}/api/dates`;
const DATA_API_URL = `${BACKEND_BASE_URL}/api/data`;

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const TILE_CACHE_LIMIT = 200;

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
    .clamp(true);

// 🆕 LOD LOGIC
function getTargetTier(zoom) {
    if (zoom >= 15) return 2; // Full Detail (100%)
    if (zoom >= 13) return 1; // Mid Detail (35%)
    return 0;                 // Overview (5%) - Global Fetch
}

// 🆕 Point Size Logic
function getPointSize(zoom) {
    if (zoom < 13) return 2;  // Tier 0 (Overview)
    if (zoom < 15) return 3;  // Tier 1 (Mid)
    return 5;                 // Tier 2 (Detail)
}

function ArrowLODStream2D() {
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

    // Selection state
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [selectedPointIds, setSelectedPointIds] = useState(new Set());  // Point IDs (pid column)
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedFeatures, setSelectedFeatures] = useState(null); // Backend response with time-series data
    const [isSelectingBackend, setIsSelectingBackend] = useState(false);
    const [hoveredPointId, setHoveredPointId] = useState(null);

    const mapContainerRef = useRef(null);

    // Handle geometry completion from drawing overlay
    const handleGeometryComplete = (mode, coords, bufferDist = 100) => {
        const geometry = normalizeGeometry(mode, coords, bufferDist);
        if (!geometry) return;

        setDrawnGeometry(geometry);
        setIsDrawing(false);
    };

    // Send selected point IDs to backend for time-series data
    const queryBackendForSelection = (pointIds) => {
        if (!pointIds || pointIds.length === 0) return;

        setIsSelectingBackend(true);
        
        const payload = {
            point_ids: Array.from(pointIds)  // Convert Set to array
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

    // When selected point IDs change, query backend
    useEffect(() => {
        if (selectedPointIds.size > 0) {
            queryBackendForSelection(selectedPointIds);
        } else {
            setSelectedFeatures(null);
        }
    }, [selectedPointIds]);

    // Track when geometry was last processed to avoid re-filtering every frame
    const lastProcessedGeometryRef = useRef(null);

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

    // 🚀 Performance: Debounce fetching in static mode
    const [debouncedTimeIndex, setDebouncedTimeIndex] = useState(0);

    useEffect(() => {
        if (mode === 'animation') {
            setDebouncedTimeIndex(timeIndex);
        } else {
            const handler = setTimeout(() => {
                setDebouncedTimeIndex(timeIndex);
            }, 500);
            return () => clearTimeout(handler);
        }
    }, [timeIndex, mode]);

    // Tile fetching handled inside ArrowLODTileLayer (see src/layers/ArrowLODTileLayer.js)

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new ArrowLODTileLayer({
            id: 'arrow-lod-tile-layer',
            dataUrl: DATA_API_URL,
            dateIndex: debouncedTimeIndex,
            mode: mode,
            columnMap: {
                latitude: 'y',
                longitude: 'x',
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

                // Only compute expensive data key if there's actually a geometry to filter
                if (drawnGeometry && !isDrawing) {
                    // Track both geometry AND total row count to detect new data
                    const geometryKey = JSON.stringify(drawnGeometry);
                    const totalRows = data.reduce((sum, td) => sum + td.numRows, 0);
                    const dataKey = `${geometryKey}-${totalRows}-${data.length}`;
                    
                    if (lastProcessedGeometryRef.current !== dataKey) {
                        lastProcessedGeometryRef.current = dataKey;
                        
                        const newSelected = new Set();
                        
                        // Get current viewport bounds
                        const { longitude, latitude, zoom } = viewState;
                        const containerWidth = mapContainerRef.current?.clientWidth || 800;
                        const containerHeight = mapContainerRef.current?.clientHeight || 600;
                        
                        const viewport = new WebMercatorViewport({
                            width: containerWidth,
                            height: containerHeight,
                            longitude,
                            latitude,
                            zoom
                        });
                        
                        const bounds = viewport.getBounds();
                        
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
                    return new ScatterplotLayer({
                        id: `arrow-table-${tableData.tableIndex}`,
                        data: Array.from({ length: tableData.numRows }, (_, i) => i),

                        getPosition: (rowIndex) => {
                            const { lon, lat } = tableData.getPosition(rowIndex);
                            return [lon, lat];
                        },

                        getRadius: getPointSize(viewState.zoom),
                        radiusUnits: 'pixels',

                        getFillColor: (rowIndex) => {
                            const pointId = tableData.getPointId(rowIndex);
                            
                            // If point is hovered, show bright red
                            if (hoveredPointId === pointId) {
                                return [255, 0, 0, 255]; // Bright red
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
                            return [rgb[0], rgb[1], rgb[2], 200];
                        },

                        updateTriggers: {
                            getFillColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
                            getPosition: [mode],
                        },

                        // Disable transitions for instant updates
                        transitions: {
                            getFillColor: 0
                        },

                        pickable: true
                    });
                });
            }
        })
    ];

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                layers={layers}
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

            <SelectionControls
                selectionMode={selectionMode}
                onModeChange={(mode) => {
                    setSelectionMode(mode);
                    setIsDrawing(true);
                }}
                onClear={() => {
                    setSelectedPointIds(new Set());
                    setDrawnGeometry(null);
                    setSelectedFeatures(null);
                    setIsDrawing(false);
                }}
                selectedCount={selectedPointIds.size}
                backendFeatureCount={selectedFeatures?.features?.length || 0}
                isLoadingBackend={isSelectingBackend}
                bufferDistance={bufferDistance}
                onBufferChange={setBufferDistance}
            />

            <DrawingOverlay
                viewState={viewState}
                selectionMode={selectionMode}
                isDrawing={isDrawing}
                onGeometryComplete={handleGeometryComplete}
                bufferDistance={bufferDistance}
                is3D={false}
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
                        isLoading={isSelectingBackend}
                        onPointHover={setHoveredPointId}
                    />
                </div>
            )}
        </div>
    );
}

export default ArrowLODStream2D;

import { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL, WebMercatorViewport } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionAnalysisPanel, filterPointsByGeometryInBounds, normalizeGeometry } from '../../components/PointSelection';
import { calculateProfileData } from '../../components/2DLineProfile';
import ArrowLODTileLayer from '../../layers/ArrowLODTileLayer';
import { DynamicArrowLayer } from '../../layers/DynamicArrowLayer';
import { getLodTier } from '../../layers/lodTiers';
import { cartoLightBasemapUrl } from '../basemaps';
import { SymbolModeToggle } from '../../components/MapSymbols/SymbolModeToggle';
import { ColorScaleLegend } from '../../components/MapSymbols/ColorScaleLegend';
import { LegendOverlay } from '../../components/MapSymbols/LegendOverlay';
import { COLOR_DOMAIN, colorScale } from '../../layers/displacementScale';
import { getAllRowIndices, getSymbolRowSplit } from '../../layers/symbolRows';
import { getArrowHeading } from '../../layers/velocity/displacementSymbols';
import {
    ARROW_HEAD_SIZE,
    ARROW_HEAD_WIDTH,
    ARROW_STEM_THICKNESS,
    getArrowRadiusPixels,
    getArrowStemLengthFraction
} from './arrowPixelSymbols';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const BACKEND_BASE_URL = window.BACKEND_API_URL || 'http://localhost:5000';
const DATES_API_URL = `${BACKEND_BASE_URL}/api/dates`;
const DATA_API_URL = `${BACKEND_BASE_URL}/api/data`;

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const TILE_CACHE_LIMIT = 200;

// 🆕 Point Size Logic
function getPointSize(zoom) {
    const tier = getLodTier(zoom);
    if (tier === 2) return 5; // Tier 2 (Detail)
    if (tier === 1) return 3; // Tier 1 (Mid)
    return 2;                 // Tier 0 (Overview)
}

// Arrow mode splits each tile into small-displacement points (circles) and
// moving points (arrows) using the CURRENT displayed displacement, so the
// symbols change with the timeline. The split and its signature cache are
// shared with the 3D map (see layers/symbolRows.js) so the two maps cannot
// drift.

// One circle renderer shared by circle mode and the arrow mode's near-zero
// points, so radius/border/triggers cannot drift between the two branches.
function buildDisplacementCircleLayer({
    id,
    data,
    zoom,
    mode,
    debouncedTimeIndex,
    selectedPointIds,
    hoveredPointId,
    getPosition,
    getFillColor
}) {
    return new ScatterplotLayer({
        id,
        data,
        getPosition,
        getRadius: getPointSize(zoom),
        radiusUnits: 'pixels',
        getFillColor,
        // Same 1 px transparent-black rim as the arrows.
        stroked: true,
        filled: true,
        getLineColor: [0, 0, 0, 0],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        updateTriggers: {
            getFillColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
            getPosition: [mode],
        },
        transitions: {
            getFillColor: 0
        },
        pickable: true
    });
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
        const t = getLodTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        return `${t} (${percentages[t]})`;
    })();

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);
    // 'circle' keeps the existing look; 'arrow' renders the same points as
    // round-cap shader arrows. Both modes share the one cached dataset.
    const [symbolMode, setSymbolMode] = useState('circle');

    // Selection state
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [debouncedBufferDistance, setDebouncedBufferDistance] = useState(100);
    const [selectedPointIds, setSelectedPointIds] = useState(new Set());  // Point IDs (pid column)
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedFeatures, setSelectedFeatures] = useState(null); // Backend response with time-series data
    const [isSelectingBackend, setIsSelectingBackend] = useState(false);
    const [hoveredPointId, setHoveredPointId] = useState(null);
    const [drawnLineCoords, setDrawnLineCoords] = useState(null);

    const mapContainerRef = useRef(null);

    // Handle geometry completion from drawing overlay
    const handleGeometryComplete = (geometry, mode, coords) => {
        if (!geometry) return;

        setDrawnGeometry(geometry);
        setIsDrawing(false);

        if (mode === 'line') {
            setDrawnLineCoords(coords);
        } else {
            setDrawnLineCoords(null);
        }
    };

    // Send selected point IDs to backend for time-series data
    const queryBackendForSelection = (pointIds, metrics = []) => {
        if (!pointIds || pointIds.length === 0) return;

        setIsSelectingBackend(true);
        
        const payload = {
            point_ids: Array.from(pointIds),
            metrics: metrics,
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
            const metricsToFetch = ['mean_velocity', 'mean_velocity_std', 'height'];
            queryBackendForSelection(selectedPointIds, metricsToFetch);
        } else {
            setSelectedFeatures(null);
        }
    }, [selectedPointIds]);

    const profileData = useMemo(() => {
        if (selectionMode === 'line' && selectedFeatures && drawnLineCoords) {
            return calculateProfileData(selectedFeatures, drawnLineCoords, ['mean_velocity', 'mean_velocity_std']);
        }
        return null;
    }, [selectedFeatures, drawnLineCoords, selectionMode]);

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

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedBufferDistance(bufferDistance), 400);
        return () => clearTimeout(handler);
    }, [bufferDistance]);

    // Recompute the line corridor and re-select when buffer changes after a line is drawn
    useEffect(() => {
        if (selectionMode !== 'line' || !drawnLineCoords || drawnLineCoords.length < 2) return;
        const newGeometry = normalizeGeometry('line', drawnLineCoords, debouncedBufferDistance);
        if (newGeometry) {
            lastProcessedGeometryRef.current = null; // force renderSubLayers to re-select
            setDrawnGeometry(newGeometry);
        }
    // Only re-run when the debounced buffer changes; mode/coords are handled by handleGeometryComplete
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedBufferDistance]);

    // Tile fetching handled inside ArrowLODTileLayer (see src/layers/ArrowLODTileLayer.js)

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: cartoLightBasemapUrl,
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
                color: 'displacements',
                // Requested for this map only, so the arrow toggle never
                // refetches: both symbol modes read the same cached tiles.
                losEast: 'los_east',
                losNorth: 'los_north'
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
                    // Shared by both symbol modes, so switching symbols never
                    // changes position or colour semantics.
                    const getPosition = (rowIndex) => {
                        const { lon, lat } = tableData.getPosition(rowIndex);
                        return [lon, lat];
                    };

                    const getFillColor = (rowIndex) => {
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
                    };

                    if (symbolMode === 'arrow') {
                        const getDisplacement = (rowIndex) =>
                            tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex);

                        // Since |displacement| scales the length and colour,
                        // points within the near-zero band render as circles and
                        // the rest as arrows. The split changes with the date /
                        // animation frame.
                        const { arrowRows, circleRows } = getSymbolRowSplit(
                            tableData,
                            mode,
                            debouncedTimeIndex
                        );

                        const circleLayer = buildDisplacementCircleLayer({
                            id: `arrow-table-${tableData.tableIndex}-stable-circles`,
                            data: circleRows,
                            zoom: viewState.zoom,
                            mode,
                            debouncedTimeIndex,
                            selectedPointIds,
                            hoveredPointId,
                            getPosition,
                            getFillColor
                        });

                        // Round-cap SDF arrows sized in pixels. `shape` and
                        // `anchorCentered` are baked into the shader at compile
                        // time, so the '-roundcap' layer id keeps this instance
                        // distinct from the circle branch.
                        const arrowLayer = new DynamicArrowLayer({
                            id: `arrow-table-${tableData.tableIndex}-roundcap-border`,
                            data: arrowRows,
                            shape: 'round-cap',
                            anchorCentered: false,
                            // Keep the default 1 px transparent-black rim so it
                            // can be compared with the bordered circles.
                            showBorder: true,

                            getPosition,
                            getFillColor,

                            getRadius: getArrowRadiusPixels(viewState.zoom),
                            radiusUnits: 'pixels',

                            // Direction follows the sign of the currently
                            // displayed displacement, matching the circle/arrow
                            // split. Missing LOS columns degrade to a north (0)
                            // arrow instead of dropping the point.
                            getAngle: (rowIndex) => {
                                const los = tableData.getLosVector(rowIndex);
                                return getArrowHeading(los?.east, los?.north, getDisplacement(rowIndex));
                            },
                            getStemLength: (rowIndex) =>
                                getArrowStemLengthFraction(getDisplacement(rowIndex)),
                            getStemThickness: ARROW_STEM_THICKNESS,
                            getHeadSize: ARROW_HEAD_SIZE,
                            getHeadWidth: ARROW_HEAD_WIDTH,

                            // Hover/selection stays fill-only, matching the
                            // circles. A non-zero line alpha would make the
                            // shader treat every arrow as selected.
                            getLineColor: [0, 0, 0, 0],
                            getLineWidth: 0,

                            updateTriggers: {
                                getFillColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
                                getPosition: [mode],
                                // Angle and stem only depend on the displayed
                                // displacement; zoom drives `getRadius` and does
                                // not need to rebuild them.
                                getAngle: [debouncedTimeIndex, mode],
                                getStemLength: [debouncedTimeIndex, mode],
                                getRadius: [viewState.zoom],
                            },

                            // Disable transitions for instant updates
                            transitions: {
                                getFillColor: 0
                            },

                            pickable: true
                        });

                        const tableLayers = [];
                        if (circleRows.length > 0) tableLayers.push(circleLayer);
                        if (arrowRows.length > 0) tableLayers.push(arrowLayer);
                        return tableLayers;
                    }

                    return buildDisplacementCircleLayer({
                        id: `arrow-table-${tableData.tableIndex}`,
                        data: getAllRowIndices(tableData),
                        zoom: viewState.zoom,
                        mode,
                        debouncedTimeIndex,
                        selectedPointIds,
                        hoveredPointId,
                        getPosition,
                        getFillColor
                    });
                }).flat();
            }
        })
    ];

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
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

            <LegendOverlay lifted={Boolean(selectedFeatures)}>
                <ColorScaleLegend
                    colorScale={colorScale}
                    domain={COLOR_DOMAIN}
                    title="LOS displacement (mm)"
                />
            </LegendOverlay>

            <SelectionAnalysisPanel
                top="130px"
                left="10px"
                selectionMode={selectionMode}
                onSelectionModeChange={setSelectionMode}
                isDrawing={isDrawing}
                onIsDrawingChange={setIsDrawing}
                bufferDistance={bufferDistance}
                onBufferDistanceChange={setBufferDistance}
                onClear={() => {
                    setSelectedPointIds(new Set());
                    setDrawnGeometry(null);
                    setSelectedFeatures(null);
                    setDrawnLineCoords(null);
                    setSelectionMode(null);
                    setIsDrawing(false);
                }}
                onGeometryComplete={handleGeometryComplete}

                selectedCount={selectedPointIds.size}
                selectedFeatures={selectedFeatures}
                profileData={profileData}
                isLoading={isSelectingBackend}
                backendFeatureCount={selectedFeatures?.features?.length || 0}

                lineProfileMetrics={['mean_velocity', 'mean_velocity_std']}
                is3D={false}
                viewState={viewState}
                onPointHover={setHoveredPointId}

                belowSelectionPanel={
                    <SymbolModeToggle
                        symbolMode={symbolMode}
                        onSymbolModeChange={setSymbolMode}
                    />
                }
            />
        </div>
    );
}

export default ArrowLODStream2D;

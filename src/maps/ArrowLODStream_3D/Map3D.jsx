import { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { SphereGeometry } from '@luma.gl/engine';
import { CogTerrainLayer, extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';
import {_TerrainExtension as TerrainExtension } from "@deck.gl/extensions";

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionAnalysisPanel, filterPointsByGeometryInBounds, getGeometryBounds, normalizeGeometry } from '../../components/PointSelection';
import { SymbolModeToggle } from '../../components/MapSymbols/SymbolModeToggle';
import { ColorScaleLegend } from '../../components/MapSymbols/ColorScaleLegend';
import { LegendOverlay } from '../../components/MapSymbols/LegendOverlay';
import ArrowLODTileLayer from '../../layers/ArrowLODTileLayer';
import { getLodTier } from '../../layers/lodTiers';
import { COLOR_DOMAIN, colorScale } from '../../layers/displacementScale';
import { DISPLACEMENT_SYMBOL_MATERIAL } from '../../layers/displacementMaterial';
import { getArrowHeading } from '../../layers/velocity/displacementSymbols';
import { getAllRowIndices, getSymbolRowSplit } from '../../layers/symbolRows';
import { build3dDisplacementArrowLayers } from '../../layers/factory/build3dDisplacementArrowLayers';
import { setDeckGLInstance } from '../../components/PointSelection/drawingUtils';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { calculateProfileData } from '../../components/2DLineProfile';
import { cartoLightBasemapUrl } from '../basemaps';
import { DISPLACEMENT_ARROW_PEN_METERS, getArrowStemMeters, getRaiseMeters } from './arrow3dSymbols';
import stemMesh from '../ArrowGallery/meshes/arrow_tail_unit.obj?url&no-inline';
import headMesh from '../ArrowGallery/meshes/arrow_head_round_cap.obj?url&no-inline';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0 };
const BACKEND_BASE_URL = window.BACKEND_API_URL || 'http://localhost:5000';
const DATES_API_URL = `${BACKEND_BASE_URL}/api/dates`;
const DATA_API_URL = `${BACKEND_BASE_URL}/api/data`;

const TILE_CACHE_LIMIT = 200;

const sphere = new SphereGeometry({ radius: 1, nlat: 6, nlong: 6 });

// Sphere radius (metres) from |mean_velocity|. Kept in the same size class as
// the 1.5 m arrow pen: the old [1, 10] range produced 20 m balls that dwarfed
// the arrows at inspection zoom.
const sizeScale = scaleLinear().domain([0, 5]).range([0.8, 2.4]).clamp(true);

// One sphere renderer shared by circle mode and arrow mode's near-zero points,
// so radius/colour/triggers cannot drift between the two branches.
function buildSphereLayer({ id, data, getPosition, getColor, getRadius, updateTriggers }) {
    return new SimpleMeshLayer({
        id,
        data,
        mesh: sphere,
        extensions: [new TerrainExtension()],
        // Lift by the radius so the sphere rests on the terrain instead of
        // being half-buried by the ground depth buffer.
        getPosition: (rowIndex) => {
            const [lon, lat] = getPosition(rowIndex);
            return [lon, lat, getRadius(rowIndex)];
        },
        getScale: (rowIndex) => {
            const radius = getRadius(rowIndex);
            return [radius, radius, radius];
        },
        getColor,
        material: DISPLACEMENT_SYMBOL_MATERIAL,
        updateTriggers,
        transitions: {
            getColor: 0,
            getPosition: 0
        },
        pickable: true
    });
}

// Per-row heading and stem length, cached per (table, mode, date). Both arrow
// layers read these arrays, so the LOS vector and displacement are resolved
// once per row per date instead of 3-6 times per animation frame.
const arrowAttributeCache = new WeakMap();

function getArrowRowAttributes(tableData, mode, timeIndex) {
    const key = `${mode}:${timeIndex}`;
    const cached = arrowAttributeCache.get(tableData.arrowTable);
    if (cached && cached.key === key) return cached;

    const numRows = tableData.numRows;
    const heading = new Float64Array(numRows);
    const stemMeters = new Float64Array(numRows);
    for (let i = 0; i < numRows; i++) {
        const displacement = tableData.getDisplacementValue(i, mode, timeIndex);
        const los = tableData.getLosVector(i);
        heading[i] = getArrowHeading(los?.east, los?.north, displacement);
        stemMeters[i] = getArrowStemMeters(displacement);
    }

    const entry = { key, heading, stemMeters };
    arrowAttributeCache.set(tableData.arrowTable, entry);
    return entry;
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
        const t = getLodTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        return `${t} (${percentages[t]})`;
    })();

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);
    // 'circle' keeps the existing spheres; 'arrow' renders the moving points as
    // 3D meshes and the near-zero points as the same spheres. Both modes share
    // one cached dataset, so toggling never refetches.
    const [symbolMode, setSymbolMode] = useState('circle');

    const mapContainerRef = useRef(null);
    const deckGLRef = useRef(null);

    // Selection state
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [debouncedBufferDistance, setDebouncedBufferDistance] = useState(100);
    const [selectedPointIds, setSelectedPointIds] = useState(new Set());
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedFeatures, setSelectedFeatures] = useState(null);
    const [isSelectingBackend, setIsSelectingBackend] = useState(false);
    const [hoveredPointId, setHoveredPointId] = useState(null);
    const [drawnLineCoords, setDrawnLineCoords] = useState(null);
    const { zRange, onZRangeUpdate } = useTerrainZRange();

    const lastProcessedGeometryRef = useRef(null);

    // Set DeckGL instance for terrain picking in drawing utils
    useEffect(() => {
        if (deckGLRef.current) {
            setDeckGLInstance(deckGLRef.current);
        }
    }, []);

    // Selection: Handle geometry completion from drawing overlay
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
    };

    // Selection: Query backend for time-series data
    const queryBackendForSelection = (pointIds, metrics = []) => {
        if (!pointIds || pointIds.length === 0) return;

        setIsSelectingBackend(true);
        
        const payload = {
            point_ids: Array.from(pointIds),
            metrics: metrics
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
            // Define all metrics needed for any chart here
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
            data: cartoLightBasemapUrl,
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            },
            extensions: [new TerrainExtension()],
            zRange: zRange,
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
            onZRangeUpdate: onZRangeUpdate,
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
                color: 'displacements',
                // Requested for this map only, so the symbol toggle never
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

                // Handle geometry-based point filtering (same as Map2D)
                if (drawnGeometry && !isDrawing) {
                    const geometryKey = JSON.stringify(drawnGeometry);
                    const totalRows = data.reduce((sum, td) => sum + td.numRows, 0);
                    const dataKey = `${geometryKey}-${totalRows}-${data.length}`;
                    
                    if (lastProcessedGeometryRef.current !== dataKey) {
                        lastProcessedGeometryRef.current = dataKey;
                        
                        const newSelected = new Set();
                        
                        // Prefilter by the drawn geometry bbox, then do the exact point-in-polygon test.
                        const bounds = getGeometryBounds(drawnGeometry);
                        if (!bounds) {
                            return null;
                        }
                        
                        // Filter all visible table data for selected points
                        data.forEach(tableData => {
                            const pointIds = filterPointsByGeometryInBounds(
                                tableData, 
                                drawnGeometry,
                                bounds
                            );
                            pointIds.forEach(id => newSelected.add(id));
                        });

                        setSelectedPointIds(newSelected);
                    }
                }

                return data.map((tableData) => {
                    const getSpherePosition = (rowIndex) => {
                        const { lon, lat } = tableData.getPosition(rowIndex);
                        return [lon, lat];
                    };

                    const getColor = (rowIndex) => {
                        const pointId = tableData.getPointId(rowIndex);

                        // If point is hovered, show bright red
                        if (hoveredPointId && String(hoveredPointId) === String(pointId)) {
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
                    };

                    const getRadius = (rowIndex) => {
                        const meanVelocity = tableData.getMeanVelocity(rowIndex);
                        return sizeScale(Math.abs(meanVelocity || 1));
                    };

                    const sphereUpdateTriggers = {
                        getColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
                        // lon/lat and the sphere lift are time-invariant; only the
                        // split array identity changes with the date.
                        getPosition: [mode]
                    };

                    if (symbolMode === 'circle') {
                        return buildSphereLayer({
                            id: `mesh-layer-${tableData.tableIndex}`,
                            data: getAllRowIndices(tableData),
                            getPosition: getSpherePosition,
                            getColor,
                            getRadius,
                            updateTriggers: sphereUpdateTriggers
                        });
                    }

                    // Same 2 mm circle/arrow rule as 2D, from the shared rows
                    // helper, evaluated against the displayed displacement.
                    const { arrowRows, circleRows } = getSymbolRowSplit(
                        tableData,
                        mode,
                        debouncedTimeIndex
                    );

                    const tableLayers = [];

                    if (circleRows.length > 0) {
                        tableLayers.push(buildSphereLayer({
                            id: `mesh-layer-${tableData.tableIndex}-stable-circles`,
                            data: circleRows,
                            getPosition: getSpherePosition,
                            getColor,
                            getRadius,
                            updateTriggers: sphereUpdateTriggers
                        }));
                    }

                    if (arrowRows.length > 0) {
                        const { heading, stemMeters } = getArrowRowAttributes(
                            tableData,
                            mode,
                            debouncedTimeIndex
                        );

                        // Rest the flat mesh's underside on the terrain: the
                        // cross-section is centred on model Y.
                        const raiseMeters = getRaiseMeters(DISPLACEMENT_ARROW_PEN_METERS);

                        tableLayers.push(...build3dDisplacementArrowLayers({
                            idPrefix: `arrow-mesh-${tableData.tableIndex}`,
                            data: arrowRows,
                            getPosition: (rowIndex) => {
                                const { lon, lat } = tableData.getPosition(rowIndex);
                                return [lon, lat, raiseMeters];
                            },
                            getColor,
                            getHeading: (rowIndex) => heading[rowIndex],
                            getStemMeters: (rowIndex) => stemMeters[rowIndex],
                            penMeters: DISPLACEMENT_ARROW_PEN_METERS,
                            stemMesh,
                            headMesh,
                            updateTriggers: {
                                getColor: sphereUpdateTriggers.getColor,
                                getPosition: sphereUpdateTriggers.getPosition,
                                getScale: [debouncedTimeIndex, mode],
                                getOrientation: [debouncedTimeIndex, mode],
                                getTranslation: [debouncedTimeIndex, mode]
                            },
                            extensions: [new TerrainExtension()],
                            terrainDrawMode: 'offset'
                        }));
                    }

                    return tableLayers;
                }).flat();
            }
        })
    ], [debouncedTimeIndex, mode, symbolMode, drawnGeometry, selectedPointIds, hoveredPointId, isDrawing, zRange, onZRangeUpdate]);

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
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
                onHover={() => {
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
                is3D={true}
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

export default ArrowLODStream3D;

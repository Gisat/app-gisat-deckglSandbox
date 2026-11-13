import { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL, WebMercatorViewport } from 'deck.gl';
import { TileLayer, MVTLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionAnalysisPanel, filterPointsByGeometryInBounds, normalizeGeometry } from '../../components/PointSelection';
import { calculateProfileData } from '../../components/2DLineProfile';
import { cartoLightBasemapUrl } from '../basemaps';
import {
    AUTO_PREPARE,
    BASE_ATTRIBUTES,
    extractTimeline,
    fetchStats,
    mvtAttributesUrlTemplate,
    prepareMvt,
    queryAttributesByIds,
    queryByGeometry,
} from './gisatDataServiceClient';

// --- Configuration ---
// Subset extent is ~[15.099, 50.249, 15.107, 50.250]; the stats extent fit
// overrides this once loaded.
const INITIAL_VIEW_STATE = { longitude: 15.103, latitude: 50.249, zoom: 14, pitch: 0, bearing: 0 };

const MAX_TILE_ZOOM = 14;
const TILE_CACHE_LIMIT = 200;

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
    .clamp(true);

// Server-side MVT simplification replaces the old tier system; the HUD "tier"
// label shows the tile zoom.
function getTileZoom(zoom) {
    return Math.max(0, Math.min(MAX_TILE_ZOOM, Math.floor(zoom)));
}

function getPointSize(zoom) {
    if (zoom < 13) return 2;
    if (zoom < 15) return 3;
    return 5;
}

// MVT geometry is ST_MultiPoint — flatten to single-point features so per-point
// coloring/selection works. Missing (null) MVT attributes are treated as 0.
function flattenFeatures(rawFeatures) {
    const flat = [];
    for (const f of rawFeatures || []) {
        const g = f.geometry;
        if (!g || !g.coordinates) continue;
        if (g.type === 'MultiPoint') {
            for (const c of g.coordinates) {
                flat.push({ ...f, geometry: { type: 'Point', coordinates: c } });
            }
        } else if (g.type === 'Point') {
            flat.push(f);
        }
    }
    return flat;
}

function getFeaturePointId(f) {
    return f.properties?.pid ?? f.properties?.fid ?? f.id ?? null;
}

// Adapt a flattened feature array to the {numRows, getPosition, getPointId}
// shape filterPointsByGeometryInBounds expects.
function toTileAdapter(features) {
    return {
        numRows: features.length,
        getPosition: (i) => {
            const c = features[i].geometry.coordinates;
            return { lon: c[0], lat: c[1] };
        },
        getPointId: (i) => getFeaturePointId(features[i]),
    };
}

// Transform the data-service GeoJSON response into the selectedFeatures shape the
// existing components expect (properties.point_id / mean_velocity / dates /
// displacements, Point geometry).
function transformSelectedFeatures(geojson, dateColumns, dates, coordsById) {
    return {
        type: 'FeatureCollection',
        features: (geojson?.features || []).map((f) => {
            const p = f.properties || {};
            const pointId = p.fid ?? p.pid ?? f.id;
            let coords = null;
            if (f.geometry?.type === 'Point' && Array.isArray(f.geometry.coordinates)) {
                coords = f.geometry.coordinates;
            } else if (f.geometry?.type === 'MultiPoint' && f.geometry.coordinates?.length > 0) {
                coords = f.geometry.coordinates[0];
            } else if (coordsById?.has(pointId)) {
                coords = coordsById.get(pointId);
            } else if (p.longitude != null && p.latitude != null) {
                coords = [p.longitude, p.latitude];
            }
            return {
                type: 'Feature',
                id: pointId,
                geometry: coords ? { type: 'Point', coordinates: coords } : f.geometry || null,
                properties: {
                    ...p,
                    point_id: pointId,
                    dates,
                    displacements: dateColumns.map((c) => p[c] ?? 0),
                },
            };
        }),
    };
}

function GisatDataServiceStream2D() {
    const [totalPoints, setTotalPoints] = useState(0);
    const [cacheSize, setCacheSize] = useState(0);
    const [dates, setDates] = useState([]);
    const [dateColumns, setDateColumns] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchStatus, setFetchStatus] = useState('Idle');

    const currentTierDisplay = `z${getTileZoom(viewState.zoom)}`;

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);

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

    // Prepare-tiles state
    const [bypassCache, setBypassCache] = useState(true);
    const [prepareState, setPrepareState] = useState(null);

    const mapContainerRef = useRef(null);
    // tileId -> flattened point features currently rendered
    const tileFeaturesRef = useRef(new Map());
    // pointId -> [lon, lat] captured from visible tiles (the /query/attributes
    // response omits geometry, so these are the fallback coordinates)
    const pointCoordsRef = useRef(new Map());
    const totalPointsRef = useRef(0);
    const cacheSizeRef = useRef(0);
    const drawnGeometryRef = useRef(null);
    // Track when geometry was last processed to avoid re-filtering every frame
    const lastProcessedGeometryRef = useRef(null);

    useEffect(() => { drawnGeometryRef.current = drawnGeometry; }, [drawnGeometry]);

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

    // 1. Fetch stats -> timeline columns + extent (replaces the Flask /api/dates)
    useEffect(() => {
        let cancelled = false;
        fetchStats()
            .then((stats) => {
                if (cancelled) return;
                const { dateColumns, dates } = extractTimeline(stats);
                setDateColumns(dateColumns);
                setDates(dates);
                const extent = stats?.geometry?.extent;
                if (extent) {
                    const [minLon, minLat, maxLon, maxLat] = extent;
                    const fitted = new WebMercatorViewport({ width: 800, height: 600 })
                        .fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 40 });
                    setViewState((v) => ({
                        ...v,
                        longitude: fitted.longitude,
                        latitude: fitted.latitude,
                        zoom: Math.min(fitted.zoom, 16),
                    }));
                }
                if (AUTO_PREPARE) handlePrepareRef.current?.();
            })
            .catch((err) => {
                console.error('Gisat stats error:', err);
                if (!cancelled) setFetchStatus('Stats failed');
            });
        return () => { cancelled = true; };
    }, []);

    // 2. Animation loop
    useEffect(() => {
        let interval;
        if (mode === 'animation' && isPlaying && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex((prev) => (prev >= dates.length - 1 ? 0 : prev + 1));
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates, mode]);

    // Debounce fetching in static mode
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedBufferDistance]);

    // One tile per z/x/y carries ALL date columns, so the same URL serves both
    // modes and MVTLayer's URL-keyed cache reuses animation tiles in static mode.
    const mvtUrl = useMemo(() => {
        if (dateColumns.length === 0) return null;
        return mvtAttributesUrlTemplate([...BASE_ATTRIBUTES, ...dateColumns], { bypassCache });
    }, [dateColumns, bypassCache]);

    const handlePrepare = () => {
        if (dateColumns.length === 0) return;
        setPrepareState({ status: 'running' });
        prepareMvt({ zMin: 0, zMax: MAX_TILE_ZOOM, attributes: [...BASE_ATTRIBUTES, ...dateColumns] })
            .then((summary) => {
                setPrepareState({ status: 'done', summary });
                setBypassCache(false); // serve prepared tiles from now on
            })
            .catch((err) => {
                console.error('mvt-prepare error:', err);
                setPrepareState({ status: 'error', message: String(err?.message || err) });
            });
    };
    const handlePrepareRef = useRef(handlePrepare);
    useEffect(() => { handlePrepareRef.current = handlePrepare; });
    // Query the data service for the selected point IDs (full timeline + metrics)
    useEffect(() => {
        if (selectedPointIds.size === 0) {
            setSelectedFeatures(null);
            return;
        }
        if (dateColumns.length === 0) return;

        let cancelled = false;
        setIsSelectingBackend(true);
        const attributes = [...BASE_ATTRIBUTES, ...dateColumns];
        const ids = Array.from(selectedPointIds);

        queryAttributesByIds(ids, attributes)
            .then((geojson) => {
                if (geojson?.features?.length > 0) return geojson;
                // Fallback: query by the drawn geometry instead of feature IDs
                return queryByGeometry(drawnGeometryRef.current, attributes);
            })
            .then((geojson) => {
                if (cancelled || !geojson) return;
                setSelectedFeatures(transformSelectedFeatures(geojson, dateColumns, dates, pointCoordsRef.current));
            })
            .catch((err) => {
                console.error('Gisat selection error:', err);
                if (!cancelled) setSelectedFeatures(null);
            })
            .finally(() => { if (!cancelled) setIsSelectingBackend(false); });

        return () => { cancelled = true; };
    }, [selectedPointIds, dateColumns, dates]);

    const profileData = useMemo(() => {
        if (selectionMode === 'line' && selectedFeatures && drawnLineCoords) {
            return calculateProfileData(selectedFeatures, drawnLineCoords, ['mean_velocity', 'mean_velocity_std']);
        }
        return null;
    }, [selectedFeatures, drawnLineCoords, selectionMode]);

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
    ];

    if (mvtUrl) {
        layers.push(new MVTLayer({
            id: 'gisat-mvt-stream',
            data: mvtUrl,
            minZoom: 0,
            maxZoom: MAX_TILE_ZOOM,
            maxCacheSize: TILE_CACHE_LIMIT,
            binary: false,
            onViewportLoad: (selectedTiles) => {
                setIsLoading(false);
                setFetchStatus('Ready');
                // Prune features of tiles that left the viewport
                const visibleIds = new Set((selectedTiles || []).map((t) => t.id));
                for (const key of tileFeaturesRef.current.keys()) {
                    if (!visibleIds.has(key)) tileFeaturesRef.current.delete(key);
                }
            },
            onTileError: (error) => {
                console.error('MVT tile error:', error);
                setIsLoading(false);
                setFetchStatus('Tile error');
            },
            renderSubLayers: (props) => {
                const flat = flattenFeatures(props.data);
                tileFeaturesRef.current.set(props.tile.id, flat);

                // HUD status
                const total = [...tileFeaturesRef.current.values()].reduce((sum, a) => sum + a.length, 0);
                if (total !== totalPointsRef.current) {
                    totalPointsRef.current = total;
                    setTotalPoints(total);
                }
                const cache = tileFeaturesRef.current.size;
                if (cache !== cacheSizeRef.current) {
                    cacheSizeRef.current = cache;
                    setCacheSize(cache);
                }

                // Client-side selection filter over visible tiles (unchanged logic)
                if (drawnGeometry && !isDrawing) {
                    const geometryKey = JSON.stringify(drawnGeometry);
                    const dataKey = `${geometryKey}-${total}-${cache}`;

                    if (lastProcessedGeometryRef.current !== dataKey) {
                        lastProcessedGeometryRef.current = dataKey;

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

                        const newSelected = new Set();
                        const coordsById = new Map();

                        tileFeaturesRef.current.forEach((feats) => {
                            for (const f of feats) {
                                const id = getFeaturePointId(f);
                                if (id != null) coordsById.set(id, f.geometry.coordinates);
                            }
                            const pointIds = filterPointsByGeometryInBounds(
                                toTileAdapter(feats),
                                drawnGeometry,
                                bounds
                            );
                            pointIds.forEach((id) => newSelected.add(id));
                        });
                        pointCoordsRef.current = coordsById;

                        if (newSelected.size > 0) {
                            setSelectedPointIds(newSelected);
                        }
                    }
                }

                return new ScatterplotLayer({
                    id: `${props.id}-points`,
                    data: flat,

                    getPosition: (f) => f.geometry.coordinates,

                    getRadius: getPointSize(viewState.zoom),
                    radiusUnits: 'pixels',

                    getFillColor: (f) => {
                        const pointId = getFeaturePointId(f);

                        if (hoveredPointId === pointId) {
                            return [255, 0, 0, 255]; // Bright red
                        }

                        if (selectedPointIds.has(pointId)) {
                            return [66, 212, 244, 255]; // Bright cyan
                        }

                        if (selectedPointIds.size > 0) {
                            return [200, 200, 200, 100]; // Dim gray
                        }

                        // Normal displacement color; absent MVT attributes count as 0
                        const col = dateColumns[debouncedTimeIndex];
                        const val = col ? (f.properties?.[col] ?? 0) : 0;
                        const rgb = colorScale(val);
                        return [rgb[0], rgb[1], rgb[2], 200];
                    },

                    updateTriggers: {
                        getFillColor: [debouncedTimeIndex, selectedPointIds, hoveredPointId],
                        getPosition: [mode],
                    },

                    transitions: {
                        getFillColor: 0
                    },

                    pickable: true
                });
            }
        }));
    }

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={({ viewState: vs }) => {
                    setViewState(vs);
                    if (mvtUrl) {
                        setIsLoading(true);
                        setFetchStatus('Fetching...');
                    }
                }}
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

            <div style={{
                position: 'absolute', top: 10, right: 10,
                backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '10px 15px',
                borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
                fontFamily: 'monospace', fontSize: '12px', zIndex: 10, color: '#333'
            }}>
                <button
                    onClick={handlePrepare}
                    disabled={prepareState?.status === 'running' || dateColumns.length === 0}
                    style={{ padding: '5px 12px', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '4px', background: 'white' }}
                >
                    Prepare tiles
                </button>
                <div style={{ marginTop: '6px' }}>
                    {prepareState?.status === 'running' && 'Preparing...'}
                    {prepareState?.status === 'done' && `Prepared ${prepareState.summary?.tilesPrepared} tiles (z${prepareState.summary?.zMin}-${prepareState.summary?.zMax})`}
                    {prepareState?.status === 'error' && `Error: ${prepareState.message}`}
                    {!prepareState && `${dateColumns.length} date columns`}
                </div>
            </div>

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
            />
        </div>
    );
}

export default GisatDataServiceStream2D;

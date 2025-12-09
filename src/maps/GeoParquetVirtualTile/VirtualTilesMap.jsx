import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDb } from 'duckdb-wasm-kit';
import { setupDB } from './db';
import { scaleLinear } from 'd3-scale';

import MapHUD from './MapHUD';
import TimeControl from './TimeControl';
import './VirtualTilesMap.css';

// 🛑 Configuration
const GRID_SIZE = 0.03;
const TILE_BUFFER = 1; // Fetch 1 extra tile around the view

function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => { setDebouncedValue(value); }, delay);
        return () => { clearTimeout(handler); };
    }, [value, delay]);
    return debouncedValue;
}

const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };

// 🛑 COLOR SCALE: Exact domain requested [-20, 20]
const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

function getTargetTier(zoom) {
    if (zoom < 13) return 0;
    if (zoom < 15) return 1;
    return 2;
}

function getPointRadius(zoom) {
    if (zoom < 11) return 1;
    if (zoom < 13) return 1.5;
    if (zoom < 15) return 2.5;
    return 4;
}

export default function VirtualTilesMap() {
    const [startWasm, setStartWasm] = useState(false);
    const [dbInitialized, setDbInitialized] = useState(false);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [dates, setDates] = useState([]);

    const [fullVectorsLoaded, setFullVectorsLoaded] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);

    const [positionArray, setPositionArray] = useState(null);
    const [displacementVectors, setDisplacementVectors] = useState(null);
    const [tileIds, setTileIds] = useState(null);
    const [visiblePointCount, setVisiblePointCount] = useState(0);

    // Detailed Loading State for HUD
    const [loadingStage, setLoadingStage] = useState('idle');
    const [loadedTier, setLoadedTier] = useState(-1);
    const [dataStatus, setDataStatus] = useState('Idle');

    const lastQueryParams = useRef({ key: "" });
    const tileCache = useRef(new Map());

    const mapContainerRef = useRef(null);
    const debouncedViewState = useDebounce(viewState, 300);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    const { db } = useDuckDb();

    // Logic Variables (Defined outside useEffect)
    const needsFullVector = fullVectorsLoaded;
    const currentDbIndex = debouncedTimeIndex + 1;

    // 1. Initialize DB
    useEffect(() => {
        if (!startWasm) return;
        setupDB().then(() => setDbInitialized(true)).catch(console.error);
    }, [startWasm]);

    // 2. Animation Loop
    useEffect(() => {
        let interval;
        if (isPlaying && fullVectorsLoaded && dates.length > 0 && dataStatus === 'Ready') {
            interval = setInterval(() => {
                setTimeIndex(prev => {
                    if (prev >= dates.length - 1) return 0;
                    return prev + 1;
                });
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, fullVectorsLoaded, dates.length, dataStatus]);

    // 3. Fetch Dates
    useEffect(() => {
        if (!dbInitialized || !db) return;
        const fetchDates = async () => {
            const conn = await db.connect();
            try {
                const res = await conn.query(`SELECT dates FROM read_parquet('data.geoparquet') LIMIT 1`);
                if (res.numRows > 0) {
                    const datesVector = res.getChildAt(0);
                    const arrowDates = datesVector?.get(0);
                    const rawArray = arrowDates?.toArray ? arrowDates.toArray() : [];
                    const strDates = Array.from(rawArray).map(ts => {
                        try {
                            let val = Number(ts);
                            if (ts instanceof Date) return ts.toISOString().split('T')[0];
                            let dateObj = val < 1000000 ? new Date(val * 86400000) : new Date(val);
                            return isNaN(dateObj.getTime()) ? "Invalid Date" : dateObj.toISOString().split('T')[0];
                        } catch (e) { return "Error"; }
                    });
                    setDates(strDates);
                }
            } catch (e) { console.error("Date fetch error:", e); }
            finally { if (conn) await conn.close(); }
        };
        fetchDates();
    }, [dbInitialized, db]);

    // 4. Viewport Calculations with Buffer
    const queryParams = useMemo(() => {
        if (!mapContainerRef.current) return null;
        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const bounds = viewport.getBounds(); // [minLng, minLat, maxLng, maxLat]

        const [minLng, minLat, maxLng, maxLat] = bounds;
        const minX = Math.floor(minLng / GRID_SIZE) - TILE_BUFFER;
        const maxX = Math.floor(maxLng / GRID_SIZE) + TILE_BUFFER;
        const minY = Math.floor(minLat / GRID_SIZE) - TILE_BUFFER;
        const maxY = Math.floor(maxLat / GRID_SIZE) + TILE_BUFFER;

        return {
            minX, maxX, minY, maxY,
            targetTier: getTargetTier(debouncedViewState.zoom)
        };
    }, [debouncedViewState]);

    // 5. Data Fetching
    useEffect(() => {
        if (!db || !queryParams) return;

        let isActive = true;
        const { minX, maxX, minY, maxY, targetTier } = queryParams;

        const loadData = async () => {
            let conn = null;
            try {
                // 1. Identify Needed Tiles & Check Cache
                const tilesToRender = [];
                const tilesToFetchFull = [];     // Need Geometry + Data
                const tilesToFetchDataOnly = []; // Have Geometry, Need Data

                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        const key = `${x}_${y}_T${targetTier}`;
                        let cached = tileCache.current.get(key);

                        // Initialize cache entry if missing
                        if (!cached) {
                            cached = {
                                key, x, y, tier: targetTier,
                                positions: null,
                                tileInfo: null,
                                count: 0,
                                fullVectors: null,
                                staticValues: new Map()
                            };
                            tileCache.current.set(key, cached);
                        }

                        // Check Data Availability
                        let hasData = false;
                        if (needsFullVector) {
                            if (cached.fullVectors) hasData = true;
                        } else {
                            if (cached.fullVectors || cached.staticValues.has(currentDbIndex)) hasData = true;
                        }

                        if (cached.positions) {
                            if (hasData) {
                                tilesToRender.push(cached);
                            } else {
                                tilesToFetchDataOnly.push(cached);
                            }
                        } else {
                            // Missing positions -> Must fetch everything
                            tilesToFetchFull.push(cached);
                        }
                    }
                }

                conn = await db.connect();
                const DISPLACEMENT_COL = needsFullVector
                    ? "displacements"
                    : `displacements[${currentDbIndex}] AS displacements`;

                // 2. Fetch Full Tiles (Geometry + Data)
                if (tilesToFetchFull.length > 0) {
                    setLoadingStage(`tier${targetTier}`);
                    setDataStatus(`Fetching ${tilesToFetchFull.length} new tiles...`);

                    const whereClauses = tilesToFetchFull.map(t => `(tile_x = ${t.x} AND tile_y = ${t.y})`).join(' OR ');
                    let query = '';

                    if (tilesToFetchFull.length > (maxX - minX + 1) * (maxY - minY + 1) * 0.5) {
                        query = `
                            SELECT tile_x, tile_y, x, y, ${DISPLACEMENT_COL}
                            FROM read_parquet('data.geoparquet')
                            WHERE tile_x BETWEEN ${minX} AND ${maxX}
                              AND tile_y BETWEEN ${minY} AND ${maxY}
                              AND tier_id = ${targetTier}
                        `;
                    } else {
                        query = `
                            SELECT tile_x, tile_y, x, y, ${DISPLACEMENT_COL}
                            FROM read_parquet('data.geoparquet')
                            WHERE (${whereClauses})
                              AND tier_id = ${targetTier}
                        `;
                    }

                    const result = await conn.query(query);
                    if (isActive) {
                        processAndCache(result, true); // true = has geometry
                    }
                }

                // 3. Fetch Data Only (Lazy Loading)
                if (tilesToFetchDataOnly.length > 0) {
                    setDataStatus(`Updating data for ${tilesToFetchDataOnly.length} tiles...`);

                    const whereClauses = tilesToFetchDataOnly.map(t => `(tile_x = ${t.x} AND tile_y = ${t.y})`).join(' OR ');

                    // 🛑 OPTIMIZATION: Do NOT select x, y. Only Data.
                    const query = `
                        SELECT tile_x, tile_y, ${DISPLACEMENT_COL}
                        FROM read_parquet('data.geoparquet')
                        WHERE (${whereClauses})
                          AND tier_id = ${targetTier}
                    `;

                    const result = await conn.query(query);
                    if (isActive) {
                        processAndCache(result, false); // false = data only
                    }
                }

                if (!isActive) return;

                // 4. Update Display
                // Re-gather render list (some might have been fetched just now)
                const finalRenderList = [];
                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        const key = `${x}_${y}_T${targetTier}`;
                        const cached = tileCache.current.get(key);
                        if (cached && cached.positions) finalRenderList.push(cached);
                    }
                }

                updateDisplayState(finalRenderList, targetTier);
                setLoadingStage('idle');
                setDataStatus('Ready');

            } catch (e) {
                console.error("Fetch Error:", e);
                setDataStatus('Error');
            } finally {
                if (conn) await conn.close();
            }
        };

        const processAndCache = (result, hasGeometry) => {
            const processed = processArrowResult(result, needsFullVector, hasGeometry);
            const N = processed.count;

            // Temporary map to group by tile
            const tempMap = new Map();

            for (let i = 0; i < N; i++) {
                const tx = processed.tileInfo[i * 2];
                const ty = processed.tileInfo[i * 2 + 1];
                const key = `${tx}_${ty}_T${targetTier}`;

                if (!tempMap.has(key)) {
                    tempMap.set(key, {
                        positions: [],
                        dVec: [],
                        tileInfo: [],
                        count: 0
                    });
                }
                const t = tempMap.get(key);

                if (hasGeometry) {
                    t.positions.push(processed.positions[i * 2], processed.positions[i * 2 + 1]);
                }

                if (needsFullVector) {
                    t.dVec.push(processed.dVec.get(i));
                } else {
                    t.dVec.push(processed.dVec[i]);
                }

                t.tileInfo.push(tx, ty);
                t.count++;
            }

            // Update Cache
            tempMap.forEach((val, key) => {
                const cached = tileCache.current.get(key);
                if (cached) {
                    if (hasGeometry) {
                        cached.positions = new Float64Array(val.positions);
                        cached.tileInfo = new Int32Array(val.tileInfo);
                        cached.count = val.count;
                    }

                    if (needsFullVector) {
                        cached.fullVectors = val.dVec;
                    } else {
                        cached.staticValues.set(currentDbIndex, new Float64Array(val.dVec));
                    }
                }
            });
        };

        loadData();
        return () => { isActive = false; };
    }, [db, queryParams, needsFullVector, debouncedTimeIndex]);

    const updateDisplayState = (chunks, tierReached) => {
        let totalCount = 0;
        chunks.forEach(c => totalCount += c.count);

        const mergedPos = new Float64Array(totalCount * 2);
        let offset = 0;

        let vectors = [];
        let tileInfos = [];

        // For static display, we flatten the data into a single array if possible
        let staticDisplacements = null;
        let currentOffset = 0;

        if (!fullVectorsLoaded && totalCount > 0) {
            staticDisplacements = new Float64Array(totalCount);
        }

        for (const c of chunks) {
            if (!c.positions) continue; // Skip incomplete tiles

            mergedPos.set(c.positions, offset);
            offset += c.positions.length;

            if (fullVectorsLoaded) {
                if (c.fullVectors) {
                    vectors.push(c.fullVectors);
                } else {
                    vectors.push([]);
                }
            } else {
                let dataSrc = null;
                if (c.fullVectors) {
                    const N = c.count;
                    const slice = new Float64Array(N);
                    for (let i = 0; i < N; i++) {
                        const list = c.fullVectors[i];
                        slice[i] = list ? list.get(timeIndex) : 0;
                    }
                    dataSrc = slice;
                } else {
                    dataSrc = c.staticValues.get(currentDbIndex);
                }

                if (staticDisplacements && dataSrc) {
                    staticDisplacements.set(dataSrc, currentOffset);
                }
                currentOffset += c.count;
            }

            tileInfos.push(c.tileInfo);
        }

        const vectorMeta = chunks.map(c => c.count);

        setPositionArray(mergedPos);

        if (fullVectorsLoaded) {
            setDisplacementVectors({ vectors, lengths: vectorMeta });
        } else {
            setDisplacementVectors({
                vectors: [staticDisplacements],
                lengths: [totalCount]
            });
        }

        setTileIds({ meta: tileInfos, lengths: vectorMeta });
        setVisiblePointCount(totalCount);
        setLoadedTier(tierReached);
    };

    const processArrowResult = (result, isFullVector, hasGeometry = true) => {
        // 🛑 ZERO-COPY OPTIMIZATION
        const dVec = result.getChild('displacements');
        const tileXVec = result.getChild('tile_x');
        const tileYVec = result.getChild('tile_y');

        const N = result.numRows;

        // 1. Positions (Interleaved X, Y)
        let positions = null;
        if (hasGeometry) {
            const xVec = result.getChild('x');
            const yVec = result.getChild('y');
            const xArray = xVec.toArray();
            const yArray = yVec.toArray();
            positions = new Float64Array(N * 2);

            for (let i = 0; i < N; i++) {
                positions[i * 2] = xArray[i];
                positions[i * 2 + 1] = yArray[i];
            }
        }

        // 2. Tile Info
        const txArray = tileXVec.toArray();
        const tyArray = tileYVec.toArray();
        const tileInfo = new Int32Array(N * 2);

        for (let i = 0; i < N; i++) {
            tileInfo[i * 2] = txArray[i];
            tileInfo[i * 2 + 1] = tyArray[i];
        }

        // 3. Displacements
        let displacementData;
        if (!isFullVector) {
            displacementData = dVec.toArray();
        } else {
            displacementData = dVec;
        }

        return { positions, dVec: displacementData, tileInfo, count: N };
    };

    const getFillColor = ({ index }) => {
        if (!displacementVectors) return [100, 100, 100, 255];

        let localIndex = index;
        for (let i = 0; i < displacementVectors.lengths.length; i++) {
            const len = displacementVectors.lengths[i];
            if (localIndex < len) {
                const chunk = displacementVectors.vectors[i];
                let dispValue;

                if (fullVectorsLoaded) {
                    const list = chunk[localIndex];
                    dispValue = list ? list.get(timeIndex) : 0;
                } else {
                    const staticArray = chunk;
                    dispValue = staticArray[localIndex];
                }

                const rgb = colorScale(dispValue ?? 0);
                return [rgb[0], rgb[1], rgb[2], 255];
            }
            localIndex -= len;
        }
        return [100, 100, 100, 255];
    };

    const handlePlayPause = () => {
        if (!fullVectorsLoaded) {
            setFullVectorsLoaded(true);
            setIsPlaying(true);
        } else {
            setIsPlaying(!isPlaying);
        }
    };

    const handleToggleMode = (mode) => {
        if (mode === 'static' && fullVectorsLoaded) {
            setFullVectorsLoaded(false);
            setIsPlaying(false);
        }
    };

    const handleSliderChange = (e) => {
        setIsPlaying(false);
        setTimeIndex(+e.target.value);
    };

    const targetTier = queryParams ? queryParams.targetTier : 0;

    return (
        <div ref={mapContainerRef} className="vtm-container">
            {!startWasm ? (
                <div className="vtm-start-screen">
                    <button onClick={() => setStartWasm(true)} className="vtm-start-button">
                        🚀 Load 3-Tier Virtual Map
                    </button>
                </div>
            ) : (
                <>
                    <DeckGL
                        initialViewState={INITIAL_VIEW_STATE}
                        onViewStateChange={({ viewState }) => setViewState(viewState)}
                        controller={true}
                        layers={[
                            new TileLayer({
                                id: 'base-map',
                                data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                                minZoom: 0, maxZoom: 19, tileSize: 256,
                                renderSubLayers: props => {
                                    const { west, south, east, north } = props.tile.bbox;
                                    return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
                                }
                            }),
                            positionArray && new ScatterplotLayer({
                                id: 'points',
                                data: { length: visiblePointCount },
                                getPosition: (_, { index }) => [positionArray[index * 2], positionArray[index * 2 + 1]],
                                getRadius: getPointRadius(viewState.zoom),
                                radiusUnits: 'pixels',
                                getFillColor: (_, { index }) => getFillColor({ index }),
                                pickable: true,
                                updateTriggers: {
                                    getFillColor: [displacementVectors, timeIndex, fullVectorsLoaded],
                                    getRadius: [viewState.zoom]
                                }
                            })
                        ].filter(Boolean)}

                        getTooltip={({ index }) => {
                            if (index === -1 || !displacementVectors) return null;
                            let localIndex = index;
                            let displacement = null;
                            for (let i = 0; i < displacementVectors.lengths.length; i++) {
                                const len = displacementVectors.lengths[i];
                                if (localIndex < len) {
                                    const chunk = displacementVectors.vectors[i];
                                    if (fullVectorsLoaded) {
                                        const list = chunk[localIndex];
                                        displacement = list ? list.get(timeIndex) : null;
                                    } else {
                                        displacement = chunk[localIndex];
                                    }
                                    break;
                                }
                                localIndex -= len;
                            }
                            const currentDate = dates[timeIndex] || 'N/A';
                            return (displacement !== null && displacement !== undefined)
                                ? `Date: ${currentDate}\nDisplacement: ${(displacement).toFixed(5)}`
                                : null;
                        }}
                    />

                    <MapHUD
                        zoom={viewState.zoom}
                        fullVectorsLoaded={fullVectorsLoaded}
                        targetTier={targetTier}
                        tileBuffer={TILE_BUFFER}
                        dataStatus={dataStatus}
                        loadedTier={loadedTier}
                        loadingStage={loadingStage}
                        visiblePointCount={visiblePointCount}
                    />

                    <TimeControl
                        currentDate={dates[timeIndex]}
                        timeIndex={timeIndex}
                        maxIndex={dates.length > 0 ? dates.length - 1 : 0}
                        isPlaying={isPlaying}
                        fullVectorsLoaded={fullVectorsLoaded}
                        dataReady={dataStatus === 'Ready'}
                        onToggleMode={handleToggleMode}
                        onPlayPause={handlePlayPause}
                        onSliderChange={handleSliderChange}
                    />
                </>
            )}
        </div>
    );
}

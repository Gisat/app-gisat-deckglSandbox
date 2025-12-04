import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDb } from 'duckdb-wasm-kit';
import { setupDB } from './db';
import { scaleLinear } from 'd3-scale';

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
        if (isPlaying && fullVectorsLoaded && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex(prev => {
                    if (prev >= dates.length - 1) return 0;
                    return prev + 1;
                });
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, fullVectorsLoaded, dates.length]);

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
            } catch(e) { console.error("Date fetch error:", e); }
            finally { if(conn) await conn.close(); }
        };
        fetchDates();
    }, [dbInitialized, db]);

    // 4. Viewport Calculations with Buffer
    const queryParams = useMemo(() => {
        if (!mapContainerRef.current) return null;
        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const bounds = viewport.getBounds();

        const rawMinX = Math.floor(bounds[0] / GRID_SIZE);
        const rawMaxX = Math.floor(bounds[2] / GRID_SIZE);
        const rawMinY = Math.floor(bounds[1] / GRID_SIZE);
        const rawMaxY = Math.floor(bounds[3] / GRID_SIZE);

        return {
            minX: rawMinX - TILE_BUFFER,
            maxX: rawMaxX + TILE_BUFFER,
            minY: rawMinY - TILE_BUFFER,
            maxY: rawMaxY + TILE_BUFFER,
            targetTier: getTargetTier(debouncedViewState.zoom)
        };
    }, [debouncedViewState]);

    // 5. Data Fetching
    useEffect(() => {
        if (!db || !queryParams) return;

        let isActive = true;
        const { minX, maxX, minY, maxY, targetTier } = queryParams;

        const modeSuffix = needsFullVector ? 'FULL' : `STATIC_${currentDbIndex}`;
        const currentKey = `${minX}-${maxX}-${minY}-${maxY}-${targetTier}-${modeSuffix}`;

        if (lastQueryParams.current.key === currentKey) return;
        lastQueryParams.current = { key: currentKey };

        // Cache Clearing
        const isStaticMode = !needsFullVector;
        tileCache.current.forEach((value, key) => {
            const isFullKey = key.endsWith('FULL');
            if (isStaticMode && isFullKey) {
                tileCache.current.delete(key);
            } else if (needsFullVector && !isFullKey) {
                tileCache.current.delete(key);
            } else if (isStaticMode && !isFullKey && key.includes('STATIC_') && !key.endsWith(`STATIC_${currentDbIndex}`)) {
                tileCache.current.delete(key);
            }
        });

        // We DO NOT reset loadedTier to -1 here. We wait.

        const loadData = async () => {
            let conn = null;

            try {
                conn = await db.connect();

                const DISPLACEMENT_COL = needsFullVector
                    ? "displacements"
                    : `displacements[${currentDbIndex}] AS displacements`;

                setLoadingStage('tier0');

                // --- TIER 0 ---
                const viewKey0 = `${minX}_${maxX}_${minY}_${maxY}_T0_${modeSuffix}`;
                let t0 = tileCache.current.get(viewKey0);

                if (!t0) {
                    setDataStatus(`Fetching T0 (${modeSuffix})`);
                    const q0 = `
                        SELECT tile_x, tile_y, x, y, ${DISPLACEMENT_COL}
                        FROM read_parquet('data.geoparquet')
                        WHERE tile_x BETWEEN ${minX} AND ${maxX}
                          AND tile_y BETWEEN ${minY} AND ${maxY}
                          AND tier_id = 0
                    `;
                    const res0 = await conn.query(q0);
                    if (!isActive) return;
                    if(res0.numRows > 0) {
                        t0 = processArrowResult(res0, needsFullVector);
                        tileCache.current.set(viewKey0, t0);
                    }
                } else {
                    setDataStatus('Cache T0');
                }

                if (!isActive) return;

                // 🛑 SMART UPDATE LOGIC
                // Only render T0 immediately if we aren't waiting for higher tiers (Tier 1/2),
                // OR if we have literally nothing on screen (loadedTier == -1).
                if (targetTier === 0) {
                    if (t0) updateDisplayState([t0], 0);
                } else if (loadedTier === -1 && t0) {
                    updateDisplayState([t0], 0);
                }

                // --- TIER 1 ---
                if (targetTier >= 1) {
                    const viewKey1 = `${minX}_${maxX}_${minY}_${maxY}_T1_${modeSuffix}`;
                    let t1 = tileCache.current.get(viewKey1);

                    if (!t1) {
                        setLoadingStage('pause1');
                        // Small delay not strictly needed with buffer, but helps debounce fetch storm on rapid zoom
                        // await new Promise(r => setTimeout(r, 100));
                        if (!isActive) return;

                        setLoadingStage('tier1');
                        setDataStatus(`Fetching T1 (${modeSuffix})`);
                        const q1 = `
                            SELECT tile_x, tile_y, x, y, ${DISPLACEMENT_COL}
                            FROM read_parquet('data.geoparquet')
                            WHERE tile_x BETWEEN ${minX} AND ${maxX}
                              AND tile_y BETWEEN ${minY} AND ${maxY}
                              AND tier_id = 1
                        `;
                        const res1 = await conn.query(q1);
                        if (!isActive) return;
                        if(res1.numRows > 0) {
                            t1 = processArrowResult(res1, needsFullVector);
                            tileCache.current.set(viewKey1, t1);
                        }
                    } else {
                        setDataStatus('Cache T1');
                    }

                    if (!isActive) return;

                    // Update Tier 1
                    if (targetTier === 1) {
                        if (t1 && t0) updateDisplayState([t0, t1], 1);
                        else if (t1) updateDisplayState([t1], 1);
                        // Only fallback to T0 if T1 is totally missing
                        else if (t0 && loadedTier < 0) updateDisplayState([t0], 0);
                    } else if (loadedTier === -1 && t1) {
                        // Intermediate update if aiming for T2
                        updateDisplayState(t0 ? [t0, t1] : [t1], 1);
                    }
                }

                // --- TIER 2 ---
                if (targetTier >= 2) {
                    const viewKey2 = `${minX}_${maxX}_${minY}_${maxY}_T2_${modeSuffix}`;
                    let t2 = tileCache.current.get(viewKey2);

                    if (!t2) {
                        setLoadingStage('pause2');
                        if (!isActive) return;

                        setLoadingStage('tier2');
                        setDataStatus(`Fetching T2 (${modeSuffix})`);
                        const q2 = `
                            SELECT tile_x, tile_y, x, y, ${DISPLACEMENT_COL}
                            FROM read_parquet('data.geoparquet')
                            WHERE tile_x BETWEEN ${minX} AND ${maxX}
                              AND tile_y BETWEEN ${minY} AND ${maxY}
                              AND tier_id = 2
                        `;
                        const res2 = await conn.query(q2);
                        if (!isActive) return;
                        if(res2.numRows > 0) {
                            t2 = processArrowResult(res2, needsFullVector);
                            tileCache.current.set(viewKey2, t2);
                        }
                    } else {
                        setDataStatus('Cache T2');
                    }

                    if (t2) {
                        const viewKey1 = `${minX}_${maxX}_${minY}_${maxY}_T1_${modeSuffix}`;
                        const t1 = tileCache.current.get(viewKey1);

                        const chunks = [];
                        if (t0) chunks.push(t0);
                        if (t1) chunks.push(t1);
                        chunks.push(t2);

                        updateDisplayState(chunks, 2);
                    }
                }

                setLoadingStage('idle');
                setDataStatus('Ready');

            } catch (e) {
                console.error("Fetch Error:", e);
                setDataStatus('Error');
            } finally {
                if (conn) await conn.close();
            }
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

        let staticDisplacements = null;
        let currentOffset = 0;

        if (!fullVectorsLoaded && totalCount > 0) {
            staticDisplacements = new Float64Array(totalCount);
        }

        for (const c of chunks) {
            mergedPos.set(c.positions, offset);
            offset += c.positions.length;

            if (fullVectorsLoaded) {
                vectors.push(c.dVec);
            } else {
                if (staticDisplacements) {
                    staticDisplacements.set(c.dVec, currentOffset);
                    currentOffset += c.count;
                }
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

    const processArrowResult = (result, isFullVector) => {
        const xVec = result.getChild('x');
        const yVec = result.getChild('y');
        const dVec = result.getChild('displacements');
        const tileXVec = result.getChild('tile_x');
        const tileYVec = result.getChild('tile_y');

        const N = result.numRows;

        const positions = new Float64Array(N * 2);
        let displacementData;

        if (!isFullVector) {
            displacementData = new Float64Array(N);
        } else {
            displacementData = dVec;
        }

        const tileInfo = new Int32Array(N * 2);

        for (let i = 0; i < N; i++) {
            positions[i * 2] = xVec.get(i);
            positions[i * 2 + 1] = yVec.get(i);

            if (!isFullVector) {
                displacementData[i] = dVec.get(i);
            }

            tileInfo[i * 2] = tileXVec.get(i);
            tileInfo[i * 2 + 1] = tileYVec.get(i);
        }

        return { positions, dVec: displacementData, tileInfo, count: N };
    };

    const getFillColor = ({index}) => {
        if (!displacementVectors) return [100, 100, 100, 255];

        let localIndex = index;
        for (let i = 0; i < displacementVectors.lengths.length; i++) {
            const len = displacementVectors.lengths[i];
            if (localIndex < len) {
                const chunk = displacementVectors.vectors[i];
                let dispValue;

                if (fullVectorsLoaded) {
                    const listVector = chunk;
                    const list = listVector.get(localIndex);
                    dispValue = list ? list.get(timeIndex) : 0;
                } else {
                    const staticArray = chunk;
                    dispValue = staticArray[localIndex];
                }

                // 🛑 RAW VALUE (No multiplication), Domain [-20, 0, 20]
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
            setTimeIndex(0);
        }
    };

    const handleSliderChange = (e) => {
        setIsPlaying(false);
        setTimeIndex(+e.target.value);
    };

    const targetTier = queryParams ? queryParams.targetTier : 0;

    return (
        <div ref={mapContainerRef} style={{ width: '100vw', height: '100vh', position: 'relative' }}>
            {!startWasm ? (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#f5f5f5', zIndex: 10 }}>
                    <button onClick={() => setStartWasm(true)} style={{ padding: '15px 30px', fontSize: '18px', cursor: 'pointer', background: '#2c3e50', color: 'white', border: 'none', borderRadius: '4px' }}>
                        🚀 Load 3-Tier Virtual Map
                    </button>
                </div>
            ) : (
                <>
                    <DeckGL
                        initialViewState={INITIAL_VIEW_STATE}
                        onViewStateChange={({viewState}) => setViewState(viewState)}
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
                                getPosition: (_, {index}) => [positionArray[index * 2], positionArray[index * 2 + 1]],
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

                        getTooltip={({index}) => {
                            if (index === -1 || !displacementVectors) return null;
                            let localIndex = index;
                            let displacement = null;
                            for (let i = 0; i < displacementVectors.lengths.length; i++) {
                                const len = displacementVectors.lengths[i];
                                if (localIndex < len) {
                                    const chunk = displacementVectors.vectors[i];
                                    if (fullVectorsLoaded) {
                                        const list = chunk.get(localIndex);
                                        displacement = list ? list.get(timeIndex) : null;
                                    } else {
                                        displacement = chunk[localIndex];
                                    }
                                    break;
                                }
                                localIndex -= len;
                            }
                            const currentDate = dates[timeIndex] || 'N/A';
                            // No unit in tooltip
                            return (displacement !== null && displacement !== undefined)
                                ? `Date: ${currentDate}\nDisplacement: ${(displacement).toFixed(5)}`
                                : null;
                        }}
                    />

                    {/* 🛑 DETAILED HUD: Restored to detailed view */}
                    <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.8)', color: 'white', padding: '12px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '14px', pointerEvents: 'none' }}>
                        <div>Zoom Level: <span style={{color: '#4fc3f7'}}>{viewState.zoom.toFixed(1)}</span></div>
                        <div style={{marginTop: '4px', borderTop: '1px solid #555', paddingTop: '4px'}}>
                            <strong>Mode: </strong>
                            <span style={{color: fullVectorsLoaded ? '#4caf50' : '#ffb74d'}}>
                                {fullVectorsLoaded ? 'FULL VECTORS (Animation)' : 'STATIC (Lightweight)'}
                            </span>
                        </div>
                        <div style={{marginTop: '4px'}}>
                            <strong>Target Tier: {targetTier}</strong>
                            <span style={{color: '#ffb74d'}}> (Buffer: {TILE_BUFFER})</span>
                        </div>

                        <div style={{
                            marginBottom: '8px',
                            fontSize: '12px',
                            color: dataStatus.includes('Cache') ? '#81c784' : (dataStatus.includes('Fetching') ? '#ffb74d' : '#ccc')
                        }}>
                            Status: <strong>{dataStatus}</strong>
                        </div>

                        <div style={{color: loadedTier >= 0 ? '#81c784' : (loadingStage === 'tier0' ? '#ffb74d' : '#555')}}>
                            • Tier 0 (5%) {loadingStage === 'tier0' && '⏳'} {loadedTier >= 0 && '✅'}
                        </div>
                        <div style={{color: targetTier >= 1 ? (loadedTier >= 1 ? '#81c784' : '#ffb74d') : '#555', opacity: targetTier >= 1 ? 1 : 0.5}}>
                            • Tier 1 (+30%) {loadingStage === 'tier1' && '⏳'} {loadingStage === 'pause1' && '⏸'} {loadedTier >= 1 && '✅'}
                        </div>
                        <div style={{color: targetTier >= 2 ? (loadedTier >= 2 ? '#81c784' : '#ffb74d') : '#555', opacity: targetTier >= 2 ? 1 : 0.5}}>
                            • Tier 2 (+65%) {loadingStage === 'tier2' && '⏳'} {loadingStage === 'pause2' && '⏸'} {loadedTier >= 2 && '✅'}
                        </div>

                        <div style={{marginTop: '8px'}}>Points: <span style={{color: '#fff'}}>{visiblePointCount}</span></div>
                    </div>

                    {/* Time Slider */}
                    <div style={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', width: '60%', background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                            <div style={{fontWeight: 'bold', minWidth: '100px', fontFamily: 'sans-serif'}}>
                                {dates[timeIndex] || 'Loading...'}
                            </div>
                            <button
                                onClick={() => handleToggleMode('static')}
                                style={{
                                    padding: '5px 15px',
                                    background: fullVectorsLoaded ? '#f44336' : '#9e9e9e',
                                    color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer',
                                    opacity: fullVectorsLoaded ? 1 : 0.5,
                                    marginRight: '10px'
                                }}
                                disabled={!fullVectorsLoaded}
                            >
                                🖼️ Static View
                            </button>
                            <button
                                onClick={handlePlayPause}
                                style={{
                                    padding: '5px 15px',
                                    background: isPlaying ? '#ff5252' : (fullVectorsLoaded ? '#4caf50' : '#2196f3'),
                                    color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer'
                                }}
                            >
                                {isPlaying ? '⏸ Pause' : (fullVectorsLoaded ? '▶ Play' : '💾 Load All + Play')}
                            </button>
                        </div>
                        <input
                            type="range" min={0} max={dates.length > 0 ? dates.length - 1 : 0}
                            value={timeIndex}
                            onChange={handleSliderChange}
                            style={{ width: '100%' }}
                            disabled={dates.length === 0}
                        />
                        <div style={{fontSize: '12px', color: '#666', textAlign: 'center'}}>
                            {fullVectorsLoaded ? 'Animation enabled.' : 'In Lightweight mode, sliding will fetch data for the selected date.'}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}

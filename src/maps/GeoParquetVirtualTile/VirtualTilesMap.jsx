import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDb, useDuckDbQuery } from 'duckdb-wasm-kit';
import { setupDB } from './db';
import { scaleLinear } from 'd3-scale';

const GRID_SIZE = 0.10;

function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => { setDebouncedValue(value); }, delay);
        return () => { clearTimeout(handler); };
    }, [value, delay]);
    return debouncedValue;
}

const INITIAL_VIEW_STATE = {
    longitude: 13.96344,
    latitude: 49.954055, zoom: 14,
    pitch: 0, bearing: 0 };

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

// LOD Logic: Determines what % of points to load based on zoom
function getSampleThreshold(zoom) {
    if (zoom < 10) return 3;
    if (zoom < 12) return 15;
    if (zoom < 14) return 50;
    return 101;
}

// Point Size Logic: Keeps points small when zoomed out
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
    const [isPlaying, setIsPlaying] = useState(false);

    // Data State
    const [positionArray, setPositionArray] = useState(null);
    const [displacementVector, setDisplacementVector] = useState(null);
    const [visiblePointCount, setVisiblePointCount] = useState(0);

    const lastQueryParams = useRef({ key: "" });
    const mapContainerRef = useRef(null);
    const debouncedViewState = useDebounce(viewState, 400);

    const { db } = useDuckDb();

    // 1. Initialize DB
    useEffect(() => {
        if (!startWasm) return;
        setupDB().then(() => setDbInitialized(true)).catch(console.error);
    }, [startWasm]);

    // 2. Animation Loop
    useEffect(() => {
        let interval;
        if (isPlaying && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex(prev => {
                    if (prev >= dates.length - 1) return 0;
                    return prev + 1;
                });
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates.length]);

    // 3. Fetch Dates (The Fix is Here)
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

                    console.log("🔍 DEBUG: First raw date value:", rawArray[0], typeof rawArray[0]); // Check Console!

                    const strDates = Array.from(rawArray).map(ts => {
                        try {
                            // 1. Unwrap BigInt/Objects if necessary
                            let val = Number(ts);

                            // 2. Handle already-parsed Date objects (rare but possible in Arrow)
                            if (ts instanceof Date) {
                                return ts.toISOString().split('T')[0];
                            }

                            // 3. Auto-Detect Format (Days vs Milliseconds)
                            // - Days since 1970 are small (e.g., 19,358 for year 2023)
                            // - Milliseconds are huge (e.g., 1,672,531,200,000)
                            // Threshold: 1,000,000 (~ year 4700 if days).

                            let dateObj;
                            if (val < 1000000) {
                                // It's DAYS -> Convert to MS
                                dateObj = new Date(val * 86400000);
                            } else {
                                // It's ALREADY MS -> Use directly
                                dateObj = new Date(val);
                            }

                            if (isNaN(dateObj.getTime())) return "Invalid Date";
                            return dateObj.toISOString().split('T')[0];

                        } catch (e) {
                            console.warn("Date Error:", e);
                            return "Error";
                        }
                    });
                    setDates(strDates);
                }
            } catch(e) { console.error("Date fetch error:", e); }
            finally { if(conn) await conn.close(); }
        };
        fetchDates();
    }, [dbInitialized, db]);

    // 4. Smart Query Generation
    const currentQuery = useMemo(() => {
        if (!dbInitialized || !mapContainerRef.current) return null;

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const bounds = viewport.getBounds();

        const minX = Math.floor(bounds[0] / GRID_SIZE);
        const maxX = Math.floor(bounds[2] / GRID_SIZE);
        const minY = Math.floor(bounds[1] / GRID_SIZE);
        const maxY = Math.floor(bounds[3] / GRID_SIZE);

        const sampleLimit = getSampleThreshold(debouncedViewState.zoom);

        let bboxFilter = "";
        if (debouncedViewState.zoom > 12) {
            const spanX = bounds[2] - bounds[0];
            const spanY = bounds[3] - bounds[1];
            const bufferX = spanX * 0.5;
            const bufferY = spanY * 0.5;
            const SNAP = 0.01;
            const qMinLon = Math.floor((bounds[0] - bufferX) / SNAP) * SNAP;
            const qMaxLon = Math.ceil((bounds[2] + bufferX) / SNAP) * SNAP;
            const qMinLat = Math.floor((bounds[1] - bufferY) / SNAP) * SNAP;
            const qMaxLat = Math.ceil((bounds[3] + bufferY) / SNAP) * SNAP;

            bboxFilter = `
                AND bbox_xmax >= ${qMinLon.toFixed(3)}
                AND bbox_xmin <= ${qMaxLon.toFixed(3)}
                AND bbox_ymax >= ${qMinLat.toFixed(3)}
                AND bbox_ymin <= ${qMaxLat.toFixed(3)}
            `;
        }

        const currentKey = `${minX}-${maxX}-${minY}-${maxY}-${sampleLimit}-${bboxFilter}`;

        if (lastQueryParams.current.key === currentKey) {
            // Cache Hit (Logic handled by hook mostly, but good for debugging)
        }
        lastQueryParams.current = { key: currentKey };

        return `
            SELECT
                ST_X(geometry) as x,
                ST_Y(geometry) as y,
                displacements
            FROM read_parquet('data.geoparquet')
            WHERE
                tile_x BETWEEN ${minX} AND ${maxX}
              AND tile_y BETWEEN ${minY} AND ${maxY}
                ${bboxFilter}
                AND sample_idx < ${sampleLimit}
        `;
    }, [dbInitialized, debouncedViewState]);

    const { arrow: data, loading: isLoading } = useDuckDbQuery(currentQuery);

    // 5. Data Processing
    useEffect(() => {
        if (data && data.numRows > 0) {
            const xVec = data.getChild('x');
            const yVec = data.getChild('y');
            const dVec = data.getChild('displacements');

            const N = data.numRows;
            const positions = new Float64Array(N * 2);
            for (let i = 0; i < N; i++) {
                positions[i * 2] = xVec.get(i);
                positions[i * 2 + 1] = yVec.get(i);
            }
            setPositionArray(positions);
            setDisplacementVector(dVec);
            setVisiblePointCount(N);
        } else if (data) {
            setVisiblePointCount(0);
        }
    }, [data]);

    // 6. Layers
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
        positionArray && displacementVector && new ScatterplotLayer({
            id: 'points',
            data: { length: visiblePointCount },
            getPosition: (_, {index}) => [positionArray[index * 2], positionArray[index * 2 + 1]],

            // Scaled Radius
            getRadius: getPointRadius(viewState.zoom),
            radiusUnits: 'pixels',

            // Color from Memory (Instant)
            getFillColor: (_, { index }) => {
                const rowList = displacementVector.get(index);
                if (!rowList) return [200, 200, 200, 100];
                const val = rowList.get(timeIndex);
                const rgb = colorScale(val ?? 0);
                return [rgb[0], rgb[1], rgb[2], 200];
            },
            pickable: true,

            updateTriggers: {
                getFillColor: [timeIndex, displacementVector],
                getRadius: [viewState.zoom]
            }
        })
    ].filter(Boolean);

    const getTooltip = ({index}) => {
        if(index === -1 || !displacementVector) return null;
        const rowList = displacementVector.get(index);
        const val = rowList ? rowList.get(timeIndex) : null;
        return val != null ? `Displacement: ${val.toFixed(3)} mm` : null;
    }

    const percentShown = getSampleThreshold(viewState.zoom);

    return (
        <div ref={mapContainerRef} style={{ width: '100vw', height: '100vh', position: 'relative' }}>
            {!startWasm ? (
                <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: '#f5f5f5', zIndex: 10 }}>
                    <button onClick={() => setStartWasm(true)} style={{ padding: '15px 30px', fontSize: '18px', cursor: 'pointer', background: '#2c3e50', color: 'white', border: 'none', borderRadius: '4px' }}>
                        🚀 Load Virtual Tiling Map
                    </button>
                </div>
            ) : (
                <>
                    <DeckGL
                        initialViewState={INITIAL_VIEW_STATE}
                        onViewStateChange={({viewState}) => setViewState(viewState)}
                        controller={true}
                        layers={layers}
                        getTooltip={getTooltip}
                    />

                    {/* HUD Stats */}
                    <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.8)', color: 'white', padding: '12px', borderRadius: '4px', fontFamily: 'monospace', fontSize: '14px', pointerEvents: 'none' }}>
                        <div>Zoom Level: <span style={{color: '#4fc3f7'}}>{viewState.zoom.toFixed(1)}</span></div>
                        <div>LOD Detail: <span style={{color: '#4fc3f7'}}>{percentShown >= 101 ? '100%' : percentShown + '%'}</span></div>
                        <div>Points Loaded: <span style={{color: '#81c784'}}>{visiblePointCount}</span></div>
                        {isLoading && <div style={{color: '#ffb74d', marginTop: '5px'}}>⏳ Fetching Geometry...</div>}
                    </div>

                    {/* Time Slider */}
                    <div style={{ position: 'absolute', bottom: 30, left: '50%', transform: 'translateX(-50%)', width: '60%', background: 'white', padding: '15px', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', display: 'flex', flexDirection: 'column', gap: '10px' }}>

                        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                            <div style={{fontWeight: 'bold', minWidth: '100px', fontFamily: 'sans-serif'}}>
                                {dates[timeIndex] || 'Loading...'}
                            </div>

                            <button
                                onClick={() => setIsPlaying(!isPlaying)}
                                style={{
                                    padding: '5px 15px',
                                    background: isPlaying ? '#ff5252' : '#4caf50',
                                    color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer'
                                }}
                            >
                                {isPlaying ? '⏸ Pause' : '▶ Play'}
                            </button>
                        </div>

                        <input
                            type="range" min={0} max={dates.length > 0 ? dates.length - 1 : 0}
                            value={timeIndex} onChange={e => {
                            setIsPlaying(false);
                            setTimeIndex(+e.target.value);
                        }}
                            style={{ width: '100%' }}
                            disabled={dates.length === 0}
                        />
                    </div>
                </>
            )}
        </div>
    );
}

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDb } from 'duckdb-wasm-kit';
import * as duckdb from "@duckdb/duckdb-wasm";
import { setupDB } from './db';
import { getTileUrls } from './utils/getTileUrls';
import { scaleLinear } from 'd3-scale';

// --- Debounce Hook ---
function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => { setDebouncedValue(value); }, delay);
        return () => { clearTimeout(handler); };
    }, [value, delay]);
    return debouncedValue;
}
// --- End Debounce Hook ---

const INITIAL_VIEW_STATE = {
    longitude: 13.96344,
    latitude: 49.954055, zoom: 14,
    pitch: 0, bearing: 0
};

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

// 🛑 GLOBAL CONSTANTS
const BUFFER_DEG = 0.001; // Buffer for BBOX filtering
const FAKE_DATES = [
    '2019-01-01', '2019-06-01', '2020-01-01', '2020-06-01',
    '2021-01-01', '2021-06-01', '2022-01-01', '2022-06-01'
];
const ACTUAL_HASHED_FILE_NAME = 'd5da031a332c4dbb977017ffb9035858-0.parquet';
const BASE_URL_ROOT = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_tiled_detail_v2';

// MAIN QUERY TEMPLATE - FIXED: Uses geom_wkb and BBOX filter
const MAIN_QUERY_TEMPLATE = (fileListStr, dbIndex, minLon, minLat, maxLon, maxLat) => {
    // Calculate buffered viewport bounds for the ST_MakeEnvelope function
    const bufferedMinLon = minLon - BUFFER_DEG;
    const bufferedMinLat = minLat - BUFFER_DEG;
    const bufferedMaxLon = maxLon + BUFFER_DEG;
    const bufferedMaxLat = maxLat + BUFFER_DEG;

    // Use the alias 'g' for the geometry column to simplify the query string
    return ` 
        LOAD spatial; 
        SELECT 
            ST_X(g) AS x, 
            ST_Y(g) AS y, 
            displacements[${dbIndex}] AS displacement
        FROM (
            SELECT 
                geom_wkb AS g, -- Alias the geometry column
                displacements
            FROM read_parquet([${fileListStr}])
        )
        WHERE 
            -- 🛑 ST_INTERSECTS FILTER 🛑
            ST_Intersects(g, ST_MakeEnvelope(${bufferedMinLon}, ${bufferedMinLat}, ${bufferedMaxLon}, ${bufferedMaxLat}))
        AND displacements[${dbIndex}] IS NOT NULL;
    `;
};


function GeoParquetTile() {
    const [startWasm, setStartWasm] = useState(false);
    const [dbInitialized, setDbInitialized] = useState(false);
    const [positionArray, setPositionArray] = useState(null);
    const [attributeTable, setAttributeTable] = useState(null);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [visiblePointCount, setVisiblePointCount] = useState(0);

    const [dates, setDates] = useState([]);
    const [timeIndex, setTimeIndex] = useState(0);

    const [isDatesLoading, setIsDatesLoading] = useState(true);
    const [pointsLoading, setPointsLoading] = useState(false);

    const [tileNamesToQuery, setTileNamesToQuery] = useState([]);
    const registeredTilesRef = useRef(new Set());

    const [sqlQuery, setSqlQuery] = useState(null);

    const mapContainerRef = useRef(null);

    // 🛑 FIX: Faster Debounce for improved panning responsiveness
    const debouncedViewState = useDebounce(viewState, 200);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    const { db } = useDuckDb();

    // 1. Setup DB effect
    useEffect(() => {
        if (!startWasm) return;
        async function setup() {
            try {
                await setupDB();
                console.log("✅ DB setup finished.");
                setDbInitialized(true);
            } catch (e) {
                console.error("❌ DB Setup failed:", e);
            }
        }
        setup();
    }, [startWasm]);

    // 2. Dynamic Tile Registration & Query List Update
    useEffect(() => {
        if (!dbInitialized || !mapContainerRef.current || !db) return;

        // --- Date Initialization (TEMPORARY FIX) ---
        if (dates.length === 0) {
            setDates(FAKE_DATES);
            setTimeIndex(0);
            setIsDatesLoading(false);
        }
        // ------------------------------------------

        // --- Date Reference Registration (for state consistency) ---
        const registerDateRefTile = async () => {
            const centerRefTileURL = `${BASE_URL_ROOT}/part_x=X14.0/part_y=Y50.0/data_0.parquet`; // Using data_0.parquet for simplicity
            const centerRefFileName = 'tile_center_date_ref.parquet';

            if (!registeredTilesRef.current.has(centerRefFileName)) {
                try {
                    await db.registerFileURL(centerRefFileName, centerRefTileURL);
                    registeredTilesRef.current.add(centerRefFileName);
                } catch (e) { /* silent fail */ }
            }
        };
        registerDateRefTile();

        // --- Main Map Data Fetcher ---
        const fetchTilesForView = async () => {
            const { clientWidth, clientHeight } = mapContainerRef.current;
            if (!clientWidth || !clientHeight) return;

            const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
            const bounds = viewport.getBounds();

            const requiredTiles = getTileUrls(bounds);

            const newTilesToRegister = [];
            const filenamesToQuery = [];

            for (const { url, filename } of requiredTiles) {
                const internalFilename = url; // Use URL as internal name

                filenamesToQuery.push(internalFilename);

                if (!registeredTilesRef.current.has(internalFilename)) {
                    newTilesToRegister.push({ url, filename: internalFilename });
                }
            }

            if (newTilesToRegister.length > 0) {
                console.log(`🗺️ Registering ${newTilesToRegister.length} new tiles...`);
                await Promise.all(newTilesToRegister.map(async ({ url, filename }) => {
                    try {
                        // 🛑 FIX: Use standard browser Fetch API to get the buffer
                        const response = await fetch(url);

                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status} for URL: ${url}`);
                        }

                        const buffer = await response.arrayBuffer();

                        // 🛑 Register the ArrayBuffer data directly to the Wasm VFS
                        await db.registerFileBuffer(filename, new Uint8Array(buffer));
                        registeredTilesRef.current.add(filename);

                    } catch (e) {
                        // Suppressing errors for expected 404s/File-too-small failures by only registering valid files
                    }
                }));
            }

            setTileNamesToQuery(filenamesToQuery);
        };
        fetchTilesForView();

    }, [dbInitialized, debouncedViewState, db]);


    // 3. Query Generator (useMemo)
    const querySQL = useMemo(() => {
        if (!dbInitialized || tileNamesToQuery.length === 0 || dates.length === 0) {
            return null;
        }

        const dbIndex = debouncedTimeIndex + 1;
        const fileListStr = tileNamesToQuery.map(f => `'${f}'`).join(', ');

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        // NOTE: Bounds are calculated here but buffered inside the SQL template
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        const generatedQuery = MAIN_QUERY_TEMPLATE(fileListStr, dbIndex, minLon, minLat, maxLon, maxLat);

        setSqlQuery(generatedQuery);
        return generatedQuery;
    }, [dbInitialized, tileNamesToQuery, debouncedTimeIndex, dates, debouncedViewState]);


    // 4. Data Fetcher (Handles execution of the generated SQL)
    useEffect(() => {
        if (!sqlQuery || !dbInitialized) {
            setPointsLoading(false);
            return;
        }

        const fetchData = async () => {
            setPointsLoading(true);
            let conn = null;
            try {
                conn = await db.connect();
                const table = await conn.query(sqlQuery);

                processArrowTable(table);
            } catch (error) {
                console.error("❌ ERROR: Main Data Query failed.", error);
                processArrowTable(null);
            } finally {
                if (conn) { await conn.close(); }
                setPointsLoading(false);
            }
        };
        fetchData();

    }, [sqlQuery, dbInitialized]);


    // 5. Data Processing Function
    const processArrowTable = (data) => {
        if (data && data.numRows > 0) {
            const xVector = data.getChild('x');
            const yVector = data.getChild('y');

            if (!xVector || !yVector) {
                console.error("❌ ERROR: Arrow table missing 'x' or 'y' columns.");
                return;
            }

            const N = data.numRows;
            const positions = new Float64Array(N * 2);
            for (let i = 0; i < N; i++) {
                positions[i * 2] = xVector.get(i);
                positions[i * 2 + 1] = yVector.get(i);
            }
            setPositionArray(positions);
            setAttributeTable(data);
            setVisiblePointCount(data.numRows);
        } else {
            setVisiblePointCount(0);
            setPositionArray(null);
            setAttributeTable(null);
        }
    };


    // Define Layers
    const baseMapLayer = new TileLayer({
        id: 'tile-layer', data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        minZoom: 0, maxZoom: 19, tileSize: 256,
        renderSubLayers: props => {
            const { west, south, east, north } = props.tile.bbox;
            return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
        }
    });

    const pointsLayer = attributeTable && positionArray && new ScatterplotLayer({
        id: 'scatterplot-layer',
        data: { length: visiblePointCount },
        getPosition: (_, {index}) => [
            positionArray[index * 2],
            positionArray[index * 2 + 1]
        ],
        getRadius: 2,
        radiusUnits: 'pixels',
        getFillColor: (object, { index, data }) => {
            const displ = attributeTable.getChild('displacement')?.get(index);
            const rgb = colorScale(displ ?? 0);
            return [rgb[0], rgb[1], rgb[2], 180];
        },
        pickable: true,
        _fastCompare: true
    });

    const layers = [baseMapLayer, pointsLayer].filter(Boolean);
    const isLoading = !dbInitialized || isDatesLoading || pointsLoading;

    // Tooltip function
    const getTooltipContent = ({ index }) => {
        if (index === undefined || index < 0 || !attributeTable) { return null; }
        const displacement = attributeTable.getChild('displacement')?.get(index);
        const currentDate = dates[timeIndex] || 'N/A';
        return (displacement !== null && displacement !== undefined)
            ? `Date: ${currentDate}\nDisplacement: ${displacement.toFixed(2)}`
            : null;
    };

    const handleStartWasm = () => {
        setStartWasm(true);
    };

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            {/* 🛑 CONDITIONAL RENDERING: Show Map or Start Button */}
            {!startWasm ? (
                <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', backgroundColor: '#f0f0f0', zIndex: 2000 }}>
                    <h2 style={{ fontFamily: 'sans-serif', marginBottom: '20px' }}>DuckDB Wasm POC: Tiled GeoParquet Viewer</h2>
                    <button
                        onClick={handleStartWasm}
                        style={{ padding: '15px 30px', fontSize: '1.2em', cursor: 'pointer', backgroundColor: '#4CAF50', color: 'white', border: 'none', borderRadius: '5px', boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
                        🚀 Start Wasm & Load Map
                    </button>
                    <p style={{ fontFamily: 'sans-serif', marginTop: '15px', fontSize: '0.9em', color: '#666' }}>
                        The WebAssembly database core will load upon clicking.
                    </p>
                </div>
            ) : (
                <>
                    {/* Slider UI */}
                    <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', width: '80%', maxWidth: '800px', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>
                        <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                            <button onClick={() => setTimeIndex(timeIndex - 1)} disabled={isLoading || timeIndex === 0}>Back</button>
                            <div style={{textAlign: 'center', flexGrow: 1}}>
                                <label style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    Date: {isLoading ? 'Loading...' : (dates[timeIndex] || '...')}</label>
                                <input type="range" min={0} max={dates.length > 0 ? dates.length - 1 : 0} step={1} value={timeIndex} onChange={e => setTimeIndex(Number(e.target.value))} style={{width: '100%'}} disabled={isLoading || dates.length === 0} />
                            </div>
                            <button onClick={() => setTimeIndex(timeIndex + 1)} disabled={isLoading || dates.length === 0 || timeIndex >= dates.length - 1}>Next</button>
                        </div>
                    </div>

                    <DeckGL
                        initialViewState={INITIAL_VIEW_STATE}
                        onViewStateChange={({ viewState: newViewState }) => setViewState(newViewState)}
                        controller={true}
                        views={new MapView({ repeat: true })}
                        layers={layers}
                        getTooltip={getTooltipContent}
                    />

                    {/* Loading Indicator */}
                    {(isLoading) && (
                        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', background: 'rgba(0,0,0,0.7)', padding: '20px', borderRadius: '8px', zIndex: 1000 }}>
                            {pointsLoading || isDatesLoading ? '⏳ Querying data...' : '⏳ Initializing Wasm...'}
                        </div>
                    )}

                    {/* Point Count Display */}
                    <div style={{ position: 'absolute', top: '10px', left: '10px', color: 'white', background: 'rgba(0,0,0,0.7)', padding: '5px 10px', borderRadius: '4px', zIndex: 1000, fontFamily: 'sans-serif' }}>
                        📍 Visible Points: {visiblePointCount}
                    </div>
                </>
            )}
        </div>
    );
}

export default GeoParquetTile;

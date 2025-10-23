// src/maps/MinimalWasmMap.jsx
import React, { useEffect, useState, useRef, useMemo } from 'react'; // Removed useTransition
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDb, useDuckDbQuery } from 'duckdb-wasm-kit';
import { setupDB } from './db';
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
    pitch: 0, bearing: 0 };

// Color scale
const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

// SQL Query to fetch dates
const DATES_QUERY = `
    LOAD httpfs;
    SELECT dates FROM read_parquet('data_subset.geoparquet') LIMIT 1;
`;

function MinimalWasmMap() {
    const [dbInitialized, setDbInitialized] = useState(false);
    const [positionArray, setPositionArray] = useState(null);
    const [attributeTable, setAttributeTable] = useState(null);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [visiblePointCount, setVisiblePointCount] = useState(0);
    const [dates, setDates] = useState([]);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isDatesLoading, setIsDatesLoading] = useState(true);
    const mapContainerRef = useRef(null);
    // Removed isPending, startTransition

    const debouncedViewState = useDebounce(viewState, 500);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    const { db } = useDuckDb();

    // Setup DB effect
    useEffect(() => {
        async function setup() {
            try {
                // console.log("Running DB setup...");
                await setupDB();
                console.log("✅ DB setup finished.");
                setDbInitialized(true);
            } catch (e) {
                console.error("❌ DB Setup failed:", e);
            }
        }
        setup();
    }, []);

    // Fetch Dates Effect
    useEffect(() => {
        if (dbInitialized && db) {
            setIsDatesLoading(true);
            // console.log("⏳ Fetching dates...");
            const fetchDates = async () => {
                let conn = null;
                try {
                    conn = await db.connect(); const result = await conn.query(DATES_QUERY);
                    if (result && result.numRows > 0) {
                        const datesVector = result.getChildAt(0); const arrowDatesListValue = datesVector?.get(0);
                        const rawTimestampArray = arrowDatesListValue?.toArray ? arrowDatesListValue.toArray() : [];
                        const formattedDateStrings = Array.from(rawTimestampArray).map(timestampBigInt => {
                            try {
                                if (typeof timestampBigInt !== 'bigint') { throw new Error(`Expected BigInt`); }
                                const milliseconds = Number(timestampBigInt / 1000n); const dateObj = new Date(milliseconds);
                                if (isNaN(dateObj)) { throw new Error("Invalid Date"); } return dateObj.toISOString().split('T')[0];
                            } catch (e) { console.warn(`⚠️ Error parsing date value: ${timestampBigInt}`, e.message); return "Invalid Date"; }});
                        setDates(formattedDateStrings); console.log(`✅ Dates fetched: ${formattedDateStrings.length} dates found.`);
                    } else { console.log("🗓️ No dates found."); setDates([]); }
                } catch (error) { console.error("❌ Error fetching dates:", error); setDates([]);
                } finally { if (conn) { await conn.close(); } setIsDatesLoading(false); }};
            fetchDates();
        }
    }, [dbInitialized, db]);

    // Generate dynamic query for points
    const currentQuery = useMemo(() => {
        if (!dbInitialized || !mapContainerRef.current || dates.length === 0) return null;
        const { clientWidth, clientHeight } = mapContainerRef.current; if (!clientWidth || !clientHeight) return null;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds(); if ([minLon, minLat, maxLon, maxLat].some(isNaN)) { return null; }
        // console.log(`🗺️ Querying bounds for index: ${debouncedTimeIndex}`); // Cleaned
        const dbIndex = debouncedTimeIndex + 1;
        return ` LOAD httpfs; LOAD spatial; SELECT ST_X(geometry) AS x, ST_Y(geometry) AS y, displacements[${dbIndex}] AS displacement FROM read_parquet('data_subset.geoparquet') WHERE geometry IS NOT NULL AND ST_Intersects( geometry, ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat}) ) AND displacement IS NOT NULL; `;
    }, [dbInitialized, debouncedViewState, debouncedTimeIndex, dates]);

    // Fetch point data
    const { arrow: data, loading: pointsLoading } = useDuckDbQuery(currentQuery);

    // Process Arrow Table -> Flat Float64Array
    useEffect(() => {
        // Only update state if new, valid data arrives
        if (data && data.numRows > 0) {
            // console.log(`➡️ Arrow table loaded/updated, numRows: ${data.numRows}`);
            const xVector = data.getChild('x');
            const yVector = data.getChild('y');
            if (!xVector || !yVector) {
                console.error("❌ Could not find 'x' or 'y' columns.");
                // Avoid clearing state here to prevent flicker
                return;
            }

            // console.log("⏳ Creating flat position array...");
            const N = data.numRows;
            const positions = new Float64Array(N * 2);
            for (let i = 0; i < N; i++) {
                positions[i * 2] = xVector.get(i);
                positions[i * 2 + 1] = yVector.get(i);
            }

            // Set state only when processing is complete
            setPositionArray(positions);
            setAttributeTable(data);
            setVisiblePointCount(data.numRows);
            // console.log(`✅ Flat position array created (length ${positions.length}).`);

        } else if (data && data.numRows === 0) {
            // Only clear state if the query explicitly returned 0 rows
            // console.log("📊 Data loaded, 0 rows returned.");
            setVisiblePointCount(0);
            setPositionArray(null);
            setAttributeTable(null);
        }
        // If data is null (loading), do nothing, keep old state visible
    }, [data]); // Only depends on data

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
        getRadius: 10,
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
    // Simplified loading state
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

    // Render component
    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            {/* Slider UI - Simplified disabled state */}
            <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', width: '80%', maxWidth: '800px', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>
                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <button onClick={() => setTimeIndex(timeIndex - 1)} disabled={isLoading || timeIndex === 0}>Back</button>
                    <div style={{textAlign: 'center', flexGrow: 1}}>
                        <label style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Date: {isLoading ? 'Loading...' : (dates[timeIndex] || '...')}
                        </label>
                        <input type="range" min={0} max={dates.length > 0 ? dates.length - 1 : 0} step={1} value={timeIndex} onChange={e => setTimeIndex(Number(e.target.value))} style={{width: '100%'}} disabled={isLoading || dates.length === 0} />
                    </div>
                    <button onClick={() => setTimeIndex(timeIndex + 1)} disabled={isLoading || timeIndex >= dates.length - 1}>Next</button>
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

            {/* Loading Indicator - Simplified */}
            {(isLoading) && (
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', color: 'white', background: 'rgba(0,0,0,0.7)', padding: '20px', borderRadius: '8px', zIndex: 1000 }}>
                    {pointsLoading ? '⏳ Querying data...' : '⏳ Initializing...'}
                </div>
            )}

            {/* Point Count Display */}
            <div style={{ position: 'absolute', top: '10px', left: '10px', color: 'white', background: 'rgba(0,0,0,0.7)', padding: '5px 10px', borderRadius: '4px', zIndex: 1000, fontFamily: 'sans-serif' }}>
                📍 Visible Points: {visiblePointCount}
            </div>
        </div>
    );
}

export default MinimalWasmMap;

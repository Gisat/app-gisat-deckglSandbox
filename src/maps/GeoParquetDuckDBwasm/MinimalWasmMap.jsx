// src/maps/MinimalWasmMap.jsx
import React, { useEffect, useState, useRef, useMemo } from 'react';
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
    const [points, setPoints] = useState(null);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [visiblePointCount, setVisiblePointCount] = useState(0);
    const [dates, setDates] = useState([]);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isDatesLoading, setIsDatesLoading] = useState(true);
    const mapContainerRef = useRef(null);

    const debouncedViewState = useDebounce(viewState, 500);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    const { db } = useDuckDb();

    // Setup DB effect
    useEffect(() => {
        async function setup() {
            try {
                console.log("Running DB setup...");
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
            console.log("⏳ Fetching dates...");

            const fetchDates = async () => {
                let conn = null;
                try {
                    conn = await db.connect();
                    const result = await conn.query(DATES_QUERY);

                    if (result && result.numRows > 0) {
                        const datesVector = result.getChildAt(0);
                        const arrowDatesListValue = datesVector?.get(0); // This is a Vector containing Timestamps (as BigInt)

                        // Convert the Arrow Vector containing BigInt timestamps to a JS array (BigInt64Array)
                        const rawTimestampArray = arrowDatesListValue?.toArray ? arrowDatesListValue.toArray() : [];
                        console.log("Raw timestamp array type:", Object.prototype.toString.call(rawTimestampArray)); // Log the type

                        // --- THIS IS THE FIX ---
                        // Directly map over the BigInt array
                        const formattedDateStrings = Array.from(rawTimestampArray).map(timestampBigInt => {
                            try {
                                // Ensure it's actually a BigInt before division
                                if (typeof timestampBigInt !== 'bigint') {
                                    throw new Error(`Expected BigInt, got ${typeof timestampBigInt}: ${timestampBigInt}`);
                                }
                                // Assuming microseconds since epoch
                                const milliseconds = Number(timestampBigInt / 1000n);
                                const dateObj = new Date(milliseconds);

                                if (isNaN(dateObj)) {
                                    throw new Error("Invalid Date created from timestamp");
                                }
                                return dateObj.toISOString().split('T')[0]; // Format as YYYY-MM-DD
                            } catch (e) {
                                console.warn(`⚠️ Error parsing date value: ${timestampBigInt}`, e.message);
                                return "Invalid Date";
                            }
                        });
                        // --- END FIX ---

                        setDates(formattedDateStrings); // Store the formatted strings
                        console.log(`✅ Dates fetched: ${formattedDateStrings.length} dates found.`);
                        // console.log("First few formatted dates:", formattedDateStrings.slice(0, 3));

                    } else {
                        console.log("🗓️ No dates found in query result.");
                        setDates([]);
                    }
                } catch (error) {
                    console.error("❌ Error fetching dates:", error);
                    setDates([]);
                } finally {
                    if (conn) {
                        await conn.close();
                    }
                    setIsDatesLoading(false);
                }
            };
            fetchDates();
        }
    }, [dbInitialized, db]);

    // Generate dynamic query for points
    const currentQuery = useMemo(() => {
        if (!dbInitialized || !mapContainerRef.current || dates.length === 0) return null;

        const { clientWidth, clientHeight } = mapContainerRef.current;
        if (!clientWidth || !clientHeight) return null;

        const viewport = new WebMercatorViewport({
            ...debouncedViewState,
            width: clientWidth,
            height: clientHeight
        });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        if ([minLon, minLat, maxLon, maxLat].some(isNaN)) {
            return null;
        }

        console.log(`🗺️ Querying bounds: [${minLon.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLon.toFixed(4)}, ${maxLat.toFixed(4)}] Index: ${debouncedTimeIndex}`);
        const dbIndex = debouncedTimeIndex + 1;

        return `
          LOAD httpfs;
          LOAD spatial;
          SELECT
            [ST_X(geometry), ST_Y(geometry)] AS position,
            displacements[${dbIndex}] AS displacement
          FROM read_parquet('data_subset.geoparquet')
          WHERE geometry IS NOT NULL
          AND ST_Intersects(
                geometry,
                ST_MakeEnvelope(${minLon}, ${minLat}, ${maxLon}, ${maxLat})
              )
          AND displacement IS NOT NULL;
        `;
    }, [dbInitialized, debouncedViewState, debouncedTimeIndex, dates]);

    // Fetch point data
    const { arrow: data, loading: pointsLoading } = useDuckDbQuery(currentQuery);

    // Process point data
    useEffect(() => {
        if (data && data.numRows > 0) {
            console.log(`➡️ Arrow table loaded, numRows: ${data.numRows}`);
            const arrowArray = data.toArray();
            const jsArray = arrowArray.map(row => ({
                position: Array.from(row.position.toArray()),
                displacement: row.displacement
            }));
            setPoints(jsArray);
            setVisiblePointCount(jsArray.length);
        } else if (data) {
            console.log("📊 Data loaded, but 0 rows returned (or all filtered).");
            setPoints(null);
            setVisiblePointCount(0);
        }
    }, [data]);

    // Define Layers
    const baseMapLayer = new TileLayer({
        id: 'tile-layer', data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
        minZoom: 0, maxZoom: 19, tileSize: 256,
        renderSubLayers: props => {
            const { west, south, east, north } = props.tile.bbox;
            return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
        }
    });

    const pointsLayer = points && new ScatterplotLayer({
        id: 'scatterplot-layer',
        data: points,
        getPosition: d => d.position,
        // getRadius: 8,
        radiusUnits: 'pixels',
        getFillColor: d => {
            const rgb = colorScale(d.displacement);
            return [rgb[0], rgb[1], rgb[2], 180];
        },
        pickable: true,
    });

    const layers = [baseMapLayer, pointsLayer].filter(Boolean);
    const isLoading = !dbInitialized || isDatesLoading || pointsLoading;

    // --- Tooltip Function --- FIX IS HERE ---
    const getTooltipContent = ({ object }) => {
        if (!object) {
            return null;
        }
        const currentDate = dates[timeIndex] || 'N/A'; // Get current date string
        return `Date: ${currentDate}\nDisplacement: ${object.displacement?.toFixed(2)}`;
    };
    // --- End Tooltip Function ---

    // Render component
    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            {/* --- Slider UI --- FIX IS HERE --- */}
            <div style={{
                position: 'absolute',
                bottom: 20,
                left: '50%', // Center horizontally
                transform: 'translateX(-50%)', // Adjust position to true center
                width: '80%', // Keep width
                maxWidth: '800px', // Optional: Add max-width for very wide screens
                zIndex: 1,
                background: 'white',
                padding: '10px',
                fontFamily: 'sans-serif',
                borderRadius: '5px',
                boxShadow: '0 0 10px rgba(0,0,0,0.2)'
            }}>
                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <button onClick={() => setTimeIndex(timeIndex - 1)} disabled={isLoading || timeIndex === 0}>Back</button>
                    <div style={{textAlign: 'center', flexGrow: 1}}>
                        {/* Ensure label text doesn't overflow */}
                        <label style={{ display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            Date: {isLoading ? 'Loading...' : (dates[timeIndex] || '...')}
                        </label>
                        <input type="range" min={0} max={dates.length > 0 ? dates.length - 1 : 0} step={1} value={timeIndex} onChange={e => setTimeIndex(Number(e.target.value))} style={{width: '100%'}} disabled={isLoading || dates.length === 0} />
                    </div>
                    <button onClick={() => setTimeIndex(timeIndex + 1)} disabled={isLoading || timeIndex >= dates.length - 1}>Next</button>
                </div>
            </div>
            {/* --- End Slider UI --- */}

            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState: newViewState }) => setViewState(newViewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
                getTooltip={getTooltipContent} // Use the updated tooltip function
            />

            {/* Loading Indicator */}
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

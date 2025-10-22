// src/maps/MinimalWasmMap.jsx
import React, { useEffect, useState, useRef } from 'react'; // 1. Import useRef
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { useDuckDbQuery } from 'duckdb-wasm-kit';
import { setupDB } from './db';

const INITIAL_VIEW_STATE = {
    longitude: 13.96344,
    latitude: 49.954055, zoom: 12, pitch: 0, bearing: 0 };

const DATA_QUERY = `
  LOAD httpfs;
  LOAD spatial;
  SELECT 
    [ST_X(geometry), ST_Y(geometry)] AS position
  FROM read_parquet('data_subset.geoparquet');
`;

function MinimalWasmMap() {
    const [dbInitialized, setDbInitialized] = useState(false);
    const [points, setPoints] = useState(null);

    // 2. Use useRef for a mutable flag that persists across renders
    const hasLoggedAccessor = useRef(false);

    useEffect(() => {
        async function setup() {
            try {
                console.log("Running DB setup...");
                await setupDB();
                console.log("DB setup finished.");
                setDbInitialized(true);
            } catch (e) {
                console.error("DB Setup failed:", e);
            }
        }
        setup();
    }, []);

    const { arrow: data, loading } = useDuckDbQuery(
        dbInitialized ? DATA_QUERY : null
    );

    useEffect(() => {
        if (data && data.numRows > 0) {
            console.log("Arrow table loaded, numRows:", data.numRows);
            console.log("Converting to JavaScript array...");

            const arrowArray = data.toArray();

            // 3. --- THIS IS THE FIX ---
            // Be explicit: convert the Float64Array to a plain JS array.
            const jsArray = arrowArray.map(row => {
                // row.position.toArray() gives a Float64Array
                // Array.from(...) converts it to a plain [number, number] array
                return { position: Array.from(row.position.toArray()) };
            });
            // --- END FIX ---

            setPoints(jsArray);
            console.log("Data for ScatterplotLayer (first 5):", jsArray.slice(0, 5));
        }
    }, [data]);

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

        getPosition: d => {
            // 4. Check and set the ref's 'current' property
            if (!hasLoggedAccessor.current) {
                console.log("Accessor (getPosition) called. First data point (d):", d);
                console.log("Accessor returning position:", d.position);
                hasLoggedAccessor.current = true; // This will stick
            }
            return d.position;
        },

        getRadius: 10,
        radiusUnits: 'pixels', // Keep this!
        getFillColor: [255, 0, 0, 180], // Red
    });

    const layers = [baseMapLayer, pointsLayer].filter(Boolean);

    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
            />

            {(loading || !dbInitialized) && (
                <div style={{
                    position: 'absolute', top: '50%', left: '50%',
                    transform: 'translate(-50%, -50%)',
                    color: 'white', background: 'rgba(0,0,0,0.7)',
                    padding: '20px', borderRadius: '8px', zIndex: 1000
                }}>
                    {loading ? 'Querying data...' : 'Initializing database...'}
                </div>
            )}
        </div>
    );
}

export default MinimalWasmMap;

// src/maps/SimpleMap.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
// --- 1. UPDATE THIS IMPORT ---
import { scaleLinear } from 'd3-scale';

// A custom hook to delay updates
function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => { setDebouncedValue(value); }, delay);
        return () => { clearTimeout(handler); };
    }, [value, delay]);
    return debouncedValue;
}

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 13, pitch: 0, bearing: 0 };
const BACKEND_API_URL = 'http://localhost:5000/api/data';

// --- 2. UPDATE THE COLOR SCALE DEFINITION ---
// Use scaleLinear to map an input domain to an output range of color arrays
const colorScale = scaleLinear()
    .domain([-1.5, 0, 1.5]) // Input data values (e.g., slow, medium, fast velocity)
    .range([ // Output colors in [R, G, B] format
        [65, 182, 196],  // Blue for negative values
        [254, 224, 144], // Yellow for zero
        [224, 49, 49]    // Red for positive values
    ]).clamp(true);

function SimpleMap() {
    const [data, setData] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [velocityFilter, setVelocityFilter] = useState(5.0);

    const debouncedViewState = useDebounce(viewState, 300);
    const debouncedVelocity = useDebounce(velocityFilter, 300);

    // Data Loading Effect
    useEffect(() => {
        const viewport = new WebMercatorViewport(debouncedViewState);
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${BACKEND_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}&max_velocity=${debouncedVelocity}`;

        fetch(backendQueryUrl)
            .then(response => response.json())
            .then(setData)
            .catch(error => console.error("Backend Load Error:", error));

    }, [debouncedViewState, debouncedVelocity]);

    const layers = [
        new TileLayer({
            id: 'tile-layer',
            // --- NEW URL for a light greyscale map ---
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',

            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        }),
        new ScatterplotLayer({
            id: 'scatterplot-layer',
            data,
            getPosition: d => [d.longitude, d.latitude],
            // --- 3. UPDATE THE GETFILLCOLOR ACCESSOR ---
            // The output of colorScale is now [R, G, B], so we add alpha (180)
            getFillColor: d => {
                const rgb = colorScale(d.mean_velocity);
                return [rgb[0], rgb[1], rgb[2], 220];
            },
            getRadius: 5,
            pickable: true,
        })
    ];

    return (
        <div>
            <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif' }}>
                <label>Max Velocity (abs): {velocityFilter} mm/yr</label>
                <input
                    type="range"
                    min={0}
                    max={5.0}
                    step={0.01}
                    value={velocityFilter}
                    onChange={e => setVelocityFilter(Number(e.target.value))}
                    style={{width: '200px'}}
                />
            </div>

            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
            />
        </div>
    );
}

export default SimpleMap;

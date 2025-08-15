// src/maps/SimpleMap.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';

// --- Debounce Hook ---
// A custom hook to delay updates
function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);
        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);
    return debouncedValue;
}

// --- Configuration ---
const INITIAL_VIEW_STATE = {
    longitude: 14.44,
    latitude: 50.05,
    zoom: 13,
    pitch: 0,
    bearing: 0,
};
const BACKEND_API_URL = 'http://localhost:5000/api/data';

function SimpleMap() {
    const [data, setData] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

    // --- USE THE DEBOUNCE HOOK ---
    // This debouncedViewState will only update 300ms after the user stops moving the map
    const debouncedViewState = useDebounce(viewState, 300);

    // --- Data Loading Effect ---
    useEffect(() => {
        // This effect now runs only when debouncedViewState changes
        const viewport = new WebMercatorViewport(debouncedViewState);
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${BACKEND_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}`;

        fetch(backendQueryUrl)
            .then(response => response.json())
            .then(jsonData => {
                setData(jsonData);
                console.log(`Loaded ${jsonData.length} points.`);
            })
            .catch(error => console.error("Backend Load Error:", error));

    }, [debouncedViewState]); // <-- CRUCIAL: Dependency is now the debounced state

    // --- Layer Creation ---
    const layers = [
        new TileLayer({ /* ... unchanged ... */
            id: 'tile-layer', data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null, image: props.data, bounds: [west, south, east, north]
                });
            }
        }),
        new ScatterplotLayer({
            id: 'scatterplot-layer', data: data,
            getPosition: d => [d.longitude, d.latitude],
            getFillColor: [255, 0, 0, 180],
            getRadius: 5,
            pickable: true,
        })
    ];

    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layers}
        />
    );
}

export default SimpleMap;

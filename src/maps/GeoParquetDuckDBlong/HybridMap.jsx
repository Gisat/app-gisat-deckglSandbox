// src/maps/HybridMap.jsx
import React, { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
// --- CORRECT IMPORT ---
import { scaleLinear } from 'd3-scale';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 13, pitch: 0, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/hybrid-data';

// --- CORRECT COLOR SCALE ---
// Use scaleLinear to map an input domain to an output range of color arrays
const colorScale = scaleLinear()
    .domain([-20, 0, 20]) // A good domain for displacement in mm
    .range([
        [65, 182, 196],  // Blue for negative
        [254, 254, 191], // Yellow/White for zero
        [215, 25, 28]    // Red for positive
    ])
    .clamp(true);

function HybridMap() {
    const [data, setData] = useState([]);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const dataCache = useRef({});

    // Effect 1: Fetch the list of dates once on startup
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(response => response.json())
            .then(setDates)
            .catch(error => console.error("Error fetching dates:", error));
    }, []);

    // Effect 2: Fetch map data when view or time changes
    useEffect(() => {
        if (dates.length === 0) return;
        const viewport = new WebMercatorViewport(viewState);
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${DATA_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}&date_index=${timeIndex}`;

        if (dataCache.current[backendQueryUrl]) {
            setData(dataCache.current[backendQueryUrl]);
            return;
        }

        fetch(backendQueryUrl)
            .then(response => response.json())
            .then(jsonData => {
                if (jsonData) {
                    dataCache.current[backendQueryUrl] = jsonData;
                    setData(jsonData);
                }
            })
            .catch(error => console.error("Backend Load Error:", error));

    }, [viewState, timeIndex, dates]);

    const layers = [
        new TileLayer({
            id: 'tile-layer', data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new ScatterplotLayer({
            id: 'scatterplot-layer',
            data,
            getPosition: d => [d.longitude, d.latitude],
            // --- CORRECT getFillColor ACCESSOR ---
            // The output of colorScale is [R, G, B], so we add the alpha value
            getFillColor: d => {
                const rgb = colorScale(d.displacement);
                if (!rgb) return [0, 0, 0, 0];
                return [rgb[0], rgb[1], rgb[2], 180];
            },
            getRadius: 5,
            pickable: true,
        })
    ];

    return (
        <div>
            <div style={{ position: 'absolute', bottom: 20, left: '10%', width: '80%', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>
                <label>Date: {dates[timeIndex] || 'Loading dates...'}</label>
                <input
                    type="range"
                    min={0}
                    max={dates.length > 0 ? dates.length - 1 : 0}
                    step={1}
                    value={timeIndex}
                    onChange={e => setTimeIndex(Number(e.target.value))}
                    style={{width: '100%'}}
                    disabled={dates.length === 0}
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

export default HybridMap;

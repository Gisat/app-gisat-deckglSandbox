// src/maps/HybridMap3D.jsx
import React, { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { SphereGeometry } from '@luma.gl/engine';

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
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/3d-data';
const colorScale = scaleLinear().domain([-20, 0, 20]).range([[65, 182, 196], [254, 254, 191], [215, 25, 28]]).clamp(true);
const sizeScale = scaleLinear().domain([0, 5]).range([1, 10]).clamp(true);
const sphere = new SphereGeometry({ radius: 1, nlat: 10, nlong: 10 });

// --- NEW: Caching Strategy ---
// Set to `true` to use a rounded, "fuzzy" key. This is better for performance
// as it allows similar map views to share a cache entry.
// Set to `false` to use the exact, "precise" bounding box. You will notice
// very few cache hits with this method.
const USE_FUZZY_CACHE = true;

function HybridMap3D() {
    const [data, setData] = useState([]);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const dataCache = useRef({});
    const mapContainerRef = useRef(null);

    const debouncedViewState = useDebounce(viewState, 300);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    // Effect to fetch dates
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(dateList => { setDates(dateList); setIsLoading(false); })
            .catch(error => console.error("Error fetching dates:", error));
    }, []);

    // Effect to fetch map data
    useEffect(() => {
        if (dates.length === 0 || !mapContainerRef.current) return;

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${DATA_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}&date_index=${debouncedTimeIndex}`;

        // --- NEW: Logic to generate cache key based on the constant ---
        let cacheKey;
        if (USE_FUZZY_CACHE) {
            const roundedZoom = Math.round(debouncedViewState.zoom * 10) / 10;
            const roundedLat = debouncedViewState.latitude.toFixed(3);
            const roundedLon = debouncedViewState.longitude.toFixed(3);
            cacheKey = `${roundedZoom}-${roundedLat}-${roundedLon}-${debouncedTimeIndex}`;
        } else {
            cacheKey = backendQueryUrl;
        }

        if (dataCache.current[cacheKey]) {
            console.log(`Loading from ${USE_FUZZY_CACHE ? 'fuzzy' : 'precise'} cache...`);
            setData(dataCache.current[cacheKey]);
            return;
        }

        setIsLoading(true);
        console.log("Fetching from backend...");
        fetch(backendQueryUrl)
            .then(response => response.json())
            .then(jsonData => {
                dataCache.current[cacheKey] = jsonData;
                setData(jsonData);
            })
            .catch(error => console.error("Backend Load Error:", error))
            .finally(() => setIsLoading(false));

    }, [debouncedViewState, debouncedTimeIndex, dates]);

    const layers = [
        new TileLayer({
            id: 'tile-layer', data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            depthTest: false,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new SimpleMeshLayer({
            id: 'mesh-layer',
            data,
            mesh: sphere,
            getPosition: d => [d.longitude, d.latitude, d.height],
            getColor: d => {
                const rgb = colorScale(d.displacement);
                return [rgb[0], rgb[1], rgb[2], 200];
            },
            getScale: d => {
                const size = sizeScale(Math.abs(d.mean_velocity));
                return [size, size, size];
            },
            pickable: true,
        })
    ];

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <div style={{ position: 'absolute', bottom: 20, left: '10%', width: '80%', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>
                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <button onClick={() => setTimeIndex(timeIndex - 1)} disabled={isLoading || timeIndex === 0}>Back</button>
                    <div style={{textAlign: 'center', flexGrow: 1}}>
                        <label>Date: {isLoading ? 'Loading...' : (dates[timeIndex] || '...')}</label>
                        <input
                            type="range"
                            min={0}
                            max={dates.length > 0 ? dates.length - 1 : 0}
                            step={1}
                            value={timeIndex}
                            onChange={e => setTimeIndex(Number(e.target.value))}
                            style={{width: '100%'}}
                            disabled={isLoading || dates.length === 0}
                        />
                    </div>
                    <button onClick={() => setTimeIndex(timeIndex + 1)} disabled={isLoading || timeIndex >= dates.length - 1}>Next</button>
                </div>
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

export default HybridMap3D;

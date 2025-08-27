import React, { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer } from '@deck.gl/layers';
import { BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

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
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/hybrid-data';
const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);
const USE_FUZZY_CACHE = true;

function HybridMap() {
    const [data, setData] = useState([]);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const dataCache = useRef({});
    const mapContainerRef = useRef(null);

    const debouncedViewState = useDebounce(viewState, 300);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    // Effect 1: Fetch the list of dates once on startup
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(d => { setDates(d); setIsLoading(false); });
    }, []);

    // Effect 2: Fetch map data using debounced values and fuzzy caching
    useEffect(() => {
        if (dates.length === 0 || !mapContainerRef.current || mapContainerRef.current.clientWidth === 0) {
            return;
        }

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        // --- FUZZY CACHING LOGIC ---
        // This logic creates a simplified key to represent the current view.
        // Instead of using the exact, high-precision bounding box for the cache key,
        // we round the view parameters. This means small pans or zooms will
        // resolve to the same key, allowing us to reuse cached data and avoid
        // unnecessary backend requests.
        let cacheKey;
        if (USE_FUZZY_CACHE) {
            const roundedZoom = Math.round(debouncedViewState.zoom);
            const roundedLat = debouncedViewState.latitude.toFixed(2);
            const roundedLon = debouncedViewState.longitude.toFixed(2);
            cacheKey = `${roundedZoom}-${roundedLat}-${roundedLon}-${debouncedTimeIndex}`;
        } else {
            // For comparison, the precise key uses exact, unrounded values.
            const {zoom, latitude, longitude} = debouncedViewState;
            cacheKey = `${zoom}-${latitude}-${longitude}-${debouncedTimeIndex}`;
        }

        if (dataCache.current[cacheKey]) {
            setData(dataCache.current[cacheKey]);
            return;
        }

        setIsLoading(true);
        const backendQueryUrl = `${DATA_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}&date_index=${debouncedTimeIndex}&zoom=${debouncedViewState.zoom}`;

        load(backendQueryUrl, ArrowLoader, { arrow: { shape: 'object-row-table' } })
            .then(loadedData => {
                dataCache.current[cacheKey] = loadedData;
                setData(loadedData);
            })
            .catch(error => console.error("Backend Load Error:", error))
            .finally(() => setIsLoading(false));

    }, [debouncedViewState, debouncedTimeIndex, dates]);

    const layers = [
        new TileLayer({
            id: 'tile-layer',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new ScatterplotLayer({
            id: 'data-layer',
            data,
            getPosition: d => [d.longitude, d.latitude],
            getFillColor: d => {
                const rgb = colorScale(d.displacement);
                return [rgb[0], rgb[1], rgb[2], 180];
            },
            getRadius: 5,
            pickable: true,
        })
    ];

    // --- JSX STRUCTURE ---
    // This layout is now identical to the 3D map.
    // The main <div> is given a specific size and relative positioning,
    // and the <DeckGL> component automatically fills it.
    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '80vw', height: '100vh' }}>
            <div style={{ position: 'absolute', bottom: 20, left: '10%', width: '80%', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>
                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <button
                        onClick={() => setTimeIndex(timeIndex - 1)}
                        disabled={isLoading || timeIndex === 0}
                    >
                        Back
                    </button>
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
                    <button
                        onClick={() => setTimeIndex(timeIndex + 1)}
                        disabled={isLoading || timeIndex >= dates.length - 1}
                    >
                        Next
                    </button>
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

export default HybridMap;

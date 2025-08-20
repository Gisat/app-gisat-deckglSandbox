// src/maps/HybridMap.jsx
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

function HybridMap() {
    const [data, setData] = useState([]);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const dataCache = useRef({});

    const debouncedViewState = useDebounce(viewState, 300);
    const debouncedTimeIndex = useDebounce(timeIndex, 200);

    // Effect 1: Fetch the list of dates once on startup
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(d => { setDates(d); setIsLoading(false); });
    }, []);

    // Effect 2: Fetch map data using debounced values and caching
    useEffect(() => {
        if (dates.length === 0) return;

        const viewport = new WebMercatorViewport(debouncedViewState);
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${DATA_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}&date_index=${debouncedTimeIndex}&zoom=${debouncedViewState.zoom}`;

        if (dataCache.current[backendQueryUrl]) {
            setData(dataCache.current[backendQueryUrl]);
            return;
        }

        setIsLoading(true);
        load(backendQueryUrl, ArrowLoader, { arrow: { shape: 'object-row-table' } })
            .then(loadedData => {
                dataCache.current[backendQueryUrl] = loadedData;
                setData(loadedData);
            })
            .catch(error => console.error("Backend Load Error:", error))
            .finally(() => setIsLoading(false));

    }, [debouncedViewState, debouncedTimeIndex, dates]);

    const isAggregated = data && data.length > 0 && data[0].value !== undefined;

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
                const value = isAggregated ? d.value : d.displacement;
                const rgb = colorScale(value);
                if (!rgb) return [0, 0, 0, 0];
                return [rgb[0], rgb[1], rgb[2], 180];
            },
            getRadius: isAggregated ? 400 : 5,
            pickable: true,
            transitions: {
                getFillColor: 100
            }
        })
    ];

    return (
        <div>
            <div style={{ position: 'absolute', bottom: 20, left: '10%', width: '80%', zIndex: 1, background: 'white', padding: '10px', fontFamily: 'sans-serif', borderRadius: '5px', boxShadow: '0 0 10px rgba(0,0,0,0.2)' }}>

                {/* Notice there is NO separate {isLoading && ...} div here */}
                <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
                    <button
                        onClick={() => setTimeIndex(timeIndex - 1)}
                        disabled={isLoading || timeIndex === 0}
                    >
                        Back
                    </button>

                    <div style={{textAlign: 'center', flexGrow: 1}}>
                        {/* The loading text is handled directly inside the label */}
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
                        disabled={isLoading || timeIndex === dates.length - 1}
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

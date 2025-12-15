import { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

import { HUD } from './components/HUD';
import { PlaybackControls } from './components/PlaybackControls';
import DuckDBGeoParquetLayer from '../../../layers/DuckDBGeoParquetLayer';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/hybrid-data';

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const TILE_CACHE_LIMIT = 200;

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

// 🆕 LOD LOGIC
function getTargetTier(zoom) {
    if (zoom >= 15) return 2; // Full Detail (100%)
    if (zoom >= 13) return 1; // Mid Detail (35%)
    return 0;                 // Overview (5%) - Global Fetch
}

// 🆕 Point Size Logic
function getPointSize(zoom) {
    if (zoom < 13) return 2;  // Tier 0 (Overview)
    if (zoom < 15) return 3;  // Tier 1 (Mid)
    return 5;                 // Tier 2 (Detail)
}

function Map2D() {
    const [totalPoints, setTotalPoints] = useState(0);
    const [cacheSize, setCacheSize] = useState(0);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchStatus, setFetchStatus] = useState("Idle");

    // Debug state to show current tier in HUD
    const [currentTierDisplay, setCurrentTierDisplay] = useState(() => {
        const t = getTargetTier(INITIAL_VIEW_STATE.zoom);
        const percentages = ['5%', '35%', '100%'];
        return `${t} (${percentages[t]})`;
    });

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);

    const mapContainerRef = useRef(null);

    // 🆕 HUD Update Logic
    useEffect(() => {
        const targetTier = getTargetTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        setCurrentTierDisplay(`${targetTier} (${percentages[targetTier]})`);
    }, [viewState.zoom]);

    // 1. Fetch Dates
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(d => setDates(d))
            .catch(console.error);
    }, []);

    // 2. Animation Loop
    useEffect(() => {
        let interval;
        if (mode === 'animation' && isPlaying && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex(prev => (prev >= dates.length - 1 ? 0 : prev + 1));
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates, mode]);

    // 🚀 Performance: Debounce fetching in static mode
    const [debouncedTimeIndex, setDebouncedTimeIndex] = useState(0);

    useEffect(() => {
        if (mode === 'animation') {
            setDebouncedTimeIndex(timeIndex);
        } else {
            const handler = setTimeout(() => {
                setDebouncedTimeIndex(timeIndex);
            }, 500);
            return () => clearTimeout(handler);
        }
    }, [timeIndex, mode]);

    // 3. Tile Fetching Logic moved to DuckDBHybridLayer

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new DuckDBGeoParquetLayer({
            id: 'duckdb-geoparquet-layer',
            dataUrl: DATA_API_URL,
            dateIndex: debouncedTimeIndex,
            mode: mode,
            onStatusChange: (status) => {
                setTotalPoints(status.totalPoints);
                setCacheSize(status.cacheSize);
                setIsLoading(status.isLoading);
                setFetchStatus(status.isLoading ? "Fetching..." : "Ready");
            },

            renderSubLayers: (props) => {
                return new ScatterplotLayer({
                    id: 'data-layer',
                    data: props.data,
                    getPosition: d => [d.longitude, d.latitude],
                    getRadius: getPointSize(viewState.zoom),
                    radiusUnits: 'pixels',
                    getFillColor: d => {
                        let val = 0;
                        if (mode === 'animation') {
                            const vec = d.displacements;
                            if (vec) {
                                if (typeof vec.get === 'function') val = vec.get(timeIndex);
                                else if (vec.length > timeIndex) val = vec[timeIndex];
                            } else {
                                val = d.displacement;
                            }
                        } else {
                            val = d.displacement;
                        }
                        const rgb = colorScale(val || 0);
                        return [rgb[0], rgb[1], rgb[2], 200];
                    },
                    updateTriggers: {
                        getFillColor: [timeIndex, mode]
                    },
                    pickable: true
                });
            }
        })
    ];

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                layers={layers}
            />

            <HUD
                viewState={viewState}
                currentTierDisplay={currentTierDisplay}
                totalPoints={totalPoints}
                fetchStatus={fetchStatus}
                isLoading={isLoading}
                cacheSize={cacheSize}
                cacheLimit={TILE_CACHE_LIMIT}
            />

            <PlaybackControls
                date={dates[timeIndex]}
                mode={mode}
                isPlaying={isPlaying}
                isLoading={isLoading}
                timeIndex={timeIndex}
                totalDates={dates.length}
                setMode={setMode}
                setIsPlaying={setIsPlaying}
                setTimeIndex={setTimeIndex}
            />
        </div>
    );
}

export default Map2D;

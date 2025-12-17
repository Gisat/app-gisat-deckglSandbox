import React, { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers'; // 3D Layer
import { BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { SphereGeometry } from '@luma.gl/engine'; // Geometries
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

// Import local components
import { HUD } from './components/HUD';
import { PlaybackControls } from './components/PlaybackControls';
import DuckDBGeoParquetLayer from '../../../layers/DuckDBGeoParquetLayer';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0 };
const DATES_API_URL = 'http://localhost:5001/api/dates';
const DATA_API_URL = 'http://localhost:5001/api/3d-data';

const TILE_CACHE_LIMIT = 200;

const sphere = new SphereGeometry({ radius: 1, nlat: 6, nlong: 6 });

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
    .clamp(true);

const sizeScale = scaleLinear().domain([0, 5]).range([1, 10]).clamp(true);

// 🆕 LOD LOGIC
function getTargetTier(zoom) {
    if (zoom >= 15) return 2;
    if (zoom >= 13) return 1;
    return 0;
}

// Map3D Component
function Map3D() {
    const [totalPoints, setTotalPoints] = useState(0);
    const [cacheSize, setCacheSize] = useState(0);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchStatus, setFetchStatus] = useState("Idle");

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

    // 🚀 Performance: Debounce fetching in static mode to avoid requests while sliding
    const [debouncedTimeIndex, setDebouncedTimeIndex] = useState(0);

    useEffect(() => {
        if (mode === 'animation') {
            setDebouncedTimeIndex(timeIndex);
        } else {
            const handler = setTimeout(() => {
                setDebouncedTimeIndex(timeIndex);
            }, 500); // 500ms debounce for slider
            return () => clearTimeout(handler);
        }
    }, [timeIndex, mode]);

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

    // 3. Tile Fetching Logic moved to DuckDBHybridLayer

    const layers = useMemo(() => [
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
                return new SimpleMeshLayer({
                    id: 'mesh-layer',
                    data: props.data,
                    mesh: sphere,
                    getPosition: d => {
                        let val = 0;
                        // Always try to use cached vector data if available (Smart Caching)
                        const cum = d.cumulative_displacements;
                        if (cum) {
                            const idx = Math.min(timeIndex, cum.length - 1);
                            val = cum[idx];
                        } else {
                            val = d.displacement || 0;
                        }
                        return [d.longitude, d.latitude, d.height + (val * 0.2)];
                    },
                    getColor: d => {
                        let val = 0;
                        // Always try to use cached vector data if available (Smart Caching)
                        const vec = d.displacements;
                        if (vec) {
                            const idx = Math.min(timeIndex, vec.length - 1);
                            val = vec[idx];
                        } else {
                            val = d.displacement || 0;
                        }
                        const rgb = colorScale(val || 0);
                        return [rgb[0], rgb[1], rgb[2], 255];
                    },
                    getScale: d => {
                        const size = sizeScale(Math.abs(d.mean_velocity || 1));
                        return [size, size, size];
                    },
                    updateTriggers: {
                        getColor: [timeIndex, mode],
                        getPosition: [timeIndex, mode]
                    },
                    pickable: true,
                });
            }
        })
    ], [debouncedTimeIndex, timeIndex, mode]);

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

export default Map3D;

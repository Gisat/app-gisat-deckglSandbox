import { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';

import { HUD } from './components/HUD';
import { PlaybackControls } from './components/PlaybackControls';
import DuckDBGeoParquetLayer from '../../../layers/DuckDBGeoParquetLayer';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/data';

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const TILE_CACHE_LIMIT = 200;

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
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
            geoparquetPath: '/Users/marianakecova/GST/3DFLUS_CCN/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized_be.geoparquet',
            columnMap: {
                latitude: 'y',
                longitude: 'x',
                color: 'displacements'
            },
            timeSeries: {
                dates: 'dates',
                displacements: 'displacements'
            },
            onStatusChange: (status) => {
                setTotalPoints(status.totalPoints);
                setCacheSize(status.cacheSize);
                setIsLoading(status.isLoading);
                setFetchStatus(status.isLoading ? "Fetching..." : "Ready");
            },

            renderSubLayers: (props) => {
                // Handle Arrow tables directly - avoid JS object conversion
                const arrowTables = Array.isArray(props.data) ? props.data : [props.data];
                const validTables = arrowTables.filter(table => table && table.numRows > 0);

                if (validTables.length === 0) return null;

                return validTables.map((table, tableIndex) => {
                    // Pre-cache column references for performance (avoid repeated getChild calls)
                    const lonColumn = table.getChild('longitude');
                    const latColumn = table.getChild('latitude');
                    const displacementsColumn = table.getChild('displacements'); // animation mode
                    const displacementColumn = table.getChild('displacement');   // static mode

                    // Debug: Try alternative column names if primary ones fail
                    const altLonColumn = !lonColumn ? table.getChild('x') : null;
                    const altLatColumn = !latColumn ? table.getChild('y') : null;

                    return new ScatterplotLayer({
                        id: `arrow-table-${tableIndex}`,
                        data: Array.from({ length: table.numRows }, (_, i) => i),

                        getPosition: (rowIndex) => {
                            const lon = lonColumn ? lonColumn.get(rowIndex) : altLonColumn?.get(rowIndex);
                            const lat = latColumn ? latColumn.get(rowIndex) : altLatColumn?.get(rowIndex);
                            return [lon, lat];
                        },

                        getRadius: getPointSize(viewState.zoom),
                        radiusUnits: 'pixels',

                        getFillColor: (rowIndex) => {
                            let val = 0;

                            if (mode === 'animation') {
                                // Animation mode: prefer displacements array, fallback to displacement single value
                                if (displacementsColumn) {
                                    const displacements = displacementsColumn.get(rowIndex);

                                    if (displacements) {
                                        if (Array.isArray(displacements)) {
                                            val = displacements[debouncedTimeIndex] || 0;
                                        } else if (displacements.get && typeof displacements.get === 'function') {
                                            val = displacements.get(debouncedTimeIndex) || 0;
                                        } else if (displacements.toArray && typeof displacements.toArray === 'function') {
                                            const arr = displacements.toArray();
                                            val = arr[debouncedTimeIndex] || 0;
                                        }
                                    }
                                } else if (displacementColumn) {
                                    // Fallback: use single displacement value (cached static data)
                                    val = displacementColumn.get(rowIndex) || 0;
                                }
                            } else {
                                // Static mode: prefer displacement single value, fallback to displacements array
                                if (displacementColumn) {
                                    val = displacementColumn.get(rowIndex) || 0;
                                } else if (displacementsColumn) {
                                    // Fallback: extract single value from displacements array (cached animation data)
                                    const displacements = displacementsColumn.get(rowIndex);
                                    if (displacements) {
                                        if (Array.isArray(displacements)) {
                                            val = displacements[debouncedTimeIndex] || 0;
                                        } else if (displacements.get && typeof displacements.get === 'function') {
                                            val = displacements.get(debouncedTimeIndex) || 0;
                                        } else if (displacements.toArray && typeof displacements.toArray === 'function') {
                                            const arr = displacements.toArray();
                                            val = arr[debouncedTimeIndex] || 0;
                                        }
                                    }
                                }
                            }

                            const rgb = colorScale(val);
                            return [rgb[0], rgb[1], rgb[2], 200];
                        },

                        updateTriggers: {
                            getFillColor: [debouncedTimeIndex, mode],  // Use consistent time index and mode
                            getPosition: [mode],  // Also trigger position updates on mode change
                        },

                        // Disable transitions for instant updates
                        transitions: {
                            getFillColor: 0
                        },

                        pickable: true
                    });
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

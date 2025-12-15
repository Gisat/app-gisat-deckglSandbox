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

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/3d-data';

const GRID_SIZE = 0.06;
const TILE_BUFFER = 1;
const TILE_CACHE_LIMIT = 200;

const sphere = new SphereGeometry({ radius: 1, nlat: 6, nlong: 6 });

const colorScale = scaleLinear()
    .domain([-20, 0, 20])
    .range([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
    .clamp(true);

const sizeScale = scaleLinear().domain([0, 5]).range([1, 10]).clamp(true);

// 🆕 LOD LOGIC
function getTargetTier(zoom) {
    if (zoom >= 15) return 2;
    if (zoom >= 13) return 1;
    return 0;
}

function HybridMap3D() {
    const [displayData, setDisplayData] = useState([]);
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
    const tileCache = useRef(new Map());
    const pendingRequests = useRef(new Set());
    const previousVisibleKeys = useRef(new Set());

    // --- HELPER: LRU Update ---
    const touchCache = (key) => {
        const val = tileCache.current.get(key);
        if (val) {
            tileCache.current.delete(key);
            tileCache.current.set(key, val);
        }
    };

    // --- HELPER: LRU Evict ---
    const enforceCacheLimit = () => {
        if (tileCache.current.size <= TILE_CACHE_LIMIT) return;
        for (const key of tileCache.current.keys()) {
            if (tileCache.current.size <= TILE_CACHE_LIMIT) break;
            if (key.includes('global_t0')) continue;
            tileCache.current.delete(key);
        }
    };

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

    // 3. Tile Fetching Logic (Hybrid: Global T0 + Tiled T1/T2)
    useEffect(() => {
        if (!mapContainerRef.current || dates.length === 0) return;
        if (mode === 'animation' && isPlaying) return;

        // Use the DEBOUNCED index for fetching static snapshots
        // This prevents fetching every single frame while dragging the slider
        const fetchIndex = debouncedTimeIndex;

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...viewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        const minTx = Math.floor(minLon / GRID_SIZE) - TILE_BUFFER;
        const maxTx = Math.floor(maxLon / GRID_SIZE) + TILE_BUFFER;
        const minTy = Math.floor(minLat / GRID_SIZE) - TILE_BUFFER;
        const maxTy = Math.floor(maxLat / GRID_SIZE) + TILE_BUFFER;

        const targetTier = getTargetTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        setCurrentTierDisplay(`${targetTier} (${percentages[targetTier]})`);

        const neededTiles = [];
        const visibleDataChunks = [];
        const currentVisibleKeys = new Set();

        // TEO 0 Check
        const t0Key = mode === 'static' ? `global_t0_static_${fetchIndex}` : `global_t0_anim`;
        currentVisibleKeys.add(t0Key);

        if (tileCache.current.has(t0Key)) {
            touchCache(t0Key);
            visibleDataChunks.push(tileCache.current.get(t0Key));
        } else {
            if (!pendingRequests.current.has(t0Key)) {
                neededTiles.push({ type: 'global', tier: 0, key: t0Key });
                pendingRequests.current.add(t0Key);
            }
        }

        // TIER 1 & 2 Check
        if (targetTier > 0) {
            for (let x = minTx; x <= maxTx; x++) {
                for (let y = minTy; y <= maxTy; y++) {
                    for (let t = 1; t <= targetTier; t++) {
                        const cacheKey = mode === 'static'
                            ? `${x}_${y}_T${t}_static_${fetchIndex}`
                            : `${x}_${y}_T${t}_anim`;

                        currentVisibleKeys.add(cacheKey);

                        if (tileCache.current.has(cacheKey)) {
                            touchCache(cacheKey);
                            visibleDataChunks.push(tileCache.current.get(cacheKey));
                        } else {
                            if (!pendingRequests.current.has(cacheKey)) {
                                neededTiles.push({ type: 'tile', x, y, tier: t, key: cacheKey });
                                pendingRequests.current.add(cacheKey);
                            }
                        }
                    }
                }
            }
        }

        // 🛑 OPTIMIZATION: Set Comparison
        let isSameSet = true;
        if (currentVisibleKeys.size !== previousVisibleKeys.current.size) {
            isSameSet = false;
        } else {
            for (let key of currentVisibleKeys) {
                if (!previousVisibleKeys.current.has(key)) {
                    isSameSet = false;
                    break;
                }
            }
        }

        if (isSameSet && neededTiles.length === 0) return;
        previousVisibleKeys.current = currentVisibleKeys;

        enforceCacheLimit();

        if (visibleDataChunks.length > 0) {
            setDisplayData(visibleDataChunks.flat());
        }

        if (neededTiles.length === 0) {
            setFetchStatus(`Cached (${visibleDataChunks.length} chunks)`);
            return;
        }

        setIsLoading(true);
        setFetchStatus(`Fetching ${neededTiles.length} new tiles...`);

        Promise.all(neededTiles.map(task => {
            let url = '';

            if (task.type === 'global') {
                const params = new URLSearchParams({
                    date_index: fetchIndex,
                    mode: mode,
                    tier: 0,
                    global: 'true'
                });
                url = `${DATA_API_URL}?${params.toString()}`;
            } else {
                const params = new URLSearchParams({
                    tile_x: task.x,
                    tile_y: task.y,
                    date_index: fetchIndex,
                    mode: mode,
                    tier: task.tier
                });
                url = `${DATA_API_URL}?${params.toString()}`;
            }

            return load(url, ArrowLoader, { arrow: { shape: 'object-row-table' } })
                .then(result => {
                    const dataArr = result.data || result;
                    pendingRequests.current.delete(task.key);

                    if (Array.isArray(dataArr)) {
                        // ⚡ PRE-CALCULATION: Cumulative Sum for Animation
                        // Doing this once on load prevents lag during animation loop
                        for (let i = 0; i < dataArr.length; i++) {
                            const d = dataArr[i];
                            const vec = d.displacements;
                            if (vec) {
                                const len = vec.length || vec.byteLength; // Handle different array types safely
                                if (len > 0) {
                                    const cum = new Float32Array(len);
                                    let sum = 0;

                                    // ⚡ OPTIMIZATION: Normalize Arrow Vectors to TypedArray for O(1) Access
                                    // This removes the need for .get() checks in the high-frequency render loop
                                    // If it's already an array/typed array, we just use it.
                                    // If it's an Arrow vector, we create a fast Float32Array copy.
                                    let fastDisplacements = vec;
                                    const isArrow = typeof vec.get === 'function';

                                    if (isArrow) {
                                        fastDisplacements = new Float32Array(len);
                                        for (let t = 0; t < len; t++) {
                                            const val = vec.get(t);
                                            fastDisplacements[t] = val; // Store optimized copy
                                            sum += val;
                                            cum[t] = sum;
                                        }
                                        // Replace original slow object with fast array
                                        d.displacements = fastDisplacements;
                                    } else {
                                        // Standard array path
                                        for (let t = 0; t < len; t++) {
                                            const val = vec[t];
                                            sum += val;
                                            cum[t] = sum;
                                        }
                                    }
                                    d.cumulative_displacements = cum;
                                }
                            }
                        }

                        tileCache.current.set(task.key, dataArr);
                        if (tileCache.current.size > TILE_CACHE_LIMIT) enforceCacheLimit();
                        return dataArr;
                    }
                    return [];
                })
                .catch(e => {
                    console.error(`Failed ${task.key}`, e);
                    pendingRequests.current.delete(task.key);
                    tileCache.current.set(task.key, []);
                    return [];
                });
        })).then(() => {
            // Re-gather logic
            const allChunks = [];

            if (tileCache.current.has(t0Key)) allChunks.push(tileCache.current.get(t0Key));

            if (targetTier > 0) {
                for (let x = minTx; x <= maxTx; x++) {
                    for (let y = minTy; y <= maxTy; y++) {
                        for (let t = 1; t <= targetTier; t++) {
                            const k = mode === 'static' ? `${x}_${y}_T${t}_static_${fetchIndex}` : `${x}_${y}_T${t}_anim`;
                            if (tileCache.current.has(k)) allChunks.push(tileCache.current.get(k));
                        }
                    }
                }
            }
            setDisplayData(allChunks.flat());
            setIsLoading(false);
            setFetchStatus('Ready');
        });

    }, [viewState, debouncedTimeIndex, dates, mode]);

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
        // 3D SPHERES
        new SimpleMeshLayer({
            id: 'mesh-layer',
            data: displayData,
            mesh: sphere,
            // 🆕 ANIMATED POSITION (Z-Axis)
            getPosition: d => {
                let val = 0;
                if (mode === 'animation') {
                    // 🚀 O(1) LOOKUP: Use pre-calculated cumulative array
                    const cum = d.cumulative_displacements;
                    if (cum) {
                        // Safe index access
                        const idx = Math.min(timeIndex, cum.length - 1);
                        val = cum[idx];
                    } else {
                        // Fallback: This shouldn't happen if data has displacements
                        val = d.displacement || 0;
                    }
                } else {
                    val = d.displacement || 0;
                }

                // EXAGGERATION: Multiply by 0.5 to make movement visible but not crazy
                // Base Height + (Displacement * Factor)
                return [d.longitude, d.latitude, d.height + (val * 0.2)];
            },
            getColor: d => {
                let val = 0;
                if (mode === 'animation') {
                    // 🚀 O(1) Access: We normalized d.displacements in pre-calc
                    const vec = d.displacements;
                    if (vec) {
                        const idx = Math.min(timeIndex, vec.length - 1);
                        val = vec[idx];
                    } else {
                        val = d.displacement || 0;
                    }
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
                getPosition: [timeIndex, mode] // 🆕 Trigger position update
            },
            pickable: true,
        })
    ], [displayData, timeIndex, mode]);

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
                totalPoints={displayData.length}
                fetchStatus={fetchStatus}
                isLoading={isLoading}
                cacheSize={tileCache.current.size}
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

export default HybridMap3D;

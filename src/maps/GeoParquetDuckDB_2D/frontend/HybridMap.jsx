import React, { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
import { scaleLinear } from 'd3-scale';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

import { HUD } from './components/HUD';
import { PlaybackControls } from './components/PlaybackControls';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const DATES_API_URL = 'http://localhost:5000/api/dates';
const DATA_API_URL = 'http://localhost:5000/api/hybrid-data';

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const GRID_SIZE = 0.06;
// 🆕 BUFFER: Fetch 1 extra ring of tiles
const TILE_BUFFER = 1;
// 🆕 CACHE LIMIT: Max number of tiles to keep in memory (approx 100-200MB depending on density)
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

function HybridMap() {
    const [displayData, setDisplayData] = useState([]);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);

    // Debug state to show current tier in HUD
    const [currentTierDisplay, setCurrentTierDisplay] = useState(0);

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);

    const mapContainerRef = useRef(null);
    const tileCache = useRef(new Map());
    // 🛑 REMOVED DEBOUNCE HOOKS
    const pendingRequests = useRef(new Set()); // 🆕 Track in-flight requests

    // --- HELPER: LRU Update ---
    // Moves 'key' to the end of the Map (marking it as most recently used)
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

        // Map.keys() returns iterator in insertion order (oldest first due to touchCache)
        for (const key of tileCache.current.keys()) {
            if (tileCache.current.size <= TILE_CACHE_LIMIT) break;

            // 🛑 NEVER EVICT GLOBAL TIER 0
            if (key.includes('global_t0')) continue;

            // Evict oldest
            tileCache.current.delete(key);
        }
    };

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
        if (isPlaying && dates.length > 0) {
            interval = setInterval(() => {
                setTimeIndex(prev => (prev >= dates.length - 1 ? 0 : prev + 1));
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates]);

    // 3. Tile Fetching Logic (Hybrid: Global T0 + Tiled T1/T2)
    useEffect(() => {
        if (!mapContainerRef.current || dates.length === 0) return;
        if (mode === 'animation' && isPlaying) return;

        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...viewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        // Grid Calculation
        const minTx = Math.floor(minLon / GRID_SIZE) - TILE_BUFFER;
        const maxTx = Math.floor(maxLon / GRID_SIZE) + TILE_BUFFER;
        const minTy = Math.floor(minLat / GRID_SIZE) - TILE_BUFFER;
        const maxTy = Math.floor(maxLat / GRID_SIZE) + TILE_BUFFER;

        const targetTier = getTargetTier(viewState.zoom);
        setCurrentTierDisplay(targetTier);

        const neededTiles = [];
        const visibleDataChunks = [];

        // --- STEP A: HANDLE TIER 0 (GLOBAL) ---
        // We always include Tier 0, but we fetch it as ONE big chunk, not tiles.
        const t0Key = mode === 'static' ? `global_t0_static_${timeIndex}` : `global_t0_anim`;
        if (tileCache.current.has(t0Key)) {
            touchCache(t0Key); // Mark used
            visibleDataChunks.push(tileCache.current.get(t0Key));
        } else {
            // Check if pending
            if (!pendingRequests.current.has(t0Key)) {
                neededTiles.push({ type: 'global', tier: 0, key: t0Key });
                pendingRequests.current.add(t0Key); // Mark pending
            }
        }

        // --- STEP B: HANDLE TIER 1 & 2 (TILED) ---
        // Only loop grid for tiers > 0
        if (targetTier > 0) {
            for (let x = minTx; x <= maxTx; x++) {
                for (let y = minTy; y <= maxTy; y++) {
                    // Loop T1 to TargetTier (skip T0 because it's handled above)
                    for (let t = 1; t <= targetTier; t++) {
                        const cacheKey = mode === 'static'
                            ? `${x}_${y}_T${t}_static_${timeIndex}`
                            : `${x}_${y}_T${t}_anim`;

                        if (tileCache.current.has(cacheKey)) {
                            touchCache(cacheKey); // Mark used
                            visibleDataChunks.push(tileCache.current.get(cacheKey));
                        } else {
                            if (!pendingRequests.current.has(cacheKey)) {
                                neededTiles.push({ type: 'tile', x, y, tier: t, key: cacheKey });
                                pendingRequests.current.add(cacheKey); // Mark pending
                            }
                        }
                    }
                }
            }
        }

        // Run eviction periodically (or purely on add)
        // Here we run it every render to ensure we stay clean, 
        // effectively cleaning up tiles that fell out of view.
        enforceCacheLimit();

        setDisplayData(visibleDataChunks.flat());

        if (neededTiles.length === 0) {
            setFetchStatus(`Cached (${visibleDataChunks.length} chunks)`);
            return;
        }

        setIsLoading(true);
        setFetchStatus(`Fetching ${neededTiles.length} new tiles...`);

        Promise.all(neededTiles.map(task => {
            let url = '';

            if (task.type === 'global') {
                // Special Endpoint/Param for Global Tier 0
                // We pass a dummy tile_x/y or handle it in backend
                const params = new URLSearchParams({
                    date_index: timeIndex,
                    mode: mode,
                    tier: 0,
                    global: 'true' // Explicit flag
                });
                url = `${DATA_API_URL}?${params.toString()}`;
            } else {
                const params = new URLSearchParams({
                    tile_x: task.x,
                    tile_y: task.y,
                    date_index: timeIndex,
                    mode: mode,
                    tier: task.tier
                });
                url = `${DATA_API_URL}?${params.toString()}`;
            }

            return load(url, ArrowLoader, { arrow: { shape: 'object-row-table' } })
                .then(result => {
                    const dataArr = result.data || result;
                    pendingRequests.current.delete(task.key); // Clear pending
                    if (Array.isArray(dataArr)) {
                        // Add to cache
                        tileCache.current.set(task.key, dataArr);
                        // No need to touchCache here, it will be touched on next render

                        // Check limit
                        if (tileCache.current.size > TILE_CACHE_LIMIT) {
                            enforceCacheLimit();
                        }

                        return dataArr;
                    }
                    return [];
                })
                .catch(e => {
                    console.error(`Failed ${task.key}`, e);
                    pendingRequests.current.delete(task.key); // Clear pending on error
                    tileCache.current.set(task.key, []); // Prevent infinite retry loop
                    return [];
                });
        })).then(() => {
            // Re-gather logic (Must mirror the selection logic above)
            const allChunks = [];

            // 1. Get Global T0
            if (tileCache.current.has(t0Key)) {
                allChunks.push(tileCache.current.get(t0Key));
            }

            // 2. Get Tiled T1/T2
            if (targetTier > 0) {
                for (let x = minTx; x <= maxTx; x++) {
                    for (let y = minTy; y <= maxTy; y++) {
                        for (let t = 1; t <= targetTier; t++) {
                            const k = mode === 'static' ? `${x}_${y}_T${t}_static_${timeIndex}` : `${x}_${y}_T${t}_anim`;
                            if (tileCache.current.has(k)) allChunks.push(tileCache.current.get(k));
                        }
                    }
                }
            }
            setDisplayData(allChunks.flat());
            setIsLoading(false);
            setFetchStatus('Ready');
        });

    }, [viewState, timeIndex, dates, mode]);

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
        new ScatterplotLayer({
            id: 'data-layer',
            data: displayData,
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
        })
    ];

    const toggleMode = () => {
        if (mode === 'static') setMode('animation');
        else {
            setMode('static');
            setIsPlaying(false);
        }
    };

    const [fetchStatus, setFetchStatus] = useState("Idle");

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

export default HybridMap;

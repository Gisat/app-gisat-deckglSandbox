import { CompositeLayer } from '@deck.gl/core';
import { WebMercatorViewport } from '@deck.gl/core';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

const DEFAULT_PROPS = {
    dataUrl: null,
    dateIndex: 0,
    mode: 'static',
    // Callbacks
    renderSubLayers: { type: 'function', value: props => null },
    onStatusChange: { type: 'function', value: () => { } },

    // Grid Config
    gridSize: 0.06,
    tileBuffer: 1,
    cacheLimit: 200,
};

export default class DuckDBGeoParquetLayer extends CompositeLayer {
    initializeState() {
        this.state = {
            tileCache: new Map(), // Map<Key, DataArray>
            pendingRequests: new Set(),
            previousVisibleKeys: new Set(),
            displayData: [],
            isLoading: false
        };
    }

    shouldUpdateState({ changeFlags }) {
        return changeFlags.somethingChanged;
    }

    updateState({ props, oldProps, changeFlags, context }) {
        if (changeFlags.viewportChanged ||
            props.dateIndex !== oldProps.dateIndex ||
            props.mode !== oldProps.mode) {
            this._fetchTiles(context.viewport);
        }

        // Report status periodically or on prop change
        this._reportStatus();
    }

    renderLayers() {
        const { renderSubLayers } = this.props;
        const { displayData } = this.state;

        if (renderSubLayers) {
            return renderSubLayers({
                data: displayData,
                // Pass a unique ID to ensure updates if needed, though 'data' ref change usually enough
            });
        }
        return null;
    }

    _fetchTiles(currentViewport) {
        const { dataUrl, dateIndex, mode, gridSize, tileBuffer, cacheLimit } = this.props;
        const { tileCache, pendingRequests, previousVisibleKeys } = this.state;

        if (!dataUrl) return;

        // 1. Calculate Grid
        // We use the DeckGL context viewport which is always up to date
        const viewport = currentViewport instanceof WebMercatorViewport
            ? currentViewport
            : new WebMercatorViewport(currentViewport);

        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

        const minTx = Math.floor(minLon / gridSize) - tileBuffer;
        const maxTx = Math.floor(maxLon / gridSize) + tileBuffer;
        const minTy = Math.floor(minLat / gridSize) - tileBuffer;
        const maxTy = Math.floor(maxLat / gridSize) + tileBuffer;

        const zoom = viewport.zoom;
        const targetTier = this._getTargetTier(zoom);

        const neededTiles = [];
        const visibleDataChunks = [];
        const currentVisibleKeys = new Set();

        // Helper: Touch LRU
        const touchCache = (key) => {
            const val = tileCache.get(key);
            if (val) {
                tileCache.delete(key);
                tileCache.set(key, val);
            }
        };

        // --- STEP A: TIER 0 ---
        const t0Key = mode === 'static' ? `global_t0_static_${dateIndex}` : `global_t0_anim`;
        currentVisibleKeys.add(t0Key);

        if (tileCache.has(t0Key)) {
            touchCache(t0Key);
            visibleDataChunks.push(tileCache.get(t0Key));
        } else {
            if (!pendingRequests.has(t0Key)) {
                neededTiles.push({ type: 'global', tier: 0, key: t0Key });
                pendingRequests.add(t0Key);
            }
        }

        // --- STEP B: TIER 1 & 2 ---
        if (targetTier > 0) {
            for (let x = minTx; x <= maxTx; x++) {
                for (let y = minTy; y <= maxTy; y++) {
                    for (let t = 1; t <= targetTier; t++) {
                        const cacheKey = mode === 'static'
                            ? `${x}_${y}_T${t}_static_${dateIndex}`
                            : `${x}_${y}_T${t}_anim`;

                        currentVisibleKeys.add(cacheKey);

                        if (tileCache.has(cacheKey)) {
                            touchCache(cacheKey);
                            visibleDataChunks.push(tileCache.get(cacheKey));
                        } else {
                            if (!pendingRequests.has(cacheKey)) {
                                neededTiles.push({ type: 'tile', x, y, tier: t, key: cacheKey });
                                pendingRequests.add(cacheKey);
                            }
                        }
                    }
                }
            }
        }

        // Optimization: Same Set Check
        let isSameSet = true;
        if (currentVisibleKeys.size !== previousVisibleKeys.size) isSameSet = false;
        else {
            for (let key of currentVisibleKeys) {
                if (!previousVisibleKeys.has(key)) {
                    isSameSet = false;
                    break;
                }
            }
        }

        if (isSameSet && neededTiles.length === 0) return;

        // Update State
        this.setState({ previousVisibleKeys: currentVisibleKeys });

        // LRU Eviction
        this._enforceCacheLimit();

        // Immediate Update from Cache
        if (visibleDataChunks.length > 0) {
            this.setState({ displayData: visibleDataChunks.flat() });
        }

        if (neededTiles.length === 0) {
            // onStatusChange handled in updateState mostly, or triggered here manually if needed?
            // Since we set displayData, renderLayers will be called.
            return;
        }

        this.setState({ isLoading: true });
        this._reportStatus(); // Report immediately

        // Perform Fetches
        Promise.all(neededTiles.map(task => {
            const params = new URLSearchParams({
                date_index: dateIndex,
                mode: mode,
                tier: task.tier
            });

            if (task.type === 'global') {
                params.append('global', 'true');
            } else {
                params.append('tile_x', task.x);
                params.append('tile_y', task.y);
            }

            const url = `${dataUrl}?${params.toString()}`;

            return load(url, ArrowLoader, { arrow: { shape: 'object-row-table' } })
                .then(result => {
                    const dataArr = result.data || result;
                    this.state.pendingRequests.delete(task.key);

                    if (Array.isArray(dataArr)) {
                        // Pre-calc Logic (Optimization from Map3D)
                        this._processData(dataArr);

                        this.state.tileCache.set(task.key, dataArr);
                        if (this.state.tileCache.size > cacheLimit) this._enforceCacheLimit();
                        return dataArr;
                    }
                    return [];
                })
                .catch(e => {
                    console.error(`Failed ${task.key}`, e);
                    this.state.pendingRequests.delete(task.key);
                    this.state.tileCache.set(task.key, []);
                    return [];
                });
        })).then(() => {
            // Check if layer is still active (this.internalState exists)
            if (this.internalState) {
                this._reGatherData(minTx, maxTx, minTy, maxTy, targetTier, t0Key, dateIndex, mode);
            }
        });
    }

    _reGatherData(minTx, maxTx, minTy, maxTy, targetTier, t0Key, dateIndex, mode) {
        // Must strictly mirror selection logic to build final array
        const allChunks = [];
        const { tileCache } = this.state;

        if (tileCache.has(t0Key)) allChunks.push(tileCache.get(t0Key));

        if (targetTier > 0) {
            for (let x = minTx; x <= maxTx; x++) {
                for (let y = minTy; y <= maxTy; y++) {
                    for (let t = 1; t <= targetTier; t++) {
                        const k = mode === 'static' ? `${x}_${y}_T${t}_static_${dateIndex}` : `${x}_${y}_T${t}_anim`;
                        if (tileCache.has(k)) allChunks.push(tileCache.get(k));
                    }
                }
            }
        }

        this.setState({
            displayData: allChunks.flat(),
            isLoading: false
        });

        this._reportStatus();
    }

    _processData(dataArr) {
        // Pre-calculation logic for Animation Performance
        for (let i = 0; i < dataArr.length; i++) {
            const d = dataArr[i];
            const vec = d.displacements;
            if (vec && !d.cumulative_displacements) {
                const len = vec.length || vec.byteLength;
                if (len > 0) {
                    const cum = new Float32Array(len);
                    let sum = 0;

                    // Normalize Arrow Vectors -> TypedArray
                    let fastDisplacements = vec;
                    const isArrow = typeof vec.get === 'function';

                    if (isArrow) {
                        fastDisplacements = new Float32Array(len);
                        for (let t = 0; t < len; t++) {
                            const val = vec.get(t);
                            fastDisplacements[t] = val;
                            sum += val;
                            cum[t] = sum;
                        }
                        d.displacements = fastDisplacements;
                    } else {
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
    }

    _enforceCacheLimit() {
        const { tileCache } = this.state;
        const { cacheLimit } = this.props;

        if (tileCache.size <= cacheLimit) return;
        for (const key of tileCache.keys()) {
            if (tileCache.size <= cacheLimit) break;
            if (key.includes('global_t0')) continue;
            tileCache.delete(key);
        }
    }

    _getTargetTier(zoom) {
        if (zoom >= 15) return 2;
        if (zoom >= 13) return 1;
        return 0;
    }

    _reportStatus() {
        const { onStatusChange } = this.props;
        const { displayData, tileCache, isLoading } = this.state;

        // Safety check if state is ready
        if (!displayData) return;

        if (onStatusChange) {
            onStatusChange({
                isLoading,
                totalPoints: displayData.length,
                cacheSize: tileCache.size
            });
        }
    }
}

DuckDBGeoParquetLayer.layerName = 'DuckDBGeoParquetLayer';
DuckDBGeoParquetLayer.defaultProps = DEFAULT_PROPS;

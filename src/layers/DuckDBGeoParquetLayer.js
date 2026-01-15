import { CompositeLayer } from '@deck.gl/core';
import { WebMercatorViewport } from '@deck.gl/core';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

const DEFAULT_PROPS = {
    dataUrl: null,
    geoparquetPath: null,
    dateIndex: 0,
    mode: 'static',
    columnMap: {
        latitude: 'latitude',
        longitude: 'longitude',
        height: 'height',
        size: 'size',
        color: 'color'
    },
    timeSeries: {
        dates: 'dates',
        displacements: 'displacements'
    },
    // Callbacks
    renderSubLayers: { type: 'function', value: () => null },
    onStatusChange: { type: 'function', value: () => { } },
    onError: { type: 'function', value: (error) => console.error(error) },

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
        const visibleArrowTables = [];
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
        // Smart Caching: If we are in static mode, check if we have the ANIMATION tile cached first.
        // If we do, we use it because it contains the data for all time steps (including this one).
        let t0Key = mode === 'static' ? `global_t0_static_${dateIndex}` : `global_t0_anim`;
        if (mode === 'static' && tileCache.has(`global_t0_anim`)) {
            t0Key = `global_t0_anim`;
        }

        currentVisibleKeys.add(t0Key);

        if (tileCache.has(t0Key)) {
            touchCache(t0Key);
            const t0Data = tileCache.get(t0Key);
            if (Array.isArray(t0Data)) {
                visibleArrowTables.push(...t0Data);
            } else if (t0Data) {
                visibleArrowTables.push(t0Data);
            }
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
                        let cacheKey = mode === 'static'
                            ? `${x}_${y}_T${t}_static_${dateIndex}`
                            : `${x}_${y}_T${t}_anim`;

                        // Smart Caching Check
                        if (mode === 'static' && tileCache.has(`${x}_${y}_T${t}_anim`)) {
                            cacheKey = `${x}_${y}_T${t}_anim`;
                        }

                        currentVisibleKeys.add(cacheKey);

                        if (tileCache.has(cacheKey)) {
                            touchCache(cacheKey);
                            const tileData = tileCache.get(cacheKey);
                            if (Array.isArray(tileData)) {
                                visibleArrowTables.push(...tileData);
                            } else if (tileData) {
                                visibleArrowTables.push(tileData);
                            }
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
        if (visibleArrowTables.length > 0) {
            const filteredTables = visibleArrowTables.filter(table => {
                if (!table) return false;
                const hasRows = (table?.numRows && table.numRows > 0) ||
                               (table?.length && table.length > 0) ||
                               (table?.data && table.data.length > 0) ||
                               (table?.schema && table.schema.names && table.schema.names.length > 0);
                return hasRows;
            });
            this.setState({ displayData: filteredTables });
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
            const { columnMap, timeSeries, geoparquetPath } = this.props;
            const params = new URLSearchParams({
                date_index: dateIndex,
                mode: mode,
                tier: task.tier,
                latitude_col: columnMap.latitude,
                longitude_col: columnMap.longitude,
                height_col: columnMap.height,
                size_col: columnMap.size,
                color_col: columnMap.color,
                displacements_col: timeSeries.displacements
            });

            if (geoparquetPath) {
                params.append('geoparquet_path', geoparquetPath);
            }

            if (this.props.is3D) {
                params.append('is3D', 'true');
            }

            if (task.type === 'global') {
                params.append('global', 'true');
            } else {
                params.append('tile_x', task.x);
                params.append('tile_y', task.y);
            }

            const url = `${dataUrl}?${params.toString()}`;

            return load(url, ArrowLoader, { arrow: { shape: 'arrow-table' } })
                .then(result => {
                    // Handle both single table and multi-table responses
                    const arrowTables = Array.isArray(result) ? result : [result];
                    this.state.pendingRequests.delete(task.key);

                    // Store Arrow tables directly in cache (avoiding conversion to JS objects)
                    // ArrowLoader returns {shape: 'arrow-table', schema: ..., data: _Table}
                    // We need to extract the actual Arrow table from the .data property
                    const actualTables = arrowTables.map(result => {
                        if (result && result.data && typeof result.data === 'object') {
                            // ArrowLoader wraps the table in a result object
                            return result.data;
                        } else if (result && result.numRows !== undefined) {
                            // Direct Arrow table
                            return result;
                        }
                        return null;
                    }).filter(table => table !== null);

                    // More flexible validation - accept tables that look like they have data
                    const validTables = actualTables.filter(table => {
                        if (!table) return false;

                        // Check various ways a table might indicate it has data
                        const hasRows = (table.numRows && table.numRows > 0) ||
                                       (table.length && table.length > 0) ||
                                       (table.data && table.data.length > 0) ||
                                       (table.schema && table.schema.names && table.schema.names.length > 0); // Has schema = likely has data

                        return hasRows;
                    });

                    if (validTables.length > 0) {
                        const cacheData = validTables.length === 1 ? validTables[0] : validTables;
                        this.state.tileCache.set(task.key, cacheData);
                        if (this.state.tileCache.size > cacheLimit) this._enforceCacheLimit();
                        return validTables;
                    }
                    return [];
                })
                .catch(e => {
                    this.props.onError(e);
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
        // Gather all cached Arrow tables
        const allArrowTables = [];
        const { tileCache } = this.state;

        // 1. T0 Logic
        let effectiveT0 = mode === 'static' ? `global_t0_static_${dateIndex}` : `global_t0_anim`;
        if (mode === 'static' && tileCache.has(`global_t0_anim`)) effectiveT0 = `global_t0_anim`;

        if (tileCache.has(effectiveT0)) {
            const t0Data = tileCache.get(effectiveT0);
            if (Array.isArray(t0Data)) {
                allArrowTables.push(...t0Data);
            } else if (t0Data) {
                allArrowTables.push(t0Data);
            }
        }

        if (targetTier > 0) {
            for (let x = minTx; x <= maxTx; x++) {
                for (let y = minTy; y <= maxTy; y++) {
                    for (let t = 1; t <= targetTier; t++) {
                        let k = mode === 'static' ? `${x}_${y}_T${t}_static_${dateIndex}` : `${x}_${y}_T${t}_anim`;
                        if (mode === 'static' && tileCache.has(`${x}_${y}_T${t}_anim`)) k = `${x}_${y}_T${t}_anim`;

                        if (tileCache.has(k)) {
                            const tileData = tileCache.get(k);
                            if (Array.isArray(tileData)) {
                                allArrowTables.push(...tileData);
                            } else if (tileData) {
                                allArrowTables.push(tileData);
                            }
                        }
                    }
                }
            }
        }

        const finalTables = allArrowTables.filter(table => {
            if (!table) return false;
            const hasRows = (table?.numRows && table.numRows > 0) ||
                           (table?.length && table.length > 0) ||
                           (table?.data && table.data.length > 0) ||
                           (table?.schema && table.schema.names && table.schema.names.length > 0);
            return hasRows;
        });

        // Store Arrow tables directly as displayData (not flattened JS objects)
        this.setState({
            displayData: finalTables,
            isLoading: false
        });

        this._reportStatus();
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

        // Calculate total points from Arrow tables
        let totalPoints = 0;
        if (Array.isArray(displayData)) {
            totalPoints = displayData.reduce((sum, table) => {
                return sum + (table && table.numRows ? table.numRows : 0);
            }, 0);
        }

        if (onStatusChange) {
            onStatusChange({
                isLoading,
                totalPoints,
                cacheSize: tileCache.size
            });
        }
    }
}

DuckDBGeoParquetLayer.layerName = 'DuckDBGeoParquetLayer';
DuckDBGeoParquetLayer.defaultProps = DEFAULT_PROPS;

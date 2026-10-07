import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import TiTilerErrorModal from './TiTilerErrorModal';
import { TITILER_ENDPOINTS, ENDPOINT_STORAGE_KEY, getInitialEndpointId } from './endpoints';
import { useTileTiming } from './useTileTiming';
import { useTileHealth } from './useTileHealth';
import './TiTilerEndpointSwitch.css';

/**
 * Generic TiTiler COG tile map: deck.gl TileLayer + BitmapLayer over a
 * light base map. Tiles are generated on the fly by TiTiler
 * (/cog/tiles/{z}/{x}/{y}.png?url=...&...).
 *
 * The endpoint switcher (top right) toggles between the plain TiTiler instance
 * (:8000) and the nginx-cached one (:8001/api/v1/titiler) so both can be
 * compared side by side; VITE_TITILER_URL adds a custom entry when set.
 *
 * If TiTiler is unreachable (health probe) or fails systemically (tile errors
 * confirmed by a z0 probe), a modal reports which endpoint is expected to run
 * and how to start it (start command of the selected endpoint). Per-tile
 * errors for tiles outside the COG bounds/zoom are normal and stay silent.
 *
 * Shared timing + health logic lives in useTileTiming / useTileHealth so the
 * terrain demos behave identically (no copy-paste).
 *
 * @param {string} cogUrl        - public COG URL passed to TiTiler as `url` param
 * @param {string} queryParams   - already-URL-encoded extra params (bands, rescale, colormap, nodata...)
 * @param {object} initialViewState - per-dataset initial camera
 * @param {number} maxZoom       - max zoom for the TiTiler tile layer
 */
function TiTilerTileMap({ cogUrl, queryParams, initialViewState, maxZoom = 16 }) {
    const [viewState, setViewState] = useState(initialViewState);
    const [endpointId, setEndpointId] = useState(getInitialEndpointId);
    const endpoint = TITILER_ENDPOINTS[endpointId] || TITILER_ENDPOINTS.plain;
    const { baseUrl, startCommand } = endpoint;
    // Bumped on retry/endpoint switch/timing toggle to recreate the TileLayer and force a full tile reload.
    const [titilerLayerKey, setTitilerLayerKey] = useState(0);

    const params = queryParams ? `&${queryParams}` : '';
    // TiTiler 2.x route: /cog/tiles/{tileMatrixSetId}/{z}/{x}/{y}.png (WebMercatorQuad = default)
    const tileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}${params}`;
    // z0 tile covers the whole world, so it always intersects the COG — a
    // reliable systemic probe (per-tile 4xx for out-of-bounds tiles are normal).
    const probeTileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/0/0/0.png?url=${encodeURIComponent(cogUrl)}${params}`;
    const healthUrl = `${baseUrl}/healthz`;

    const forceReload = () => setTitilerLayerKey(k => k + 1);

    const {
        timingEnabled,
        ttf,
        tta,
        tileCount,
        headline,
        handleViewStateChange,
        handleTileLoad,
        handleToggleTiming,
        resetForEndpoint,
    } = useTileTiming({ setViewState, onForceReload: forceReload });

    const {
        modal,
        retrying,
        handleRetry,
        handleDismiss,
        handleTileError,
        resetForEndpoint: resetHealthForEndpoint,
    } = useTileHealth({
        baseUrl,
        healthUrl,
        probeTileUrl,
        onLayerReload: forceReload,
        name: 'TiTilerTileMap',
    });

    const handleEndpointChange = (nextId) => {
        if (nextId === endpointId || !TITILER_ENDPOINTS[nextId]) return;
        setEndpointId(nextId);
        try {
            window.localStorage.setItem(ENDPOINT_STORAGE_KEY, nextId);
        } catch {
            /* storage unavailable — in-memory switch only */
        }
        // Drop any modal: it describes the previous endpoint, and lift suppression
        // so the new endpoint gets a fresh report. The health/probe URLs changed,
        // so the mount-style checks re-run on their own; bump the layer key so
        // tiles reload from the newly selected endpoint and the clock restarts
        // (same as toggling timing on).
        resetHealthForEndpoint();
        resetForEndpoint();
    };

    // When timing is ON the basemap is omitted (hidden): cartocdn requests would
    // share the browser/network with TiTiler tiles and confound the measurement.
    // Timing OFF restores the basemap for normal browsing.
    const layers = [];
    if (!timingEnabled) {
        layers.push(new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        }));
    }
    layers.push(new TileLayer({
        id: `titiler-tiles-${titilerLayerKey}`,
        data: tileUrl,
        minZoom: 0,
        maxZoom: maxZoom,
        tileSize: 256,
        onTileError: handleTileError,
        onTileLoad: handleTileLoad,
        renderSubLayers: props => {
            const { west, south, east, north } = props.tile.bbox;
            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [west, south, east, north]
            });
        }
    }));

    return (
        <>
            <DeckGL
                viewState={viewState}
                onViewStateChange={handleViewStateChange}
                controller={true}
                layers={layers}
                views={new MapView({ repeat: true })}
                style={{ width: '100vw', height: '100vh' }}
            />
            <div className="titiler-endpoint-switch" role="group" aria-label="TiTiler endpoint">
                <span className="titiler-endpoint-title">TiTiler endpoint</span>
                <div className="titiler-endpoint-options">
                    {Object.entries(TITILER_ENDPOINTS).map(([id, ep]) => (
                        <button
                            key={id}
                            type="button"
                            className={`titiler-endpoint-btn${id === endpointId ? ' titiler-endpoint-btn-active' : ''}`}
                            aria-pressed={id === endpointId}
                            onClick={() => handleEndpointChange(id)}
                            title={ep.startCommand ? `${ep.baseUrl}\nStart: ${ep.startCommand}` : ep.baseUrl}
                        >
                            {ep.label}
                        </button>
                    ))}
                </div>
                <div className="titiler-endpoint-url" title={baseUrl}>{baseUrl}</div>
                <div className="titiler-timing" role="group" aria-label="Tile timing">
                    <button
                        type="button"
                        className={`titiler-timing-toggle${timingEnabled ? ' titiler-timing-toggle-on' : ''}`}
                        aria-pressed={timingEnabled}
                        onClick={handleToggleTiming}
                        title={timingEnabled ? 'Stop timing (restores base map)' : 'Start timing (hides base map)'}
                    >
                        {timingEnabled ? '● Timing on' : '○ Timing off'}
                    </button>
                    {timingEnabled && (
                        <div className="titiler-timing-stats">
                            <div className="titiler-timing-note">base map hidden while timing</div>
                            <div><b>First tile:</b> {ttf != null ? `${ttf.toFixed(0)} ms` : '—'}</div>
                            <div><b>All tiles:</b> {tta != null ? `${tta.toFixed(0)} ms` : '—'}</div>
                            <div><b>Tiles:</b> {tileCount}</div>
                            <div className="titiler-timing-headline">
                                {headline
                                    ? `First (uncached) load: ${headline.ttf.toFixed(0)} ms → all in ${headline.tta.toFixed(0)} ms · ${headline.count} tiles`
                                    : 'First (uncached) load: measuring…'}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            {modal && (
                <TiTilerErrorModal
                    kind={modal.kind}
                    baseUrl={baseUrl}
                    healthUrl={healthUrl}
                    tileUrlTemplate={tileUrl}
                    cogUrl={cogUrl}
                    startCommand={startCommand}
                    errorMessage={modal.message}
                    errorDetail={modal.detail}
                    onRetry={handleRetry}
                    onDismiss={handleDismiss}
                    retrying={retrying}
                />
            )}
        </>
    );
}

export default TiTilerTileMap;

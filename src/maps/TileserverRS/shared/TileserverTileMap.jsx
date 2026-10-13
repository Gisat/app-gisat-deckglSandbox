import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import TileserverErrorModal from './TileserverErrorModal';
import { TILESERVER_ENDPOINT } from './endpoints';
// Shared with the TiTiler category: the timing hook is a pure measurement
// utility (settle-debounce + quiescence) with no TiTiler-specific behavior.
import { useTileTiming } from '../../TiTilerDemo/shared/useTileTiming';
import { useTileServerHealth } from './useTileServerHealth';
// Endpoint-panel styling is shared verbatim with the TiTiler switcher (the
// Tileserver-RS panel is a single-endpoint degenerate case of the same UI).
import '../../TiTilerDemo/shared/TiTilerEndpointSwitch.css';

/**
 * Generic tileserver-rs raster tile map: deck.gl TileLayer + BitmapLayer over
 * a light base map. Tiles are rendered server-side by tileserver-rs
 * (/data/{source}/{z}/{x}/{y}.png — COG warp + colormap/mosaic + PNG encode)
 * and cached in-process by the identity-raster-cache build.
 *
 * Unlike the TiTiler map there is no endpoint switcher (single local
 * deployment); the panel still hosts the timing toggle + HUD so cold vs
 * cached loads can be compared side by side.
 *
 * If tileserver-rs is unreachable (health probe) or fails systemically (tile
 * errors confirmed by an in-bounds probe), a modal reports the expected
 * endpoint and how to start it. Per-tile errors for tiles outside the source
 * bounds/zoom are normal and stay silent.
 *
 * @param {string} sourceId     - tileserver-rs source id (config.toml [[sources]] id)
 * @param {object} initialViewState - per-source initial camera
 * @param {number} maxZoom      - max zoom for the tile layer
 * @param {string} [probeTile]  - guaranteed in-bounds tile path (defaults to a z0 probe)
 */
function TileserverTileMap({ sourceId, initialViewState, maxZoom = 14, probeTile = '0/0/0.png' }) {
    const [viewState, setViewState] = useState(initialViewState);
    const { baseUrl, healthUrl, startCommand } = TILESERVER_ENDPOINT;
    // Bumped on retry/timing toggle to recreate the TileLayer and force a full tile reload.
    const [tileLayerKey, setTileLayerKey] = useState(0);

    const tileUrl = `${baseUrl}/data/${sourceId}/{z}/{x}/{y}.png`;
    // The probe tile must be in-bounds for the source — systemic failures only.
    const probeTileUrl = `${baseUrl}/data/${sourceId}/${probeTile}`;

    const forceReload = () => setTileLayerKey(k => k + 1);

    const {
        timingEnabled,
        ttf,
        tta,
        tileCount,
        headline,
        handleViewStateChange,
        handleTileLoad,
        handleToggleTiming,
    } = useTileTiming({ setViewState, onForceReload: forceReload });

    const {
        modal,
        retrying,
        handleRetry,
        handleDismiss,
        handleTileError,
    } = useTileServerHealth({
        baseUrl,
        healthUrl,
        probeTileUrl,
        onLayerReload: forceReload,
        name: `TileserverTileMap(${sourceId})`,
    });

    // When timing is ON the basemap is omitted (hidden): cartocdn requests would
    // share the browser/network with tileserver-rs tiles and confound the
    // measurement. Timing OFF restores the basemap for normal browsing.
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
        id: `tileserver-tiles-${tileLayerKey}`,
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
            <div className="titiler-endpoint-switch" role="group" aria-label="tileserver-rs endpoint">
                <span className="titiler-endpoint-title">tileserver-rs endpoint</span>
                <div className="titiler-endpoint-options">
                    <button
                        type="button"
                        className="titiler-endpoint-btn titiler-endpoint-btn-active titiler-source-static"
                        title={`${baseUrl}\nStart: ${startCommand}`}
                    >
                        {TILESERVER_ENDPOINT.label}
                    </button>
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
                <TileserverErrorModal
                    kind={modal.kind}
                    baseUrl={baseUrl}
                    healthUrl={healthUrl}
                    tileUrlTemplate={tileUrl}
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

export default TileserverTileMap;

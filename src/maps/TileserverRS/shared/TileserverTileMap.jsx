import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import TileserverErrorModal from './TileserverErrorModal';
import CrawlBoxOverlay from './CrawlBoxOverlay';
import CrawlCommandPanel from './CrawlCommandPanel';
import { TileOutline, TileContextMenu } from './TileInspectorOverlay';
import { useTileHoverInspector } from './useTileHoverInspector';
import { TILESERVER_ENDPOINT } from './endpoints';
import './TileInspectorOverlay.css';
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
 * @param {boolean} [inspectTiles=false] - outline the hovered tile + custom right-click menu
 * @param {boolean} [enableCrawl=false] - let the user drag a bbox and get the
 *        fetch-tiles.mjs command for it (see CrawlCommandPanel)
 */
function TileserverTileMap({ sourceId, initialViewState, maxZoom = 14, probeTile = '0/0/0.png', inspectTiles = false, enableCrawl = false }) {
    const [viewState, setViewState] = useState(initialViewState);
    const { baseUrl, healthUrl, startCommand } = TILESERVER_ENDPOINT;
    // Bumped on retry/timing toggle to recreate the TileLayer and force a full tile reload.
    const [tileLayerKey, setTileLayerKey] = useState(0);
    // Right-click menu state: client coords of the click + the tile under it.
    const [menu, setMenu] = useState(null);

    // --- Crawl-from-bbox state -------------------------------------------
    // drawMode makes the next drag select a bbox instead of panning the map;
    // the deck.gl controller is disabled while it is on.
    const [drawMode, setDrawMode] = useState(false);
    // The completed bbox as [west, south, east, north], or null.
    const [crawlBbox, setCrawlBbox] = useState(null);
    // Source TileJSON, read once for the suggested zoom range (min/maxzoom).
    const [tilejson, setTilejson] = useState(null);

    const tileUrl = `${baseUrl}/data/${sourceId}/{z}/{x}/{y}.png`;
    // The probe tile must be in-bounds for the source — systemic failures only.
    const probeTileUrl = `${baseUrl}/data/${sourceId}/${probeTile}`;

    const forceReload = () => setTileLayerKey(k => k + 1);

    // The tile the menu was opened on. While the menu is open we FREEZE the
    // hover state: the pointer is over the menu (outside the map), so deck.gl
    // would otherwise clear the hover and re-render, flickering the menu.
    const menuTileRef = useRef(null);

    const closeMenu = useCallback(() => {
        menuTileRef.current = null;
        setMenu(null);
    }, []);

    // STAC-only hover inspector: reads the picked tile from deck.gl's onHover
    // info and derives the exact request URL for the outline + context menu.
    const { hoveredTile, label: tileLabel, handleHover } = useTileHoverInspector({
        tileUrl,
    });

    // Mirror the live hover into a ref so the native contextmenu listener (a
    // closure created once) can read the current tile without being re-bound
    // on every hover event.
    const hoveredTileRef = useRef(null);
    useEffect(() => {
        hoveredTileRef.current = hoveredTile;
    }, [hoveredTile]);

    // When the menu is open, keep showing the frozen tile instead of the live
    // hover (the pointer has left the map, so hover would be null).
    const displayTile = menu ? menuTileRef.current : hoveredTile;
    const displayLabel = menu ? (menuTileRef.current
        ? `z${menuTileRef.current.z} / x${menuTileRef.current.x} / y${menuTileRef.current.y}`
        : null) : tileLabel;

    // Suppress the native browser context menu over the map and, when tile
    // inspection is on, open our own menu at the pointer with the hovered
    // tile's info. deck.gl's <DeckGL> does not forward onContextMenu to its
    // canvas, so a React prop there is inert; attach a native listener on the
    // wrapper we own. The native menu is always suppressed; the custom menu
    // only appears when there is a tile under the cursor.
    const wrapperRef = useRef(null);
    useEffect(() => {
        const el = wrapperRef.current;
        if (!el) return undefined;
        const onContextMenu = event => {
            event.preventDefault();
            if (inspectTiles && hoveredTileRef.current) {
                menuTileRef.current = hoveredTileRef.current;
                setMenu({ x: event.clientX, y: event.clientY });
            }
        };
        el.addEventListener('contextmenu', onContextMenu);
        return () => el.removeEventListener('contextmenu', onContextMenu);
    }, [inspectTiles]);

    // Read the source's TileJSON once, purely to suggest a zoom range that the
    // server actually supports. Failure is non-fatal: the panel falls back to
    // sane defaults rather than hiding the feature.
    useEffect(() => {
        if (!enableCrawl) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`${baseUrl}/data/${sourceId}.json`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled) setTilejson(data);
            } catch {
                // Offline / server down: keep tilejson null and let the panel default.
            }
        })();
        return () => { cancelled = true; };
    }, [enableCrawl, baseUrl, sourceId]);

    // Dev-only test hook: expose a deterministic camera control on window so a
    // CDP-driven harness can pan/zoom the map with REAL viewState changes.
    // Synthetic pointer gestures are unreliable for deck.gl's controller (it
    // tracks real gesture state), and the map instance is otherwise not
    // reachable from the page. This makes burst tests reproducible: repeated
    // window.__map.setCamera({longitude, latitude, zoom}) calls are exactly the
    // "N tiles at one bbox" fan-out we need. Gated to DEV — the production
    // bundle never defines window.__map.
    useEffect(() => {
        if (!import.meta.env.DEV) return undefined;
        window.__map = {
            sourceId,
            tileUrl,
            get: () => viewState,
            setCamera: vs => setViewState(v => ({ ...v, ...vs })),
            forceReload,
        };
        return () => { delete window.__map; };
    }, [sourceId, tileUrl, viewState]);

    // Dismiss the menu on Esc, on scroll, or on a left-click/tap outside it.
    // `pointerdown` in the CAPTURE phase fires before deck.gl's map handlers,
    // so a click on the map closes the menu without the click also being
    // consumed by the map; a click inside the menu does not bubble to close.
    useEffect(() => {
        if (!menu) return undefined;
        const onKey = event => { if (event.key === 'Escape') closeMenu(); };
        const onPointerDown = event => {
            if (event.button !== 0) return;
            if (event.target.closest && event.target.closest('.tileserver-tile-menu')) return;
            closeMenu();
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('wheel', closeMenu, { passive: true });
        window.addEventListener('pointerdown', onPointerDown, true);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('wheel', closeMenu);
            window.removeEventListener('pointerdown', onPointerDown, true);
        };
    }, [menu, closeMenu]);

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
            // BitmapLayer must be pickable for deck.gl to report the picked
            // tile at all; the TileLayer's getPickingInfo then enriches the
            // pick with `info.tile`. No onHover here — the handler lives on
            // <DeckGL> (deck.gl's own mechanism), see the hook's docs.
            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [west, south, east, north],
                pickable: inspectTiles,
            });
        }
    }));

    // Outline layer last so it draws above the tiles/basemap. Uses the frozen
    // tile while the menu is open so the outline does not vanish/change when
    // the pointer moves off the map onto the menu.
    if (inspectTiles) {
        const outline = TileOutline({ tile: displayTile });
        if (outline) layers.push(outline);
    }

    return (
        <>
            <div ref={wrapperRef} style={{ position: 'absolute', inset: 0 }}>
            <DeckGL
                id="deck-map"
                viewState={viewState}
                onViewStateChange={handleViewStateChange}
                controller={!drawMode}
                layers={layers}
                views={new MapView({ repeat: true })}
                onHover={inspectTiles ? handleHover : undefined}
                style={{ width: '100vw', height: '100vh' }}
            />
            {enableCrawl && drawMode && (
                <CrawlBoxOverlay
                    viewState={viewState}
                    onComplete={(box) => { setCrawlBbox(box); setDrawMode(false); }}
                    onCancel={() => setDrawMode(false)}
                />
            )}
            </div>
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
                {enableCrawl && !drawMode && !crawlBbox && (
                    <button
                        type="button"
                        className="titiler-timing-toggle"
                        onClick={() => setDrawMode(true)}
                        title="Drag a rectangle on the map to get the fetch-tiles.mjs command for it"
                    >
                        Select area to crawl
                    </button>
                )}
                {enableCrawl && drawMode && (
                    <div className="titiler-timing-note">Drag a rectangle on the map · Esc cancels</div>
                )}
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
            {inspectTiles && menu && createPortal(
                <TileContextMenu
                    tile={displayTile}
                    label={displayLabel}
                    position={menu}
                    onClose={closeMenu}
                />,
                document.body,
            )}
            {enableCrawl && crawlBbox && (
                <CrawlCommandPanel
                    bbox={crawlBbox}
                    zoom={viewState.zoom}
                    sourceId={sourceId}
                    baseUrl={baseUrl}
                    tilejson={tilejson}
                    onClear={() => { setCrawlBbox(null); setDrawMode(false); }}
                />
            )}
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

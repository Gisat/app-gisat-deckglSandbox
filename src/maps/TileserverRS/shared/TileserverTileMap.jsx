import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, PolygonLayer } from '@deck.gl/layers';
import TileserverErrorModal from './TileserverErrorModal';
import CrawlBoxOverlay from './CrawlBoxOverlay';
import CrawlCommandPanel from './CrawlCommandPanel';
import { TileOutline, TileContextMenu } from './TileInspectorOverlay';
import { useTileHoverInspector } from './useTileHoverInspector';
import { TILESERVER_ENDPOINT, TILESERVER_UPSTREAM_ORIGIN, getTileserverPublicUrl } from './endpoints';
import { copyText } from './clipboard';
import './TileInspectorOverlay.css';
// Shared with the TiTiler category: the timing hook is a pure measurement
// utility (settle-debounce + quiescence) with no TiTiler-specific behavior.
import { useTileSessionStats } from './useTileSessionStats';
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

// --- Pan constraint -------------------------------------------------------
// A source can cover a small region inside a global basemap, so the user can
// easily pan into empty space and then draw a bbox that is entirely off the
// data — which used to produce a confusing warning. (io-lulc itself is global,
// so this no longer binds there; it still matters for regional sources like
// manila-rgb, and it is what makes the constraint source-agnostic.)
//
// deck.gl's own `maxBounds` is NOT usable here: it derives a minimum zoom from
// the bounds rect (minZoom = log2(viewportWidth / boundsWidthInWorldPx)). For a
// small source in a 1580 px viewport that is z~10.6, far above its advertised
// minzoom, so the source's low zooms would become unreachable. So the centre is
// clamped by hand and zoom is limited separately, from TileJSON's minzoom.
//
// The rule: a slice of the footprint must always stay on screen. The centre may
// move until just MARGIN_FRAC of the viewport still shows data, and no further.
// (Two rejected earlier attempts, both caught by checking against the live app:
// adding positive "slack" let the whole footprint leave the screen; and clamping
// to a bare edge-touch left zero pixels of data visible at the limit.)
const MARGIN_FRAC = 0.15;
const MAX_LAT = 85.05113;

// deck.gl tiles are 512 px wide, so the world is 512 * 2^zoom px across.
const worldSizeAt = (zoom) => 512 * 2 ** zoom;

// Normalised Web Mercator Y in [0, 1] (0 = north edge, 1 = south edge).
function mercY(lat) {
    const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

function mercYToLat(y) {
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Clamp the camera centre so the source footprint cannot leave the screen.
 *
 * @param {object} vs     - view state (needs longitude, latitude, zoom)
 * @param {number[]|null} bounds - [west, south, east, north] or null
 * @param {{width:number, height:number}} size - viewport size in CSS px
 * @returns {object} the view state, possibly with longitude/latitude adjusted
 */
function clampToBounds(vs, bounds, size) {
    if (!Array.isArray(bounds) || bounds.length !== 4) return vs;
    if (!Number.isFinite(vs.longitude) || !Number.isFinite(vs.latitude)) return vs;
    const { width, height } = size || {};
    if (!(width > 0) || !(height > 0)) return vs;
    const zoom = Number.isFinite(vs.zoom) ? vs.zoom : 0;

    const [bw, bs, be, bn] = bounds;
    const ws = worldSizeAt(zoom);

    // Half the viewport expressed in the same units as the bounds.
    const halfLon = (width / 2 / ws) * 360;
    const halfY = height / 2 / ws; // in normalised mercator units

    // Longitude is linear in mercator, latitude is not, so convert the
    // footprint to mercator Y before applying the same interval rule.
    const yNorth = mercY(bn);
    const ySouth = mercY(bs);

    // A footprint edge may approach the screen edge but must leave at least
    // MARGIN_FRAC of the viewport showing data.
    const marginLon = ((width * MARGIN_FRAC) / ws) * 360;
    const marginY = (height * MARGIN_FRAC) / ws;
    const minLon = bw - halfLon + marginLon;
    const maxLon = be + halfLon - marginLon;
    const minY = yNorth - halfY + marginY;
    const maxY = ySouth + halfY - marginY;

    const lon = Math.max(minLon, Math.min(maxLon, vs.longitude));
    const lat = mercYToLat(Math.max(minY, Math.min(maxY, mercY(vs.latitude))));

    if (lon === vs.longitude && lat === vs.latitude) return vs;
    return { ...vs, longitude: lon, latitude: lat };
}

// deck.gl's Controller defaults to `zoomAround: 'pointer'`, which anchors each
// wheel notch on the cursor. Every notch then sets a CONSTRAINT_AROUND that
// MapController applies via viewport.panByPosition() — and it does so
// UNCONDITIONALLY, even when _constrainZoom() has already clamped the zoom.
// At our zoom floor that makes the zoom term a no-op while the pan term still
// applies, so the map kept sliding sideways (cursor-offset from centre per
// notch) while the zoom stayed pinned — measured: zoom frozen at 5 while
// longitude walked 22.6 -> 78.4 with 12 further notches.
//
// `zoomAround: 'center'` anchors on the viewport centre, so the anchor point
// stays at its own screen position and the pan term cancels out. Wheel zoom
// then never moves the map, at any zoom, and it applies to double-click and
// pinch too (all of which route through getZoomPosition()).
const CONTROLLER_PROPS = { zoomAround: 'center' };

function TileserverTileMap({ sourceId, initialViewState, maxZoom = 14, probeTile = '0/0/0.png', inspectTiles = false, enableCrawl = false }) {
    const [viewState, setViewState] = useState(initialViewState);
    const { baseUrl, healthUrl, startCommand } = TILESERVER_ENDPOINT;
    // Absolute URL (protocol + host + port) shown in the panel and copied on
    // click. Resolved once per page load; see getTileserverPublicUrl().
    const publicUrl = getTileserverPublicUrl();
    const [endpointCopied, setEndpointCopied] = useState(false);
    const copiedTimer = useRef(null);
    useEffect(() => () => clearTimeout(copiedTimer.current), []);
    const handleCopyEndpoint = useCallback(async () => {
        const ok = await copyText(publicUrl);
        if (!ok) return; // clipboard unavailable: leave the text selectable by hand
        setEndpointCopied(true);
        clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setEndpointCopied(false), 1500);
    }, [publicUrl]);
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
    // Source TileJSON, read once for the suggested zoom range (min/maxzoom)
    // and — via boundsRef — for the pan constraint.
    const [tilejson, setTilejson] = useState(null);
    // Bounds mirrored into a ref so handleViewStateChange (a stable useCallback)
    // can clamp against the latest footprint without being re-created.
    const boundsRef = useRef(null);
    useEffect(() => {
        boundsRef.current = tilejson?.bounds ?? null;
    }, [tilejson]);

    // The source's own zoom floor, derived from TileJSON so the camera and the
    // TileLayer respect it. A dynamic STAC source can have a floor well above 0
    // (io-lulc: 5, because low-zoom tiles fan out across full-width supercell
    // bands and exceed the server's render timeout). Asking below it returns
    // 404s for every tile in view — the map looks broken while the server is
    // healthy, which is exactly the ambiguity this demo must avoid.
    const minZoom = Number.isFinite(tilejson?.minzoom) ? tilejson.minzoom : 0;

    const tileUrl = `${baseUrl}/data/${sourceId}/{z}/{x}/{y}.png`;
    // Same tile template but fully qualified (protocol + host + port), for the
    // right-click menu's URL row and "Copy tile URL". `tileUrl` stays the
    // same-origin proxy path the browser actually requests (COEP-safe); this is
    // the paste-anywhere form, resolved from the same runtime knob as the
    // endpoint panel (getTileserverPublicUrl).
    const displayTileUrl = `${publicUrl}/data/${sourceId}/{z}/{x}/{y}.png`;
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
        displayTileUrl,
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

    // Apply the pan constraint once the footprint is known. Without this a
    // camera that is already off the data (e.g. restored from a previous
    // session, or a link with a custom view) would stay there until the user
    // happened to pan. Idempotent: clamping an already-valid view is a no-op,
    // so this cannot loop with handleViewStateChange.
    useEffect(() => {
        const bounds = tilejson?.bounds;
        if (!Array.isArray(bounds) || bounds.length !== 4) return;
        const el = wrapperRef.current;
        if (!el || !el.clientWidth || !el.clientHeight) return;
        setViewState(prev => clampToBounds(prev, bounds, {
            width: el.clientWidth,
            height: el.clientHeight,
        }));
    }, [tilejson]);

    // The single place a camera change is applied, so the pan constraint cannot
    // be bypassed. deck.gl's own controller path goes through
    // handleViewStateChange; the dev hook below must use this too, otherwise
    // setCamera() would move the map somewhere the user could not reach by hand.
    const applyViewState = useCallback((next) => {
        const el = wrapperRef.current;
        // Clamp zoom to the source's own window FIRST: a camera below minZoom
        // would request a full screen of tiles the source does not serve.
        const zoom = Number.isFinite(next.zoom)
            ? Math.max(minZoom, Math.min(maxZoom, next.zoom))
            : next.zoom;
        const clamped = clampToBounds({ ...next, zoom }, boundsRef.current, {
            width: el ? el.clientWidth : 0,
            height: el ? el.clientHeight : 0,
        });
        setViewState(clamped);
    }, [minZoom, maxZoom]);

    // Dev-only test hook: expose a deterministic camera control on window so a
    // CDP-driven harness can pan/zoom the map with REAL viewState changes.
    // Synthetic pointer gestures are unreliable for deck.gl's controller (it
    // tracks real gesture state), and the map instance is otherwise not
    // reachable from the page. This makes burst tests reproducible: repeated
    // window.__map.setCamera({longitude, latitude, zoom}) calls are exactly the
    // "N tiles at one bbox" fan-out we need. Gated to DEV — the production
    // bundle never defines window.__map. Goes through applyViewState, so the
    // tests exercise the same pan constraint the user gets.
    useEffect(() => {
        if (!import.meta.env.DEV) return undefined;
        window.__map = {
            sourceId,
            tileUrl,
            get: () => viewState,
            setCamera: vs => applyViewState({ ...viewState, ...vs }),
            forceReload,
        };
        return () => { delete window.__map; };
    }, [sourceId, tileUrl, viewState, applyViewState]);

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
        handleToggleTiming,
        count: tileCount,
        avgMs,
        resetStats,
    } = useTileSessionStats({ tileUrlPrefix: `${baseUrl}/data/${sourceId}/` });

    // deck.gl hands back the new camera on pan/zoom. The stats are
    // session-cumulative, so there is no measurement window to open/close here —
    // this is just the state update the map needs.
    // The centre is clamped so a small regional source cannot be panned off
    // screen (see clampToBounds). Size comes from the live element so a window
    // resize is respected; bounds come from a ref so this callback stays stable
    // across renders.
    const handleViewStateChange = useCallback(({ viewState: next }) => {
        applyViewState(next);
    }, [applyViewState]);

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
        minZoom,
        maxZoom: maxZoom,
        tileSize: 256,
        onTileError: handleTileError,
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

    // Persistent outline of the drawn crawl bbox. The CrawlBoxOverlay that the
    // drag happens on unmounts as soon as drawing ends, so without this layer
    // the box would vanish the moment the selection is made. A deck.gl layer
    // also re-projects correctly on pan/zoom (the canvas overlay could not),
    // and it stays until `crawlBbox` is cleared (Clear button / new selection).
    if (crawlBbox) {
        const [w, s, e, n] = crawlBbox;
        layers.push(new PolygonLayer({
            id: 'crawl-bbox',
            data: [{
                polygon: [[w, s], [e, s], [e, n], [w, n], [w, s]],
            }],
            getPolygon: d => d.polygon,
            filled: true,
            getFillColor: [0, 102, 204, 30],
            stroked: true,
            getLineColor: [0, 102, 204, 255],
            getLineWidth: 2,
            lineWidthUnits: 'pixels',
            lineWidthMinPixels: 2,
            pickable: false,
        }));
    }

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
                controller={drawMode ? false : CONTROLLER_PROPS}
                layers={layers}
                views={new MapView({ repeat: true })}
                onHover={inspectTiles ? handleHover : undefined}
                // 100% (not 100vw): the map must fill its container, which sits
                // to the right of the 340px sidebar. With 100vw deck.gl builds a
                // viewport as wide as the window while the element is only as
                // wide as .main-content (~1580px on a 1920px screen), so the
                // canvas overhangs the right edge and every screen->geo
                // conversion is offset east. That offset was invisible until
                // b1bcb56 kept the drawn crawl bbox on screen; the bbox then
                // landed ~0.12 deg east of where it was drawn at z10 and could
                // trip the "outside this source's bounds" warning. Matching the
                // container width also centres the map in the visible area
                // instead of under the sidebar.
                style={{ width: '100%', height: '100%' }}
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
                <button
                    type="button"
                    className={`titiler-endpoint-url titiler-endpoint-url-copy${endpointCopied ? ' titiler-endpoint-url-copied' : ''}`}
                    onClick={handleCopyEndpoint}
                    title={`Click to copy\n\nRequested as ${baseUrl} (proxied to ${TILESERVER_UPSTREAM_ORIGIN})\nStart: ${startCommand}`}
                >
                    <span className="titiler-endpoint-url-text">{publicUrl}</span>
                    <span className="titiler-endpoint-url-action" aria-hidden="true">
                        {endpointCopied ? 'Copied' : 'Copy'}
                    </span>
                </button>
                {enableCrawl && !drawMode && !crawlBbox && (
                    <button
                        type="button"
                        className="titiler-timing-toggle titiler-crawl-toggle"
                        onClick={() => setDrawMode(true)}
                        title="Drag a rectangle on the map to get the fetch-tiles.mjs command that builds its MBTiles cache"
                    >
                        Select area for MBTiles cache
                    </button>
                )}
                {enableCrawl && drawMode && (
                    <div className="titiler-timing-note">Drag a rectangle on the map · Esc cancels</div>
                )}
                <div className="titiler-timing" role="group" aria-label="Tile timing">
                    <button
                        type="button"
                        className={`titiler-timing-toggle titiler-timing-main${timingEnabled ? ' titiler-timing-toggle-on' : ''}`}
                        aria-pressed={timingEnabled}
                        onClick={handleToggleTiming}
                        title={timingEnabled ? 'Timing is ON — base map hidden, stats shown. Click for Timing OFF.' : 'Timing is OFF — base map shown. Click for Timing ON (hides base map).'}
                    >
                        {timingEnabled ? 'Timing ON' : 'Timing OFF'}
                    </button>
                    {timingEnabled && (
                        <div className="titiler-timing-stats">
                            <div className="titiler-timing-note">session totals · base map hidden while timing</div>
                            <div><b>Tiles drawn:</b> {tileCount}</div>
                            <div><b>Avg per tile:</b> {avgMs != null ? `${avgMs.toFixed(1)} ms` : '—'}</div>
                            <button
                                type="button"
                                className="titiler-timing-reset"
                                onClick={resetStats}
                                title="Zero the session counters and start measuring again"
                            >
                                Reset Stats
                            </button>
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

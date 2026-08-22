import { useState, useEffect, useRef, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import TiTilerErrorModal from './TiTilerErrorModal';

const DEFAULT_TITILER_URL = 'http://localhost:8000';
// Base URL of the TiTiler instance (see deploy/titiler/docker-compose.yml).
// Override via .env: VITE_TITILER_URL=https://your-deployed-titiler.example
const TITILER_URL = import.meta.env.VITE_TITILER_URL || DEFAULT_TITILER_URL;

const HEALTH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const TILE_ERROR_GRACE_MS = 500;
// How often to re-check TiTiler reachability while the map is open. Needed
// because TiTiler tiles are cached by the browser (max-age=3600): after a
// mid-session outage no new tile requests fail (and onTileError never fires)
// unless the user pans/zooms — so the modal would otherwise never reappear.
const HEALTH_CHECK_INTERVAL_MS = 10000;

function fetchWithTimeout(url, timeoutMs, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal, ...options }).finally(() => clearTimeout(timer));
}

/**
 * Reachability check that tolerates CORS-less servers and TiTiler builds
 * without a /healthz route (404): ANY HTTP response means the endpoint is up,
 * so only a total network failure (or timeout) counts as unreachable.
 * Real per-request problems surface later via onTileError + the z0 probe.
 */
async function isTiTilerReachable(healthUrl) {
    try {
        await fetchWithTimeout(healthUrl, HEALTH_TIMEOUT_MS);
        return true; // server answered (any status) -> reachable
    } catch {
        // CORS-blocked fetch rejects with TypeError even when the server is up —
        // retry in no-cors mode: resolves (opaque) whenever the server answers.
        try {
            await fetchWithTimeout(healthUrl, HEALTH_TIMEOUT_MS, { mode: 'no-cors' });
            return true;
        } catch {
            return false; // genuinely unreachable
        }
    }
}

/**
 * Generic TiTiler COG tile map: deck.gl TileLayer + BitmapLayer over a
 * light base map. Tiles are generated on the fly by TiTiler
 * (/cog/tiles/{z}/{x}/{y}.png?url=...&...).
 *
 * If TiTiler is unreachable (health probe) or fails systemically (tile errors
 * confirmed by a z0 probe), a modal reports which endpoint is expected to run
 * and how to start it (see deploy/titiler/docker-compose.yml). Per-tile errors
 * for tiles outside the COG bounds/zoom are normal and stay silent.
 *
 * @param {string} cogUrl        - public COG URL passed to TiTiler as `url` param
 * @param {string} queryParams   - already-URL-encoded extra params (bands, rescale, colormap, nodata...)
 * @param {object} initialViewState - per-dataset initial camera
 * @param {number} maxZoom       - max zoom for the TiTiler tile layer
 */
function TiTilerTileMap({ cogUrl, queryParams, initialViewState, maxZoom = 16 }) {
    const [viewState, setViewState] = useState(initialViewState);
    // null | { kind: 'unreachable' | 'tile-error', message, detail }
    const [modal, setModal] = useState(null);
    const [retrying, setRetrying] = useState(false);
    // Bumped on retry to recreate the TileLayer and force a full tile reload.
    const [titilerLayerKey, setTitilerLayerKey] = useState(0);

    // Debounce/dedupe machinery for tile errors (zoom/pan storms fire one error per tile).
    const errorTimerRef = useRef(null);
    const pendingErrorRef = useRef(null);
    // Set when the user dismisses the modal: stay quiet while TiTiler stays down.
    // Auto-cleared as soon as a periodic check sees TiTiler reachable again, so a
    // later outage is reported again (the user asked for exactly that).
    const suppressedRef = useRef(false);
    const modalRef = useRef(null);
    modalRef.current = modal;

    const params = queryParams ? `&${queryParams}` : '';
    // TiTiler 2.x route: /cog/tiles/{tileMatrixSetId}/{z}/{x}/{y}.png (WebMercatorQuad = default)
    const tileUrl = `${TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}${params}`;
    // z0 tile covers the whole world, so it always intersects the COG — a
    // reliable systemic probe (per-tile 4xx for out-of-bounds tiles are normal).
    const probeTileUrl = `${TITILER_URL}/cog/tiles/WebMercatorQuad/0/0/0.png?url=${encodeURIComponent(cogUrl)}${params}`;
    const healthUrl = `${TITILER_URL}/healthz`;

    // On mount: probe TiTiler reachability; only a total network failure
    // (timeout / connection refused) reports "unreachable".
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ok = await isTiTilerReachable(healthUrl);
            if (!cancelled && !ok) {
                suppressedRef.current = false;
                setModal({
                    kind: 'unreachable',
                    message: `TiTiler is not reachable at ${TITILER_URL} (health check ${healthUrl} failed). Start it with the docker-compose command below, then press Retry.`,
                });
            }
        })();
        return () => { cancelled = true; };
    }, [healthUrl]);

    // Periodic reachability re-check (see HEALTH_CHECK_INTERVAL_MS): reports a
    // mid-session TiTiler outage even when every tile is served from cache, and
    // auto-lifts user suppression once TiTiler is back so the next outage reports.
    useEffect(() => {
        const interval = setInterval(async () => {
            const reachable = await isTiTilerReachable(healthUrl);
            if (reachable) {
                suppressedRef.current = false; // back up: a future outage should report again
                return;
            }
            if (suppressedRef.current || modalRef.current) return; // user dismissed / already reported
            setModal({
                kind: 'unreachable',
                message: `TiTiler became unreachable while the map was open (${TITILER_URL}). It was reachable before, so check whether the service stopped (docker compose logs) and press Retry.`,
            });
        }, HEALTH_CHECK_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [healthUrl]);

    // Unmount cleanup for the pending debounce timer.
    useEffect(() => () => {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    }, []);

    // Single-modal rule: an 'unreachable' modal wins over symptom 'tile-error's
    // (they are caused by the outage); same-kind updates keep the latest info.
    const showModal = useCallback((next) => {
        setModal(prev => {
            if (prev && prev.kind === 'unreachable' && next.kind === 'tile-error') return prev;
            if (prev && prev.kind === next.kind) return { ...prev, ...next };
            return next;
        });
    }, []);

    // Tile-level errors (TiTiler up but tiles fail, TiTiler dies mid-session, ...).
    // Debounced + deduped, and gated by a z0 probe: TiTiler returns 4xx for
    // tiles outside the COG bounds/zoom while the layer still renders fine, so
    // only systemic failures (probe fails too) open the modal.
    const handleTileError = useCallback((err) => {
        if (suppressedRef.current) return;
        pendingErrorRef.current = err;
        if (errorTimerRef.current) return;
        errorTimerRef.current = setTimeout(async () => {
            errorTimerRef.current = null;
            const err = pendingErrorRef.current;
            pendingErrorRef.current = null;
            if (!err || suppressedRef.current) return;

            // Probe the z0 tile: real HTTP status + TiTiler JSON detail.
            let probeOk = false;
            let detail = '';
            try {
                const res = await fetchWithTimeout(probeTileUrl, PROBE_TIMEOUT_MS);
                probeOk = res.ok;
                if (!res.ok) {
                    detail = `HTTP ${res.status}`;
                    const body = await res.json().catch(() => null);
                    if (body && body.detail) {
                        detail += ` — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`;
                    }
                }
            } catch {
                probeOk = false;
            }

            if (probeOk) {
                // Endpoint healthy — the error is per-tile (e.g. tile outside the
                // COG bounds or beyond its zoom). Normal, keep quiet.
                console.warn('[TiTilerTileMap] per-tile error while endpoint is healthy:', err && err.message);
                return;
            }

            showModal({
                kind: 'tile-error',
                message: err && err.message ? `Tile loading failed: ${err.message}` : 'Tile loading failed.',
                detail,
            });
        }, TILE_ERROR_GRACE_MS);
    }, [probeTileUrl, showModal]);

    const handleRetry = useCallback(async () => {
        setRetrying(true);
        // Cancel any in-flight debounced tile error so a stale one can't reopen the modal.
        if (errorTimerRef.current) {
            clearTimeout(errorTimerRef.current);
            errorTimerRef.current = null;
        }
        pendingErrorRef.current = null;
        try {
            let ok = false;
            if (modal && modal.kind === 'unreachable') {
                ok = await isTiTilerReachable(healthUrl);
            } else {
                // tile-error: probe the actual tile endpoint.
                try {
                    const res = await fetchWithTimeout(probeTileUrl, PROBE_TIMEOUT_MS);
                    ok = res.ok;
                    if (!ok) {
                        const body = await res.json().catch(() => null);
                        const detail = body && body.detail
                            ? `HTTP ${res.status} — ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`
                            : `HTTP ${res.status}`;
                        showModal({ kind: 'tile-error', message: `Tile loading still fails (${TITILER_URL}).`, detail });
                    }
                } catch {
                    ok = false;
                    showModal({ kind: 'tile-error', message: `Tile endpoint still not reachable (${TITILER_URL}).`, detail: '' });
                }
            }

            if (ok) {
                suppressedRef.current = false;
                setModal(null);
                setTitilerLayerKey(k => k + 1); // recreate layer -> reload all tiles
            }
        } finally {
            setRetrying(false);
        }
    }, [modal, healthUrl, probeTileUrl, showModal]);

    const handleDismiss = useCallback(() => {
        suppressedRef.current = true;
        setModal(null);
    }, []);

    const layers = [
        new TileLayer({
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
        }),
        new TileLayer({
            id: `titiler-tiles-${titilerLayerKey}`,
            data: tileUrl,
            minZoom: 0,
            maxZoom: maxZoom,
            tileSize: 256,
            onTileError: handleTileError,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        })
    ];

    return (
        <>
            <DeckGL
                viewState={viewState}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                layers={layers}
                views={new MapView({ repeat: true })}
                style={{ width: '100vw', height: '100vh' }}
            />
            {modal && (
                <TiTilerErrorModal
                    kind={modal.kind}
                    baseUrl={TITILER_URL}
                    healthUrl={healthUrl}
                    tileUrlTemplate={tileUrl}
                    cogUrl={cogUrl}
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

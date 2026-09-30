import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TerrainLayer } from '@deck.gl/geo-layers';
import TiTilerErrorModal from './TiTilerErrorModal';
import './TiTilerEndpointSwitch.css';

// Misicuni DEM COG (GLO-30 + geoid, EPSG:3857, single float32 band).
// Served as ON-THE-FLY GRAYSCALE PNG TILES by TiTiler (no colormap) so the
// values reach deck.gl's native TerrainLayer as an 8-bit height field.
//
// Why grayscale + custom decoder (NOT the Mapzen/Terrarium trick):
//   TiTiler cannot emit Terrarium-packed RGB elevation tiles from an arbitrary
//   float COG — give it a single band and it returns a grayscale PNG where
//   R=G=B at every pixel. A multi-channel Terrarium decoder (rScaler:256,
//   gScaler:1, bScaler:1/256) would then just multiply three equal bytes, so
//   it collapses to one effective gain → no extra resolution. So this demo
//   uses the honest grayscale path: 8-bit quantization (~256 levels), which is
//   fine at the intended relief-wide 3D view and visibly steppy only if you
//   zoom way in. Full-precision terrain would require fetching the COG and
//   decoding float client-side (CogTerrainLayer) — not a TiTiler demo.
//
// Elevation decode (from loaders.gl TerrainLoader, terrain-loader.js):
//   height = R*rScaler + G*gScaler + B*bScaler + offset
// For a grayscale tile, R=G=B=value, so with gScaler=bScaler=0:
//   height = value * rScaler + offset
// TiTiler /cog/tiles rescale is LINEAR: pixel = (elev - rescale[0]) / span * 255
// with span = rescale[1] - rescale[0]. Invert it in the decoder:
//   rScaler = span / 255,  offset = rescale[0]
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';

// Display range in meters (see "Choosing the rescale" below). Must match the
// `rescale` in `queryParams` AND the decoder constants — change all three.
const RESCALE_MIN = 0;
const RESCALE_MAX = 5600;

// grayscale rescale: maps elevation range [0,5600] m onto 8-bit 0..255
const queryParams = [
    'bidx=1',
    `rescale=${RESCALE_MIN},${RESCALE_MAX}`
].join('&');

// Invert TiTiler's linear rescale: pixel 0 -> RESCALE_MIN, pixel 255 -> RESCALE_MAX.
const ELEVATION_DECODER = {
    rScaler: (RESCALE_MAX - RESCALE_MIN) / 255,
    gScaler: 0,
    bScaler: 0,
    offset: RESCALE_MIN,
};

// Misicuni / Cochabamba region (from /cog/info bounds, EPSG:3857 center:
// lon -66.357, lat -17.098). Azimuth 3D view of the Cordillera; kept at a
// relief-wide zoom so the 8-bit stepping stays invisible. Cap the zoom at the
// native detail level of the DEM.
const INITIAL_VIEW_STATE = {
    longitude: -66.357,
    latitude: -17.098,
    zoom: 9.5,
    pitch: 50,
    bearing: -20,
    maxZoom: 14,
    maxPitch: 70,
};

// Same timing constants as the shared TiTilerTileMap (see its JSDoc) so the
// DEM's measurement behaves identically to the other TiTiler demos. The single
// knob is reused BOTH as the viewport-settle debounce AND as the quiescence
// threshold ("all tiles" = no new onTileLoad for this long).
const TIMING_SETTLE_MS = 800;
const HEALTH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const TILE_ERROR_GRACE_MS = 500;
const HEALTH_CHECK_INTERVAL_MS = 10000;

// deck.gl's TerrainLayer spawns a martini/delatin tesselation worker.
// workerUrl is intentionally NOT set: loaders.gl auto-resolves the worker
// bundle from its CDN default (https://unpkg.com/@loaders.gl). A local copy
// under public/ is only needed if the demo must run fully offline.
function TerrainDemo() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [endpointId, setEndpointId] = useState('plain');
    const [modal, setModal] = useState(null);
    const [retrying, setRetrying] = useState(false);
    // Bumped on endpoint switch / timing-toggle to recreate the TerrainLayer and
    // force a full tile reload (fresh measurement window).
    const [terrainLayerKey, setTerrainLayerKey] = useState(0);

    // Timing HUD (opt-in via a toggle, same as the shared demos). Live values
    // track the current settled-viewport window; `headline` freezes the FIRST
    // (uncached) load of the session/endpoint.
    const [timingEnabled, setTimingEnabled] = useState(true);
    const [ttf, setTtf] = useState(null);
    const [tta, setTta] = useState(null);
    const [tileCount, setTileCount] = useState(0);
    const [headline, setHeadline] = useState(null);

    const suppressedRef = useRef(false);
    const modalRef = useRef(null);
    modalRef.current = modal;
    const errorTimerRef = useRef(null);
    const pendingErrorRef = useRef(null);
    const measurementRef = useRef({
        settleAt: null, firstAt: null, lastAt: null, count: 0, headlineDone: false,
    });
    const settleTimerRef = useRef(null);
    const quiesceTimerRef = useRef(null);

    // Minimal copy of the shared endpoint set (kept local so we don't couple to
    // TiTilerTileMap's internal constants; mirrors deploy/*/docker-compose.yml).
    const ENDPOINTS = useMemo(() => ({
        plain: {
            label: 'TiTiler (plain)',
            baseUrl: '/titiler-plain',
            startCommand: 'docker compose -f deploy/titiler/docker-compose.yml up -d',
        },
        caching: {
            label: 'TiTiler + cache',
            baseUrl: '/titiler/api/v1/titiler',
            startCommand: 'docker compose -f deploy/titiler-caching/docker-compose.yml up -d',
        },
    }), []);
    const endpoint = ENDPOINTS[endpointId] || ENDPOINTS.plain;
    const { baseUrl, startCommand } = endpoint;

    const tileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(COG_URL)}&${queryParams}`;
    const probeTileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/0/0/0.png?url=${encodeURIComponent(COG_URL)}&${queryParams}`;
    const healthUrl = `${baseUrl}/healthz`;

    const fetchWithTimeout = useCallback((url, ms, options = {}) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        return fetch(url, { signal: ctrl.signal, ...options }).finally(() => clearTimeout(t));
    }, []);

    const isReachable = useCallback(async (url) => {
        try {
            await fetchWithTimeout(url, HEALTH_TIMEOUT_MS);
            return true;
        } catch {
            try { await fetchWithTimeout(url, HEALTH_TIMEOUT_MS, { mode: 'no-cors' }); return true; }
            catch { return false; }
        }
    }, [fetchWithTimeout]);

    // ---- Timing measurement (ported verbatim from TiTilerTileMap) ----

    const resetMeasurement = useCallback(() => {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        settleTimerRef.current = null;
        quiesceTimerRef.current = null;
        Object.assign(measurementRef.current, { settleAt: null, firstAt: null, lastAt: null, count: 0 });
        setTtf(null);
        setTta(null);
        setTileCount(0);
    }, []);

    const startMeasurementNow = useCallback(() => {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        settleTimerRef.current = null;
        quiesceTimerRef.current = null;
        const m = measurementRef.current;
        m.settleAt = performance.now();
        m.firstAt = null;
        m.lastAt = null;
        m.count = 0;
        m.headlineDone = false;
        setTtf(null);
        setTta(null);
        setTileCount(0);
        setHeadline(null);
    }, []);

    const handleViewStateChange = useCallback(({ viewState }) => {
        setViewState(viewState);
        if (!timingEnabled) return;
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
            settleTimerRef.current = null;
            const m = measurementRef.current;
            m.settleAt = performance.now();
            m.firstAt = null;
            m.lastAt = null;
            m.count = 0;
            setTtf(null);
            setTta(null);
            setTileCount(0);
        }, TIMING_SETTLE_MS);
    }, [timingEnabled]);

    const handleTileLoad = useCallback(() => {
        if (!timingEnabled) return;
        const m = measurementRef.current;
        if (m.settleAt == null) return;
        const now = performance.now();
        if (m.firstAt == null) m.firstAt = now;
        m.lastAt = now;
        m.count += 1;
        setTileCount(m.count);
        setTtf(m.firstAt - m.settleAt);
        setTta(m.lastAt - m.settleAt);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
        quiesceTimerRef.current = setTimeout(() => {
            quiesceTimerRef.current = null;
            const mm = measurementRef.current;
            if (!mm.headlineDone && mm.firstAt != null && mm.lastAt != null && mm.count > 0) {
                mm.headlineDone = true;
                setHeadline({
                    ttf: mm.firstAt - mm.settleAt,
                    tta: mm.lastAt - mm.settleAt,
                    count: mm.count,
                });
            }
        }, TIMING_SETTLE_MS);
    }, [timingEnabled]);

    const handleToggleTiming = useCallback(() => {
        setTimingEnabled(prev => {
            const next = !prev;
            if (!next) {
                resetMeasurement();
                return next;
            }
            setTerrainLayerKey(k => k + 1);
            startMeasurementNow();
            return next;
        });
    }, [resetMeasurement, startMeasurementNow]);

    const handleEndpointChange = useCallback((nextId) => {
        if (nextId === endpointId || !ENDPOINTS[nextId]) return;
        setEndpointId(nextId);
        setModal(null);
        suppressedRef.current = false;
        setTerrainLayerKey(k => k + 1);
        startMeasurementNow();
        setHeadline(null);
    }, [endpointId, ENDPOINTS, startMeasurementNow]);

    // ---- Error handling (ported from TiTilerTileMap) ----

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ok = await isReachable(healthUrl);
            if (!cancelled && !ok) {
                suppressedRef.current = false;
                setModal({ kind: 'unreachable', message: `TiTiler is not reachable at ${baseUrl}. Start it with the compose command below, then Retry.` });
            }
        })();
        return () => { cancelled = true; };
    }, [healthUrl, baseUrl, isReachable]);

    useEffect(() => {
        const iv = setInterval(async () => {
            const ok = await isReachable(healthUrl);
            if (ok) { suppressedRef.current = false; return; }
            if (suppressedRef.current || modalRef.current) return;
            setModal({ kind: 'unreachable', message: `TiTiler became unreachable while the map was open (${baseUrl}).` });
        }, HEALTH_CHECK_INTERVAL_MS);
        return () => clearInterval(iv);
    }, [healthUrl, baseUrl, isReachable]);

    useEffect(() => () => {
        if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
        if (quiesceTimerRef.current) clearTimeout(quiesceTimerRef.current);
    }, []);

    const showModal = useCallback((next) => {
        setModal(prev => {
            if (prev && prev.kind === 'unreachable' && next.kind === 'tile-error') return prev;
            if (prev && prev.kind === next.kind) return { ...prev, ...next };
            return next;
        });
    }, []);

    const handleTileError = useCallback((err) => {
        if (suppressedRef.current) return;
        pendingErrorRef.current = err;
        if (errorTimerRef.current) return;
        errorTimerRef.current = setTimeout(async () => {
            errorTimerRef.current = null;
            const err = pendingErrorRef.current;
            pendingErrorRef.current = null;
            if (!err || suppressedRef.current) return;

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
                console.warn('[MisicuniTerrain] per-tile error while endpoint is healthy:', err && err.message);
                return;
            }
            showModal({
                kind: 'tile-error',
                message: err && err.message ? `Tile loading failed: ${err.message}` : 'Tile loading failed.',
                detail,
            });
        }, TILE_ERROR_GRACE_MS);
    }, [probeTileUrl, showModal, fetchWithTimeout]);

    const handleDismiss = useCallback(() => { suppressedRef.current = true; setModal(null); }, []);
    const handleRetry = useCallback(async () => {
        setRetrying(true);
        try {
            let ok;
            if (modal?.kind === 'unreachable') ok = await isReachable(healthUrl);
            else {
                try { const r = await fetchWithTimeout(probeTileUrl, PROBE_TIMEOUT_MS); ok = r.ok; }
                catch { ok = false; }
            }
            if (ok) { suppressedRef.current = false; setModal(null); setTerrainLayerKey(k => k + 1); }
            else showModal({ kind: 'tile-error', message: `Tile endpoint still failing (${baseUrl}).`, detail: '' });
        } finally { setRetrying(false); }
    }, [modal, healthUrl, probeTileUrl, baseUrl, isReachable, fetchWithTimeout, showModal]);

    const layers = [
        new TerrainLayer({
            // layerKey forces a fresh layer on endpoint switch / timing toggle so
            // tiles reload and the first (uncached) load is measured per endpoint.
            id: `misicuni-terrain-${terrainLayerKey}`,
            elevationData: tileUrl,
            texture: null,
            meshMaxError: 2.5,
            elevationDecoder: ELEVATION_DECODER,
            minZoom: 0,
            maxZoom: RESCALE_MAX >= 5000 ? 14 : RESCALE_MAX >= 3000 ? 13 : 12,
            tileSize: 256,
            color: [255, 255, 255],
            onTileLoad: handleTileLoad,
            onTileError: handleTileError,
        }),
    ];

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
                    {Object.entries(ENDPOINTS).map(([id, ep]) => (
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
                        title={timingEnabled ? 'Stop timing' : 'Start timing'}
                    >
                        {timingEnabled ? '● Timing on' : '○ Timing off'}
                    </button>
                    {timingEnabled && (
                        <div className="titiler-timing-stats">
                            <div className="titiler-timing-note">terrain mesh is the measured layer</div>
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
                    cogUrl={COG_URL}
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

export default TerrainDemo;

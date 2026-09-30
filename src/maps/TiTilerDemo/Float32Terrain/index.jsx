import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TerrainLayer } from '@deck.gl/geo-layers';
import Float32Loader from './Float32Loader';
import TiTilerErrorModal from './TiTilerErrorModal';
import './TiTilerEndpointSwitch.css';

// Raw float32 terrain demo (bypasses the browser image pipeline).
//
// Elevation source: a sibling tile service
// (deploy/titiler-caching/float32-encoder) that reads THIS float32 COG
// directly with rasterio windowed reads and serves each WebMercatorQuad
// {z}/{x}/{y} tile as a HEADERLESS little-endian IEEE-754 float32 stream
// (`'<f4'`, row-major north-up, 256x256 -> exactly 256*256*4 = 262,144 bytes).
// It sits behind the SAME nginx as TiTiler in the caching stack, at
// /api/v1/float32/, and its tiles are cached there like TiTiler's / Terrarium's.
//
// Why raw float32 instead of Terrarium PNG:
//   The Terrarium route decodes PNGs through the browser's color-managed image
//   pipeline (createImageBitmap -> canvas drawImage + getImageData), which on
//   wide-gamut / color-managed displays shifts R/G/B by ±1 and, with the
//   Terrarium Red scaler of 256, produces the scattered ±256 m "needles"
//   (deck.gl issue #10400). The float32 route avoids that entirely: the tile is
//   a raw binary stream, so `new Float32Array(arrayBuffer)` (Float32Loader) is
//   a pure-JS view over the bytes — no image APIs, no color management, no
//   needles. It also removes the Terrarium packing + CLAMP coupling on both
//   sides.
//
// Heights are already METRES (the encoder reads a GLO-30 + geoid DEM), so the
// decoder is the identity: Float32Loader applies no elevationDecoder math
// (unlike TerrariumTerrain's linear combiner). The encoder fills
// masked/nodata/out-of-COG pixels with 0.0 server-side (martini cannot handle
// NaN), so tiles are always finite and the mesh stays flat at sea level
// outside the DEM footprint.
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';

// No elevationDecoder needed: heights are raw metres. Float32Loader does an
// identity decode (new Float32Array(arrayBuffer)).
const ELEVATION_LOADERS = [Float32Loader];

// Misicuni / Cochabamba region (from /cog/info bounds, EPSG:3857 center:
// lon ≈ -66.49, lat ≈ -17.04). Matches the view used by the Misicuni grayscale
// and Terrarium demos so the three terrain renders are directly comparable. Cap
// the zoom at the native detail of the DEM (~30 m GLO-30) — beyond it is
// upsampling.
const INITIAL_VIEW_STATE = {
    longitude: -66.49,
    latitude: -17.04,
    zoom: 9.5,
    pitch: 50,
    bearing: -20,
    maxZoom: 14,
    maxPitch: 70,
};

// Same timing constants as the shared TiTilerTileMap (see its JSDoc).
const TIMING_SETTLE_MS = 800;
const HEALTH_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const TILE_ERROR_GRACE_MS = 500;
const HEALTH_CHECK_INTERVAL_MS = 10000;

// deck.gl's TerrainLayer spawns a martini/delatin tesselation worker.
// workerUrl is intentionally NOT set: loaders.gl resolves it from its CDN
// default. A local copy under public/ is only needed to run fully offline.
// (Float32Loader is worker:false and builds the mesh on the main thread, so
// the raw bytes never touch a worker or the image pipeline.)
function Float32Terrain() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [modal, setModal] = useState(null);
    const [retrying, setRetrying] = useState(false);
    // Bumped on timing-toggle to recreate the TerrainLayer and reload tiles.
    const [terrainLayerKey, setTerrainLayerKey] = useState(0);

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

    // The encoder is mounted inside the caching stack (same nginx), so there is
    // a single endpoint here: the caching stack's public URL. Tiles are served
    // from /api/v1/float32/{z}/{x}/{y}.f32; health is /api/v1/float32/healthz.
    const ENDPOINTS = useMemo(() => ({
        float32: {
            label: 'Raw float32 encoder',
            baseUrl: '/titiler/api/v1/float32',
            startCommand: 'docker compose -f deploy/titiler-caching/docker-compose.yml up -d',
        },
    }), []);
    const { baseUrl, startCommand } = ENDPOINTS.float32;

    const tileUrl = `${baseUrl}/{z}/{x}/{y}.f32`;
    // Live probe tile: must be a guaranteed in-bounds tile of THIS COG so the
    // probe returns 200 and exonerates a stray tile error. (The encoder rejects
    // z=0 via Z_MIN=1, and /0/0/0.f32 would 404 and falsely trip the modal.)
    const probeTileUrl = `${baseUrl}/8/80/140.f32`;
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

    // ---- Error handling (ported from TiTilerTileMap) ----

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const ok = await isReachable(healthUrl);
            if (!cancelled && !ok) {
                suppressedRef.current = false;
                setModal({ kind: 'unreachable', message: `Raw float32 encoder is not reachable at ${baseUrl}. Start the caching stack, then Retry.` });
            }
        })();
        return () => { cancelled = true; };
    }, [healthUrl, baseUrl, isReachable]);

    useEffect(() => {
        const iv = setInterval(async () => {
            const ok = await isReachable(healthUrl);
            if (ok) { suppressedRef.current = false; return; }
            if (suppressedRef.current || modalRef.current) return;
            setModal({ kind: 'unreachable', message: `Raw float32 encoder became unreachable while the map was open (${baseUrl}).` });
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
                console.warn('[Float32Terrain] per-tile error while encoder is healthy:', err && err.message);
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
            // layerKey forces a fresh layer on timing toggle so tiles reload.
            id: `float32-terrain-${terrainLayerKey}`,
            elevationData: tileUrl,
            texture: null,
            meshMaxError: 2.5,
            // No elevationDecoder: Float32Loader decodes raw metres directly.
            loaders: ELEVATION_LOADERS,
            minZoom: 0,
            maxZoom: 14,
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
            <div className="titiler-endpoint-switch" role="group" aria-label="Raw float32 encoder">
                <span className="titiler-endpoint-title">Source</span>
                <div className="titiler-endpoint-options">
                    {Object.entries(ENDPOINTS).map(([id, ep]) => (
                        <button
                            key={id}
                            type="button"
                            className={`titiler-endpoint-btn${id === 'float32' ? ' titiler-endpoint-btn-active' : ''}`}
                            aria-pressed={true}
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
                                    ? `First (uncached) load: ${headline.ttf.toFixed(0)} ms → all in ${headline.tta.toFixed(0)} ms · ${headline.tileCount} tiles`
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

export default Float32Terrain;

import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TerrainLayer } from '@deck.gl/geo-layers';
import TiTilerErrorModal from '../shared/TiTilerErrorModal';
import { TITILER_ENDPOINTS, ENDPOINT_STORAGE_KEY, getInitialEndpointId } from '../shared/endpoints';
import { useTileTiming } from '../shared/useTileTiming';
import { useTileHealth } from '../shared/useTileHealth';
import '../shared/TiTilerEndpointSwitch.css';

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

// Display range in meters. Must match the `rescale` in `queryParams` AND the
// decoder constants — change all three.
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

// deck.gl's TerrainLayer spawns a martini/delatin tesselation worker.
// workerUrl is intentionally NOT set: loaders.gl auto-resolves the worker
// bundle from its CDN default (https://unpkg.com/@loaders.gl). A local copy
// under public/ is only needed if the demo must run fully offline.
function MisicuniTerrain() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [endpointId, setEndpointId] = useState(getInitialEndpointId);
    const endpoint = TITILER_ENDPOINTS[endpointId] || TITILER_ENDPOINTS.plain;
    const { baseUrl, startCommand } = endpoint;
    // Bumped on endpoint switch / timing-toggle / retry to recreate the TerrainLayer
    // and force a full tile reload (fresh measurement window).
    const [terrainLayerKey, setTerrainLayerKey] = useState(0);

    const tileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(COG_URL)}&${queryParams}`;
    const probeTileUrl = `${baseUrl}/cog/tiles/WebMercatorQuad/0/0/0.png?url=${encodeURIComponent(COG_URL)}&${queryParams}`;
    const healthUrl = `${baseUrl}/healthz`;

    const forceReload = () => setTerrainLayerKey(k => k + 1);

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
        name: 'MisicuniTerrain',
    });

    const handleEndpointChange = (nextId) => {
        if (nextId === endpointId || !TITILER_ENDPOINTS[nextId]) return;
        setEndpointId(nextId);
        try {
            window.localStorage.setItem(ENDPOINT_STORAGE_KEY, nextId);
        } catch {
            /* storage unavailable — in-memory switch only */
        }
        resetHealthForEndpoint();
        resetForEndpoint();
    };

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

export default MisicuniTerrain;

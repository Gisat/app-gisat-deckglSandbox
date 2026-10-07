import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TerrainLayer } from '@deck.gl/geo-layers';
import TerrariumLoader from '../shared/TerrariumLoader';
import TiTilerErrorModal from '../shared/TiTilerErrorModal';
import { useTileTiming } from '../shared/useTileTiming';
import { useTileHealth } from '../shared/useTileHealth';
import '../shared/TiTilerEndpointSwitch.css';

// "True Mapzen" Terrarium terrain demo.
//
// Elevation source: a sibling tile service (deploy/titiler-caching/terrarium-encoder)
// that reads THIS float32 COG directly with rasterio windowed reads and packs
// each WebMercatorQuad {z}/{x}/{y} tile in the Mapzen **Terrarium** RGB format
// (encoded = (elev + CLAMP) * 256; R=high byte, G=middle, B=low). It sits behind
// the SAME nginx as TiTiler in the caching stack, at /api/v1/terrarium/, and its
// tiles are cached there like TiTiler's.
//
// Why this is different from MisicuniTerrain (grayscale):
//   TiTiler renders a single-band COG as grayscale R=G=B, so a multi-channel
//   Terrarium decoder would just multiply three equal bytes -> 8-bit (~256
//   levels). Here the encoder genuinely packs real float resolution into the
//   RGB channels, so the canonical Terrarium decoder recovers sub-meter
//   precision: height = R*256 + G + B/256 - CLAMP.
//
// Canonical Mapzen decoder (from loaders.gl TerrainLoader, linear combiner):
//   height = R*rScaler + G*gScaler + B*bScaler + offset
//   Terrarium: rScaler=256, gScaler=1, bScaler=1/256, offset=-CLAMP.
// The encoder clamps elevation to ±CLAMP (canonical Mapzen default 32768 m,
// set via ENCODER_CLAMP in the caching compose file). The DEM spans 0..5631 m.
// Keep the encoder CLAMP and this offset from drifting — both are canonical
// 32768, but the comment's value is what must match ENCODER_CLAMP.
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';

// Must match ENCODER_CLAMP in deploy/titiler-caching/docker-compose.yml.
const CLAMP = 32768;

const ELEVATION_DECODER = {
    rScaler: 256,
    gScaler: 1,
    bScaler: 1 / 256,
    offset: -CLAMP,
};

// Fix for the "needles" artifact (deck.gl issue #10400).
//
// TerrainLayer decodes its elevation PNG through a loaders.gl web worker,
// which on the browser decodes the tile via createImageBitmap and then
// extracts pixels with a canvas drawImage + getImageData round-trip. On
// wide-gamut / color-managed displays (macOS defaults to a wide color
// profile) that path shifts R/G/B channel values by ±1. The Terrarium Red
// scaler is 256, so a single ±1 shift in the Red channel becomes a ±256 m
// vertical spike — the scattered "needles" seen all over the mesh. The raw
// PNG bytes are clean (verified independently); the corruption is introduced
// client-side in the color-managed image pipeline, which is why the same
// file renders clean under file:// (no worker) and spikes over http(s).
//
// The fix: drive TerrainLayer with a custom pure-JS loader (TerrariumLoader)
// via its `loaders` prop, replacing the default TerrainWorkerLoader. That
// loader decodes each PNG with UPNG (pure JavaScript — no browser image
// APIs, no color management) and builds the martini mesh on the main thread,
// returning the same mesh shape TerrainLayer expects. The channel bytes reach
// the decoder unmodified, at full 24-bit Terrarium precision, with no
// needles. Downside: mesh tesselation runs on the main thread (fine for a
// demo).
const ELEVATION_LOADERS = [TerrariumLoader];

// The encoder is mounted inside the caching stack (same nginx), so there is a
// single source here: the caching stack's public URL. Tiles are served from
// /api/v1/terrarium/{z}/{x}/{y}.png; health is /api/v1/terrarium/healthz.
const SOURCE = {
    label: 'Terrarium encoder',
    baseUrl: '/titiler/api/v1/terrarium',
    startCommand: 'docker compose -f deploy/titiler-caching/docker-compose.yml up -d',
};

// Misicuni / Cochabamba region (from /cog/info bounds, EPSG:3857 center:
// lon ≈ -66.49, lat ≈ -17.04). Matches the view used by the Misicuni grayscale
// demo so the two terrain renders are directly comparable. Cap the zoom at the
// native detail of the DEM (~30 m GLO-30) — beyond it is upsampling.
const INITIAL_VIEW_STATE = {
    longitude: -66.49,
    latitude: -17.04,
    zoom: 9.5,
    pitch: 50,
    bearing: -20,
    maxZoom: 14,
    maxPitch: 70,
};

// deck.gl's TerrainLayer spawns a martini/delatin tesselation worker.
// workerUrl is intentionally NOT set: loaders.gl resolves it from its CDN
// default. A local copy under public/ is only needed to run fully offline.
function TerrariumTerrain() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    // Bumped on timing-toggle / retry to recreate the TerrainLayer and reload tiles.
    const [terrainLayerKey, setTerrainLayerKey] = useState(0);

    const { baseUrl, startCommand } = SOURCE;

    const tileUrl = `${baseUrl}/{z}/{x}/{y}.png`;
    // Live probe tile: must be a guaranteed in-bounds tile of THIS COG so the
    // probe returns 200 and exonerates a stray tile error. (The encoder rejects
    // z=0 via Z_MIN=1, and /0/0/0.png would 404 and falsely trip the modal.)
    const probeTileUrl = `${baseUrl}/8/80/140.png`;
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
    } = useTileTiming({ setViewState, onForceReload: forceReload });

    const {
        modal,
        retrying,
        handleRetry,
        handleDismiss,
        handleTileError,
    } = useTileHealth({
        baseUrl,
        healthUrl,
        probeTileUrl,
        onLayerReload: forceReload,
        name: 'TerrariumTerrain',
    });

    const layers = [
        new TerrainLayer({
            // layerKey forces a fresh layer on timing toggle so tiles reload.
            id: `terrarium-terrain-${terrainLayerKey}`,
            elevationData: tileUrl,
            texture: null,
            meshMaxError: 2.5,
            elevationDecoder: ELEVATION_DECODER,
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
            <div className="titiler-endpoint-switch" role="group" aria-label="Terrarium encoder">
                <span className="titiler-endpoint-title">Source</span>
                <div className="titiler-source-static titiler-endpoint-btn titiler-endpoint-btn-active" title={`${baseUrl}\nStart: ${startCommand}`}>
                    {SOURCE.label}
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

export default TerrariumTerrain;

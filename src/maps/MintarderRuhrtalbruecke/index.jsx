import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { OBJLoader } from '@loaders.gl/obj';
import { load } from '@loaders.gl/core';
import { ParquetArrowLoader } from '@loaders.gl/parquet';
import { cartoLightBasemapUrl } from '../basemaps';
import { ColorScaleLegend } from '../../components/MapSymbols/ColorScaleLegend';
import { isTimelineKey } from '../../components/FeatureSpaceChart3D/timelineGeometry';
import { build3dLosArrowLayers } from '../../layers/factory/build3dLosArrowLayers';
import { build3dLosSphereLayer } from '../../layers/factory/build3dLosSphereLayer';
import {
    POLAKY_VEL_AVG_DOMAIN,
    buildPolakyVelAvgScale,
} from '../PolakyHradecV2/velAvgPalette';
import TimelineChart from '../PolakyHradecV2/TimelineChart';

// Values below are copied from the asset sidecar
// build/mintarder_ruhrtalbruecke.json (see 3DFLUS CCN/Mintarder Ruhrtalbrucke).
const ANCHOR = [6.9031544, 51.3799921]; // main-span midpoint, s = 1023 m
const DECK_MIDPOINT = [6.9018349, 51.3794818]; // s = 915 m, used for framing

// The OBJ is in local ENU metres (+X east, +Y north, +Z up) with its origin at
// ANCHOR, so no rotation is needed: getOrientation stays [0, 0, 0].
//
// Local copies live in public/assets/mintarder/ and are served by Vite as-is.
const ASSET_BASE = `${import.meta.env.BASE_URL}assets/mintarder`;
// Deployed alternative, matching the other sandbox assets:
// const ASSET_BASE = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets/mintarder';

// One layer per material split; colours are the manifest `colors` values.
const PARTS = [
    { id: 'deck', file: 'mintarder_deck.obj', color: [111, 116, 124, 255] }, // #6f747c
    { id: 'steel', file: 'mintarder_steel.obj', color: [199, 204, 212, 255] }, // #c7ccd4
    { id: 'concrete', file: 'mintarder_concrete.obj', color: [185, 179, 167, 255] }, // #b9b3a7
    { id: 'guardrails', file: 'mintarder_guardrails.obj', color: [174, 182, 194, 255] }, // #aeb6c2
];

const MATERIAL = {
    ambient: 0.35,
    diffuse: 0.6,
    shininess: 32,
    specularColor: [60, 64, 70],
};

const WIKIPEDIA_URL = 'https://de.wikipedia.org/wiki/Mintarder_Ruhrtalbr%C3%BCcke';
const WIKIPEDIA_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const CARTO_ATTRIBUTION_URL = 'https://carto.com/attributions';

const ATTRIBUTION_LINK_STYLE = {
    color: '#1a4f8a',
    pointerEvents: 'auto',
};

const INITIAL_VIEW_STATE = {
    longitude: DECK_MIDPOINT[0],
    latitude: DECK_MIDPOINT[1],
    zoom: 14.8,
    pitch: 58,
    bearing: 33,
    minZoom: 12,
    maxZoom: 18,
};

// Local high-resolution DEM for the Mintarder valley. The Carto basemap is
// draped over this mesh and the bridge OBJ is offset to the sampled ground.
const TERRAIN_URL =
    'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/Mintander_DEM_cog.tif';
const TERRAIN_OPTIONS = {
    type: 'terrain',
    useChannel: 1,
    noDataValue: 0,
    disableLighting: true,
    useSingleColor: true,
    color: [200, 200, 200, 255],
};

// ---------------------------------------------------------------------------
// InSAR point layer (track 139D)
// ---------------------------------------------------------------------------

// The presigned S3/Ceph GET for the 4,752-point, EPSG:4326 GeoParquet. The
// signature expires 2026-11-29T07:56:33Z; replace the constant (or set
// VITE_MINTARDER_GP_URL at build time) once the link is re-signed.
//
// Checked 2026-11-27: the signed GET returns HTTP 200 / 11,052,623 bytes, but
// the endpoint sends no Access-Control-Allow-Origin header. A direct browser
// fetch is therefore blocked cross-origin. The dev server proxies the same
// object at /insar4ait (see vite.config.js) so the layer is testable locally;
// production keeps the direct URL and needs bucket CORS enabled.
const S3_ORIGIN = 'https://s3.waw4-1.cloudferro.com';
const S3_OBJECT_PATH =
    '/archive/Insar4AIT/PILOT_kart/track_139D/POSTPROC_trefin1/DATA_OUT/mintander_139D_trefin1_final.geoparquet';
const S3_QUERY =
    'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=6cd4729342884acd9caf821f8868a1d9%2F20261127%2Fwaw4-1%2Fs3%2Faws4_request&X-Amz-Date=20261127T075633Z&X-Amz-Expires=172800&X-Amz-SignedHeaders=host&X-Amz-Signature=321a8d2f7e1c81e98ade909a6232f6d49d70192f2df15b7eb6770461184c8d83';

const GEO_PARQUET_S3_URL =
    import.meta.env.VITE_MINTARDER_GP_URL || `${S3_ORIGIN}${S3_OBJECT_PATH}?${S3_QUERY}`;
const GEO_PARQUET_DEV_PROXY_URL = `/insar4ait${S3_OBJECT_PATH}?${S3_QUERY}`;

// ParquetArrowLoader is the WASM-backed loader in @loaders.gl/parquet 4.5.x
// (loader id `parquet-wasm`, worker: false). Point it at the local wasm copy
// used by the other GeoParquet demos instead of the unpkg default.
const PARQUET_WASM_URL = `${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`;

const POINTS_LAYER_PREFIX = 'mintarder-insar';
// Same split as Poláky: |VEL_AVG| <= 0.5 mm/yr renders as a sphere, everything
// else keeps the 3D LOS arrow composite.
const NEAR_ZERO_VEL_AVG = 0.5;
const VEL_AVG_DOMAIN = [...POLAKY_VEL_AVG_DOMAIN];
// Track 139D is descending; Poláky inverts the VEL_AVG ramp for D tracks.
const VEL_AVG_SCALE = buildPolakyVelAvgScale('D');

const MISSING_VELOCITY_COLOR = [128, 128, 128, 255];
// Same selection/hover cyan as Poláky Hradec v2.
const SELECTION_COLOR = [66, 212, 244, 255];

function formatNumber(value, digits = 2) {
    if (value == null || value === '') return '–';
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '–';
}

function clampVelocity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const [min, max] = VEL_AVG_DOMAIN;
    return Math.max(min, Math.min(max, number));
}

function velocityColor(value) {
    const clamped = clampVelocity(value);
    if (clamped == null) return MISSING_VELOCITY_COLOR;
    const [r, g, b] = VEL_AVG_SCALE(clamped).rgb();
    return [r, g, b, 255];
}

// ColorScaleLegend samples a value -> [r, g, b] function.
function velocityLegendColor(value) {
    const clamped = clampVelocity(value);
    const [r, g, b] = VEL_AVG_SCALE(clamped ?? 0).rgb();
    return [r, g, b];
}

// Missing / non-finite VEL_AVG keeps the arrow behaviour in Poláky.
function isNearZeroVelocity(feature) {
    const raw = feature?.properties?.VEL_AVG;
    if (raw == null || raw === '') return false;
    const value = Number(raw);
    return Number.isFinite(value) && Math.abs(value) <= NEAR_ZERO_VEL_AVG;
}

function isPointLayer(layerId) {
    return typeof layerId === 'string' && layerId.startsWith(POINTS_LAYER_PREFIX);
}

function vectorFor(table, name) {
    try {
        return table.getChild(name);
    } catch {
        return null;
    }
}

function numberAt(vector, index) {
    const raw = vector ? vector.get(index) : null;
    if (raw == null || raw === '') return null;
    const number = typeof raw === 'bigint' ? Number(raw) : Number(raw);
    return Number.isFinite(number) ? number : null;
}

// GeoParquet geometry is a geoarrow.point struct {x, y} in this file. LON/LAT
// are preferred, but the geometry field keeps the layer working if they are
// dropped by a future export.
function geometryAt(vector, index) {
    const raw = vector ? vector.get(index) : null;
    if (!raw) return null;
    const lon = Number(raw.x ?? raw[0]);
    const lat = Number(raw.y ?? raw[1]);
    return Number.isFinite(lon) && Number.isFinite(lat) ? [lon, lat] : null;
}

function buildPointFeatures(table) {
    const columns = {
        ID: vectorFor(table, 'ID'),
        LON: vectorFor(table, 'LON'),
        LAT: vectorFor(table, 'LAT'),
        VEL_AVG: vectorFor(table, 'VEL_AVG'),
        VEL_REL: vectorFor(table, 'VEL_REL'),
        REL_LEN: vectorFor(table, 'REL_LEN'),
        VEL_SD: vectorFor(table, 'VEL_SD'),
        H: vectorFor(table, 'H'),
        COH: vectorFor(table, 'COH'),
        ACCEL: vectorFor(table, 'ACCEL'),
        geometry: vectorFor(table, 'geometry'),
    };

    const features = [];
    for (let index = 0; index < table.numRows; index++) {
        const lon = numberAt(columns.LON, index);
        const lat = numberAt(columns.LAT, index);
        const coordinates = lon != null && lat != null
            ? [lon, lat]
            : geometryAt(columns.geometry, index);
        if (!coordinates) continue;

        const height = numberAt(columns.H, index);
        const properties = {
            ID: numberAt(columns.ID, index),
            LON: coordinates[0],
            LAT: coordinates[1],
            VEL_AVG: numberAt(columns.VEL_AVG, index),
            VEL_REL: numberAt(columns.VEL_REL, index),
            REL_LEN: numberAt(columns.REL_LEN, index),
            VEL_SD: numberAt(columns.VEL_SD, index),
            H: height,
            COH: numberAt(columns.COH, index),
            ACCEL: numberAt(columns.ACCEL, index),
        };

        features.push({
            type: 'Feature',
            arrowIndex: index,
            geometry: {
                type: 'Point',
                coordinates: [coordinates[0], coordinates[1], height ?? 0],
            },
            properties,
        });
    }
    return features;
}

function errorMessage(error) {
    if (!error) return 'Unknown error';
    if (typeof error === 'string') return error;
    return error.message || String(error);
}

function sourceLabel(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
}

function describeLoadError(error) {
    const source = sourceLabel(GEO_PARQUET_S3_URL);
    // Keep the presigned query string out of the visible error message.
    const message = errorMessage(error)
        .split(GEO_PARQUET_S3_URL).join(source)
        .split(GEO_PARQUET_DEV_PROXY_URL).join(source);
    const looksLikeCors = /failed to fetch|network\s*error|cors|load failed/i.test(message);
    const corsHint = looksLikeCors
        ? ' The signed S3/Ceph GET returns 200 to curl but the endpoint sends no Access-Control-Allow-Origin, so browsers block the cross-origin read. Enable bucket CORS for this app origin or serve the object same-origin.'
        : '';
    return `Could not load InSAR GeoParquet from ${source}. ${message}${corsHint}`;
}

function MintarderRuhrtalbruecke() {
    const { zRange, onZRangeUpdate } = useTerrainZRange();
    const [status, setStatus] = useState('loading');
    const [error, setError] = useState(null);
    const [retryToken, setRetryToken] = useState(0);
    const [table, setTable] = useState(null);
    const [points, setPoints] = useState([]);
    const [hoveredArrowIndex, setHoveredArrowIndex] = useState(null);
    const [selectedPoint, setSelectedPoint] = useState(null);
    // Drive the 3D arrow/sphere size band; the map still starts from
    // INITIAL_VIEW_STATE.
    const [zoom, setZoom] = useState(INITIAL_VIEW_STATE.zoom);
    // The model/attribution card is collapsed to a single small button so it
    // does not cover the map by default.
    const [infoOpen, setInfoOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;

        setStatus('loading');
        setError(null);
        setTable(null);
        setPoints([]);
        setHoveredArrowIndex(null);
        setSelectedPoint(null);

        const loadOptions = {
            worker: false,
            parquet: { wasmUrl: PARQUET_WASM_URL },
        };

        async function loadArrowTable() {
            try {
                return await load(GEO_PARQUET_S3_URL, ParquetArrowLoader, loadOptions);
            } catch (directError) {
                if (!import.meta.env.DEV) throw directError;

                // The Ceph endpoint does not send CORS headers. Retry through
                // the same-origin dev proxy so local development still works.
                try {
                    return await load(GEO_PARQUET_DEV_PROXY_URL, ParquetArrowLoader, loadOptions);
                } catch (proxyError) {
                    throw new Error(
                        `${errorMessage(directError)}; dev proxy retry also failed: ${errorMessage(proxyError)}`
                    );
                }
            }
        }

        loadArrowTable()
            .then((result) => {
                if (cancelled) return;

                const nextTable = result?.data;
                if (!nextTable || typeof nextTable.numRows !== 'number' || nextTable.numRows === 0) {
                    throw new Error('The parquet response contained no rows.');
                }

                const nextPoints = buildPointFeatures(nextTable);
                if (nextPoints.length === 0) {
                    throw new Error('No valid point coordinates found in LON/LAT or geometry.');
                }

                setTable(nextTable);
                setPoints(nextPoints);
                setStatus('ready');
            })
            .catch((loadError) => {
                if (cancelled) return;
                setStatus('error');
                setError(describeLoadError(loadError));
            });

        return () => {
            cancelled = true;
        };
    }, [retryToken]);

    const timelineColumns = useMemo(() => {
        if (!table) return [];
        return table.schema.fields
            .map((field) => field.name)
            .filter(isTimelineKey)
            .sort()
            .map((name) => ({ name, vector: vectorFor(table, name) }));
    }, [table]);

    const selectedFeature = useMemo(() => {
        if (!table || !selectedPoint) return null;

        const properties = { ...selectedPoint.properties };
        for (const { name, vector } of timelineColumns) {
            const value = numberAt(vector, selectedPoint.arrowIndex);
            if (value != null) properties[name] = value;
        }

        return { ...selectedPoint, properties };
    }, [table, selectedPoint, timelineColumns]);

    const handleHover = useCallback((info) => {
        const next = isPointLayer(info.layer?.id)
            ? (info.object?.arrowIndex ?? null)
            : null;
        setHoveredArrowIndex((previous) => (previous === next ? previous : next));
    }, []);

    const handleClick = useCallback((info) => {
        if (isPointLayer(info.layer?.id) && info.object) {
            setSelectedPoint(info.object);
        } else {
            setSelectedPoint(null);
        }
    }, []);

    const getTooltip = useCallback(({ object, layer }) => {
        if (!isPointLayer(layer?.id) || !object) return null;
        const properties = object.properties ?? {};
        return {
            text: [
                `ID: ${properties.ID ?? '–'}`,
                `VEL_AVG: ${formatNumber(properties.VEL_AVG, 2)} mm/yr`,
                `H: ${formatNumber(properties.H, 2)} m`,
                `COH: ${formatNumber(properties.COH, 2)}`,
            ].join('\n'),
        };
    }, []);

    const terrainLayer = useMemo(
        () =>
            new CogTerrainLayer({
                id: 'terrain-elevation',
                elevationData: TERRAIN_URL,
                isTiled: true,
                tileSize: 256,
                minZoom: 10,
                maxZoom: 15,
                operation: 'terrain+draw',
                onZRangeUpdate,
                pickable: false,
                terrainOptions: TERRAIN_OPTIONS,
            }),
        [onZRangeUpdate]
    );

    // zRange keeps the draped basemap tiles from being frustum-culled in the
    // pitched view; TerrainExtension drapes them onto the DEM mesh.
    const baseMapLayer = useMemo(
        () =>
            new TileLayer({
                id: 'base-map',
                data: cartoLightBasemapUrl,
                minZoom: 0,
                maxZoom: 19,
                tileSize: 256,
                zRange,
                extensions: [new TerrainExtension()],
                renderSubLayers: (props) => {
                    const { west, south, east, north } = props.tile.bbox;
                    return new BitmapLayer(props, {
                        data: null,
                        image: props.data,
                        bounds: [west, south, east, north],
                    });
                },
            }),
        [zRange]
    );

    const bridgeLayers = useMemo(
        () =>
            PARTS.map(
                (part) =>
                    new SimpleMeshLayer({
                        id: `mintarder-${part.id}`,
                        data: [{}],
                        mesh: `${ASSET_BASE}/${part.file}`,
                        loaders: [OBJLoader],
                        // LNGLAT keeps one anchor for the whole rigid mesh, so
                        // TerrainExtension offset samples the DEM at ANCHOR once
                        // instead of warping the deck to the terrain per vertex.
                        coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
                        getPosition: () => [ANCHOR[0], ANCHOR[1], 0],
                        getScale: () => [1, 1, 1],
                        getOrientation: () => [0, 0, 0],
                        getColor: () => part.color,
                        getPolygonOffset: () => [0, 0],
                        material: MATERIAL,
                        // Offset mode lifts the local ENU mesh by the DEM
                        // height sampled under the ANCHOR.
                        extensions: [new TerrainExtension()],
                        terrainDrawMode: 'offset',
                        pickable: false,
                    })
            ),
        []
    );

    // Same Poláky split: |VEL_AVG| <= 0.5 mm/yr -> sphere, everything else ->
    // the seven-part 3D LOS arrow composite.
    const { arrowFeatures, sphereFeatures } = useMemo(() => {
        const arrows = [];
        const spheres = [];
        for (const feature of points) {
            (isNearZeroVelocity(feature) ? spheres : arrows).push(feature);
        }
        return { arrowFeatures: arrows, sphereFeatures: spheres };
    }, [points]);

    const pointSymbolLayers = useMemo(() => {
        if (points.length === 0) return [];

        const selectedArrowIndex = selectedPoint?.arrowIndex ?? null;
        const getSymbolColor = (feature) => {
            if (selectedArrowIndex != null && feature.arrowIndex === selectedArrowIndex) {
                return SELECTION_COLOR;
            }
            if (hoveredArrowIndex != null && feature.arrowIndex === hoveredArrowIndex) {
                return SELECTION_COLOR;
            }
            return velocityColor(feature.properties?.VEL_AVG);
        };
        // The user-facing requirement is explicit: latitude, longitude and the
        // point's H value drive the 3D anchor.
        const getAnchorPosition = (feature) => {
            const properties = feature.properties ?? {};
            const height = Number(properties.H);
            return [
                properties.LON,
                properties.LAT,
                Number.isFinite(height) ? height : 0,
            ];
        };
        const updateTriggers = {
            getColor: [selectedArrowIndex, hoveredArrowIndex],
        };

        return [
            ...build3dLosArrowLayers({
                idPrefix: POINTS_LAYER_PREFIX,
                data: arrowFeatures,
                zoom,
                // 139D is the descending track; Poláky uses the D heading pair.
                orbit: 'D',
                pickable: true,
                getPosition: getAnchorPosition,
                getColor: getSymbolColor,
                updateTriggers,
            }),
            build3dLosSphereLayer({
                id: `${POINTS_LAYER_PREFIX}-spheres`,
                data: sphereFeatures,
                zoom,
                radiusMeters: 1.6,
                pickable: true,
                getPosition: getAnchorPosition,
                getColor: getSymbolColor,
                updateTriggers,
            }),
        ];
    }, [points, arrowFeatures, sphereFeatures, zoom, selectedPoint, hoveredArrowIndex]);

    const layers = useMemo(
        () => [
            terrainLayer,
            baseMapLayer,
            ...bridgeLayers,
            ...pointSymbolLayers,
        ],
        [terrainLayer, baseMapLayer, bridgeLayers, pointSymbolLayers]
    );

    return (
        <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                controller={true}
                onViewStateChange={({ viewState }) => setZoom(viewState.zoom)}
                layers={layers}
                // The 3D symbols are small; widen picking a little so hover/click
                // land reliably.
                pickingRadius={6}
                onHover={handleHover}
                onClick={handleClick}
                getCursor={() => (hoveredArrowIndex != null ? 'pointer' : 'grab')}
                getTooltip={getTooltip}
            />

            {status === 'loading' && (
                <div
                    style={{
                        position: 'absolute',
                        top: 10,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 20,
                        padding: '6px 12px',
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.95)',
                        border: '1px solid #ddd',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                        fontFamily: 'system-ui, sans-serif',
                        fontSize: 11,
                        color: '#333',
                    }}
                >
                    Loading InSAR points from S3…
                </div>
            )}

            {status === 'error' && (
                <div
                    style={{
                        position: 'absolute',
                        top: 10,
                        left: '50%',
                        transform: 'translateX(-50%)',
                        zIndex: 20,
                        maxWidth: 'min(680px, calc(100% - 24px))',
                        padding: '8px 12px',
                        borderRadius: 6,
                        background: 'rgba(255, 255, 255, 0.98)',
                        border: '1px solid #a00000',
                        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.2)',
                        fontFamily: 'system-ui, sans-serif',
                        fontSize: 11,
                        color: '#a00000',
                        pointerEvents: 'auto',
                    }}
                >
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>InSAR layer unavailable</div>
                    <div style={{ lineHeight: 1.45 }}>{error}</div>
                    <button
                        type="button"
                        onClick={() => setRetryToken((token) => token + 1)}
                        style={{
                            marginTop: 6,
                            padding: '3px 10px',
                            border: '1px solid #a00000',
                            borderRadius: 4,
                            background: '#fff',
                            color: '#a00000',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                            fontSize: 11,
                        }}
                    >
                        Retry
                    </button>
                </div>
            )}

            <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, pointerEvents: 'none' }}>
                <ColorScaleLegend
                    colorScale={velocityLegendColor}
                    domain={[VEL_AVG_DOMAIN[0], 0, VEL_AVG_DOMAIN[1]]}
                    title={`VEL_AVG (mm/yr) · 139D${points.length ? ` · ${points.length.toLocaleString()} pts` : ''}`}
                />
            </div>

            <button
                type="button"
                onClick={() => setInfoOpen((open) => !open)}
                aria-expanded={infoOpen}
                aria-controls="mintarder-map-info"
                aria-label={infoOpen ? 'Hide map information' : 'Show map information'}
                title={infoOpen ? 'Hide map information' : 'Show map information'}
                style={{
                    position: 'absolute',
                    bottom: 8,
                    left: 8,
                    zIndex: 12,
                    width: 28,
                    height: 28,
                    padding: 0,
                    borderRadius: '50%',
                    border: '1px solid #bbb',
                    background: 'rgba(255, 255, 255, 0.95)',
                    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)',
                    color: '#1a4f8a',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                }}
            >
                <span
                    style={{
                        fontFamily: infoOpen ? 'system-ui, sans-serif' : 'Georgia, serif',
                        fontStyle: infoOpen ? 'normal' : 'italic',
                        fontWeight: infoOpen ? 400 : 700,
                        fontSize: infoOpen ? 16 : 15,
                    }}
                >
                    {infoOpen ? '×' : 'i'}
                </span>
            </button>

            {infoOpen && (
                <div
                    id="mintarder-map-info"
                    style={{
                        position: 'absolute',
                        bottom: 44,
                        left: 8,
                        zIndex: 11,
                        maxWidth: 560,
                        padding: '4px 7px',
                        borderRadius: 3,
                        background: 'rgba(255, 255, 255, 0.92)',
                        fontFamily: 'system-ui, sans-serif',
                        fontSize: 10,
                        lineHeight: 1.45,
                        color: '#333',
                        pointerEvents: 'none',
                    }}
                >
                <div>
                    Mintarder Ruhrtalbrücke (as-built 1966, A52): 1,830 m · R 3,000 m arc · 27.5 m wide ·
                    18 piers · 126 m main span · 65 m max deck. Simplified LOD mesh (8,684 triangles),
                    not an engineering record.
                </div>
                <div>
                    Terrain: local Mintander DEM COG; the Carto basemap is draped on the
                    mesh and the bridge is offset to the sampled ground.
                </div>
                <div>
                    InSAR: track 139D, 4,752 points ({sphereFeatures.length.toLocaleString()} spheres,{' '}
                    {arrowFeatures.length.toLocaleString()} arrows) — spheres for |VEL_AVG| ≤ 0.5 mm/yr,
                    3D LOS arrows otherwise, anchored at LON / LAT / H. VEL_AVG scale
                    −2.5 → +2.5 mm/yr; the descending (D) ramp is inverted, so red is
                    negative and blue positive. Hover for ID / VEL_AVG / H / COH; click a
                    symbol for its d_* displacement series.
                </div>
                <div>
                    Alignment/anchor data:{' '}
                    <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © OpenStreetMap contributors
                    </a>
                    ,{' '}
                    <a href={ODBL_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        ODbL
                    </a>
                    . Documented dimensions:{' '}
                    <a href={WIKIPEDIA_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        Wikipedia „Mintarder Ruhrtalbrücke”
                    </a>
                    ,{' '}
                    <a href={WIKIPEDIA_LICENSE_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        CC BY-SA
                    </a>
                    .
                </div>
                <div>
                    Basemap:{' '}
                    <a href={CARTO_ATTRIBUTION_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © CARTO
                    </a>
                    ,{' '}
                    <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © OpenStreetMap contributors
                    </a>
                    .
                </div>
                </div>
            )}

            {selectedFeature && (
                <div
                    style={{
                        position: 'absolute',
                        right: 12,
                        bottom: 12,
                        zIndex: 30,
                        width: 460,
                        maxWidth: 'calc(100% - 24px)',
                        height: 'min(320px, calc(100% - 24px))',
                    }}
                >
                    <TimelineChart
                        feature={selectedFeature}
                        trackLabel="139D"
                        onClose={() => setSelectedPoint(null)}
                    />
                </div>
            )}
        </div>
    );
}

export default MintarderRuhrtalbruecke;

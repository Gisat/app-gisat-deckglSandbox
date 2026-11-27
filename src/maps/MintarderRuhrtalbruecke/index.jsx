import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { CogBitmapLayer, CogTerrainLayer } from '@gisatcz/deckgl-geolib';
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
// InSAR point layers (tracks 15A / 37D / 139D)
// ---------------------------------------------------------------------------

// One entry per measurement track. The GeoParquet files carry no orbit
// property, so the orbit (which drives both the arrow heading pair and the
// ascending/descending VEL_AVG ramp) is declared here. Any combination of
// tracks may be visible at once, so point and layer ids are namespaced by
// track id.
const TRACKS = [
    {
        id: '15A',
        direction: 'ascending',
        orbit: 'A',
        url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/mintander/mintander_15A_trefin1_final.geoparquet',
    },
    {
        id: '37D',
        direction: 'descending',
        orbit: 'D',
        url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/mintander/mintander_37D_trefin1_final.geoparquet',
    },
    {
        id: '139D',
        direction: 'descending',
        orbit: 'D',
        url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/mintander/mintander_139D_trefin1_final.geoparquet',
    },
];

// Only 139D is shown on load; the other tracks load lazily on first toggle and
// stay cached afterwards, so re-enabling one never refetches it.
const DEFAULT_VISIBLE_TRACK_IDS = ['139D'];

const trackLabel = (track) => `${track.id} ${track.orbit === 'A' ? '↑' : '↓'}`;

// ParquetArrowLoader is the WASM-backed loader in @loaders.gl/parquet 4.5.x
// (loader id `parquet-wasm`, worker: false). Point it at the local wasm copy
// used by the other GeoParquet demos instead of the unpkg default.
const PARQUET_WASM_URL = `${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`;

const POINTS_LAYER_PREFIX = 'mintarder-insar';
// Same split as Poláky: |VEL_AVG| <= 0.5 mm/yr renders as a sphere, everything
// else keeps the 3D LOS arrow composite.
const NEAR_ZERO_VEL_AVG = 0.5;
const VEL_AVG_DOMAIN = [...POLAKY_VEL_AVG_DOMAIN];
// Ascending tracks keep the blue → red ramp; descending tracks invert it, so a
// given colour reads the same way on every orbit.
const VEL_AVG_SCALES = {
    A: buildPolakyVelAvgScale('A'),
    D: buildPolakyVelAvgScale('D'),
};

const MISSING_VELOCITY_COLOR = [128, 128, 128, 255];
// Same selection/hover cyan as Poláky Hradec v2.
const SELECTION_COLOR = [66, 212, 244, 255];

// Toggle button chrome for the Tracks row, mirroring the 3D chart's
// Timeline/Custom switch in Poláky Hradec v2.
function trackButtonStyle(active, failed = false) {
    return {
        minHeight: 24,
        padding: '4px 8px',
        border: `1px solid ${failed ? '#a00000' : active ? '#0066cc' : '#ccc'}`,
        borderRadius: 4,
        background: active ? '#e6f0ff' : '#fff',
        color: failed ? '#a00000' : '#333',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 11,
        fontWeight: active ? 600 : 400,
    };
}

function parseOptionalNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function clampVelocity(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const [min, max] = VEL_AVG_DOMAIN;
    return Math.max(min, Math.min(max, number));
}

function velocityColor(orbit, value) {
    const clamped = clampVelocity(value);
    if (clamped == null) return MISSING_VELOCITY_COLOR;
    const scale = VEL_AVG_SCALES[orbit] ?? VEL_AVG_SCALES.D;
    const [r, g, b] = scale(clamped).rgb();
    return [r, g, b, 255];
}

// ColorScaleLegend samples a value -> [r, g, b] function.
function velocityLegendColor(orbit, value) {
    const clamped = clampVelocity(value);
    const scale = VEL_AVG_SCALES[orbit] ?? VEL_AVG_SCALES.D;
    const [r, g, b] = scale(clamped ?? 0).rgb();
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

function buildPointFeatures(table, track) {
    const columns = {
        ID: vectorFor(table, 'ID'),
        LON: vectorFor(table, 'LON'),
        LAT: vectorFor(table, 'LAT'),
        VEL_AVG: vectorFor(table, 'VEL_AVG'),
        VEL_REL: vectorFor(table, 'VEL_REL'),
        REL_LEN: vectorFor(table, 'REL_LEN'),
        VEL_SD: vectorFor(table, 'VEL_SD'),
        H: vectorFor(table, 'H'),
        H_REF: vectorFor(table, 'H_REF'),
        COH: vectorFor(table, 'COH'),
        ACCEL: vectorFor(table, 'ACCEL'),
        geometry: vectorFor(table, 'geometry'),
    };
    // The timeline reads the d_YYYYMMDD samples from the feature properties, so
    // they are materialised here and the Arrow table can be released.
    const timelineColumns = table.schema.fields
        .map((field) => field.name)
        .filter(isTimelineKey)
        .map((name) => ({ name, vector: vectorFor(table, name) }));

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
            H_REF: numberAt(columns.H_REF, index),
            COH: numberAt(columns.COH, index),
            ACCEL: numberAt(columns.ACCEL, index),
        };
        for (const { name, vector } of timelineColumns) {
            const value = numberAt(vector, index);
            if (value != null) properties[name] = value;
        }

        features.push({
            type: 'Feature',
            // Selection/hover keys are namespaced by track: point ids repeat
            // across tracks.
            trackId: track.id,
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

function describeLoadError(track, error) {
    const source = sourceLabel(track.url);
    // Keep the full URL out of the visible error message; the origin+path
    // identifies the object without repeating it for every track.
    const message = errorMessage(error).split(track.url).join(source);
    return `Could not load InSAR GeoParquet for track ${track.id} from ${source}. ${message}`;
}

function MintarderRuhrtalbruecke() {
    const { zRange, onZRangeUpdate } = useTerrainZRange();
    // Multi-select: every enabled track is drawn. 139D is on by default; the
    // others are fetched on first enable and cached.
    const [visibleTrackIds, setVisibleTrackIds] = useState(
        () => new Set(DEFAULT_VISIBLE_TRACK_IDS)
    );
    // Per-track cache: id -> { status, features, error }. Late responses for a
    // hidden track land here and never paint the visible layers.
    const [tracks, setTracks] = useState({});
    // In-flight loads live in a ref so deduping does not trigger renders.
    const inFlight = useRef(new Map());
    // Hover/selection are track-scoped because point ids repeat across tracks.
    const [hoveredPoint, setHoveredPoint] = useState(null);
    const [selectedPoint, setSelectedPoint] = useState(null);
    // Drive the 3D arrow/sphere size band; the map still starts from
    // INITIAL_VIEW_STATE.
    const [zoom, setZoom] = useState(INITIAL_VIEW_STATE.zoom);
    // The model/attribution card is collapsed to a single small button so it
    // does not cover the map by default.
    const [infoOpen, setInfoOpen] = useState(false);
    // Height reference for the 3D InSAR symbols. H_REF is relative to the DEM
    // and is the default; H places them at their absolute measured height.
    const [heightMode, setHeightMode] = useState('h_ref');

    // Load one track once and cache its features; re-enabling a ready track is
    // instant and never refetches. Disabling does not abort or evict.
    const loadTrack = useCallback((id) => {
        const track = TRACKS.find((entry) => entry.id === id);
        if (!track || inFlight.current.has(id)) return;

        setTracks((previous) => (previous[id]?.status === 'ready'
            ? previous
            : { ...previous, [id]: { status: 'loading', features: null, error: null } }));

        const controller = new AbortController();
        const promise = (async () => {
            try {
                const result = await load(track.url, ParquetArrowLoader, {
                    worker: false,
                    parquet: { wasmUrl: PARQUET_WASM_URL },
                    fetch: { signal: controller.signal },
                });
                if (controller.signal.aborted) return;

                const table = result?.data;
                if (!table || typeof table.numRows !== 'number' || table.numRows === 0) {
                    throw new Error('The parquet response contained no rows.');
                }

                const features = buildPointFeatures(table, track);
                if (features.length === 0) {
                    throw new Error('No valid point coordinates found in LON/LAT or geometry.');
                }

                setTracks((previous) => ({
                    ...previous,
                    [id]: { status: 'ready', features, error: null },
                }));
            } catch (loadError) {
                // Unmount aborts in flight; not a track failure, no state to set.
                if (controller.signal.aborted) return;
                console.error(`❌ Failed to load Mintarder InSAR track ${id}:`, loadError);
                setTracks((previous) => ({
                    ...previous,
                    [id]: {
                        status: 'error',
                        features: null,
                        error: describeLoadError(track, loadError),
                    },
                }));
            } finally {
                inFlight.current.delete(id);
            }
        })();

        inFlight.current.set(id, { promise, controller });
    }, []);

    useEffect(() => {
        DEFAULT_VISIBLE_TRACK_IDS.forEach((id) => loadTrack(id));
    }, [loadTrack]);

    // Abort any pending track load when the map unmounts.
    useEffect(() => () => {
        for (const { controller } of inFlight.current.values()) controller.abort();
        inFlight.current.clear();
    }, []);

    const visibleTracks = TRACKS.filter((track) => visibleTrackIds.has(track.id));
    const readyTracks = visibleTracks.filter((track) => tracks[track.id]?.status === 'ready');
    const failedTracks = visibleTracks.filter((track) => tracks[track.id]?.status === 'error');
    const loadingTracks = visibleTracks.filter(
        (track) => !tracks[track.id] || tracks[track.id].status === 'loading'
    );

    const handleToggleTrack = useCallback((id) => {
        const state = tracks[id];
        if (visibleTrackIds.has(id)) {
            // A failed, still-enabled track is retried by clicking it again; an
            // error is the only state where the click does not hide the track.
            if (state?.status === 'error') {
                loadTrack(id);
                return;
            }
            setVisibleTrackIds((previous) => {
                const next = new Set(previous);
                next.delete(id);
                return next;
            });
            setHoveredPoint((previous) => (previous?.trackId === id ? null : previous));
            setSelectedPoint((previous) => (previous?.trackId === id ? null : previous));
            return;
        }

        setVisibleTrackIds((previous) => {
            const next = new Set(previous);
            next.add(id);
            return next;
        });
        if (state?.status !== 'ready') loadTrack(id);
    }, [visibleTrackIds, tracks, loadTrack]);

    // Selection carries its track already; the timeline reads the d_* samples
    // materialised at load time, so no Arrow table lookup is needed.
    const selectedFeature = selectedPoint;

    const handleHover = useCallback((info) => {
        const next = isPointLayer(info.layer?.id) && info.object
            ? { trackId: info.object.trackId, arrowIndex: info.object.arrowIndex }
            : null;
        setHoveredPoint((previous) => {
            if (!previous && !next) return previous;
            if (previous && next
                && previous.trackId === next.trackId
                && previous.arrowIndex === next.arrowIndex) {
                return previous;
            }
            return next;
        });
    }, []);

    const handleClick = useCallback((info) => {
        if (isPointLayer(info.layer?.id) && info.object) {
            setSelectedPoint(info.object);
        } else {
            setSelectedPoint(null);
        }
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
                // Glaze mode: the basemap and relief mask provide the visible
                // surface; the terrain pass only writes the height map.
                operation: 'terrain',
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

    // On-the-fly Swiss relief glaze: a transparent kernel-derived shade mask
    // composited over the draped basemap. Same options as the sandbox's
    // CogTerrainKernel/Tabqa glaze modes; clamped to the DEM mesh.
    const reliefGlazeLayer = useMemo(
        () =>
            new CogBitmapLayer({
                id: 'relief-glaze-overlay',
                rasterData: TERRAIN_URL,
                isTiled: true,
                tileSize: 256,
                minZoom: 10,
                maxZoom: 15,
                zRange,
                clampToTerrain: true,
                extensions: [new TerrainExtension()],
                cogBitmapOptions: {
                    type: 'image',
                    useReliefGlaze: true,
                    noDataValue: 0,
                    useChannel: 1,
                    swissSlopeWeight: 0.3,
                    zFactor: 10,
                    maxGlazeAlpha: 80,
                },
            }),
        // Recreate after the terrain height map is available so the clamped
        // relief overlay picks up the DEM instead of staying at z=0.
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
                        // Re-run once the terrain height map is available.
                        updateTriggers: { getPosition: [zRange] },
                        // Offset mode lifts the local ENU mesh by the DEM
                        // height sampled under the ANCHOR.
                        extensions: [new TerrainExtension()],
                        terrainDrawMode: 'offset',
                        pickable: false,
                    })
            ),
        // Same reason as the glaze overlay: re-apply the terrain offset once
        // the height map exists.
        [zRange]
    );

    // Same Poláky split, done once per ready track: |VEL_AVG| <= 0.5 mm/yr ->
    // sphere, everything else -> the seven-part 3D LOS arrow composite. The
    // split is cached against the track's feature array, so loading another
    // track does not recreate this track's data references and make deck.gl
    // re-upload its attributes.
    const symbolCache = useRef(new WeakMap());
    const trackSymbols = useMemo(() => {
        const symbols = {};
        for (const track of TRACKS) {
            const state = tracks[track.id];
            if (state?.status !== 'ready') continue;
            let split = symbolCache.current.get(state.features);
            if (!split) {
                const arrows = [];
                const spheres = [];
                for (const feature of state.features) {
                    (isNearZeroVelocity(feature) ? spheres : arrows).push(feature);
                }
                split = { arrows, spheres };
                symbolCache.current.set(state.features, split);
            }
            symbols[track.id] = split;
        }
        return symbols;
    }, [tracks]);

    const pointSymbolLayers = useMemo(() => {
        const selectedTrackId = selectedPoint?.trackId ?? null;
        const selectedArrowIndex = selectedPoint?.arrowIndex ?? null;
        const hoveredTrackId = hoveredPoint?.trackId ?? null;
        const hoveredArrowIndex = hoveredPoint?.arrowIndex ?? null;

        const useTerrainOffset = heightMode === 'h_ref';
        // Extensions cannot be reliably added/removed on an existing layer id.
        // Give each height mode its own ids so switching remounts the layers
        // with/without TerrainExtension instead of reusing stale state.
        const terrainOffsetProps = useTerrainOffset
            ? {
                // Offset mode lifts each symbol by the DEM height at its own
                // lon/lat, then H_REF is the height above that ground.
                extensions: [new TerrainExtension()],
                terrainDrawMode: 'offset',
            }
            : {};
        // H_REF is measured above the local ground; H is absolute. Fall back
        // to the other value when the selected one is missing. Height mode is
        // global: it applies to every visible track.
        const getAnchorPosition = (feature) => {
            const properties = feature.properties ?? {};
            const primary = parseOptionalNumber(properties[useTerrainOffset ? 'H_REF' : 'H']);
            const fallback = parseOptionalNumber(properties[useTerrainOffset ? 'H' : 'H_REF']);
            const height = primary ?? fallback ?? 0;
            return [properties.LON, properties.LAT, height];
        };

        const symbolLayers = [];
        for (const track of TRACKS) {
            if (!visibleTrackIds.has(track.id)) continue;
            const state = tracks[track.id];
            const symbols = trackSymbols[track.id];
            if (state?.status !== 'ready' || !symbols) continue;

            // Track-scoped highlight: only this track's matching point lights
            // up, even when other tracks share the same arrowIndex.
            const getSymbolColor = (feature) => {
                const isSelected = selectedArrowIndex != null
                    && selectedTrackId === track.id
                    && feature.arrowIndex === selectedArrowIndex;
                const isHovered = hoveredArrowIndex != null
                    && hoveredTrackId === track.id
                    && feature.arrowIndex === hoveredArrowIndex;
                if (isSelected || isHovered) return SELECTION_COLOR;
                return velocityColor(track.orbit, feature.properties?.VEL_AVG);
            };
            const updateTriggers = {
                getColor: [selectedTrackId, selectedArrowIndex, hoveredTrackId, hoveredArrowIndex],
                // Force the anchors to re-evaluate when the DEM height map arrives.
                getPosition: [zRange],
            };
            const pointLayerPrefix = `${POINTS_LAYER_PREFIX}-${track.id}-${heightMode}`;

            symbolLayers.push(
                ...build3dLosArrowLayers({
                    idPrefix: pointLayerPrefix,
                    data: symbols.arrows,
                    zoom,
                    orbit: track.orbit,
                    pickable: true,
                    getPosition: getAnchorPosition,
                    ...terrainOffsetProps,
                    getColor: getSymbolColor,
                    updateTriggers,
                }),
                build3dLosSphereLayer({
                    id: `${pointLayerPrefix}-spheres`,
                    data: symbols.spheres,
                    zoom,
                    radiusMeters: 1.6,
                    pickable: true,
                    getPosition: getAnchorPosition,
                    ...terrainOffsetProps,
                    getColor: getSymbolColor,
                    updateTriggers,
                })
            );
        }
        return symbolLayers;
    }, [tracks, trackSymbols, visibleTrackIds, zoom, selectedPoint, hoveredPoint, heightMode, zRange]);

    // Legend groups: one gradient per orbit present among the visible ready
    // tracks, with aggregate point counts.
    const legendGroups = useMemo(() => {
        const groups = [];
        for (const orbit of ['A', 'D']) {
            const groupTracks = TRACKS.filter(
                (track) => track.orbit === orbit
                    && visibleTrackIds.has(track.id)
                    && tracks[track.id]?.status === 'ready'
            );
            if (groupTracks.length === 0) continue;
            const points = groupTracks.reduce(
                (total, track) => total + tracks[track.id].features.length,
                0
            );
            groups.push({ orbit, ids: groupTracks.map((track) => track.id), points });
        }
        return groups;
    }, [tracks, visibleTrackIds]);

    // Per-track counts for the info card.
    const readyTrackSummaries = useMemo(
        () => readyTracks.map((track) => ({
            id: track.id,
            points: tracks[track.id].features.length,
            spheres: trackSymbols[track.id]?.spheres.length ?? 0,
            arrows: trackSymbols[track.id]?.arrows.length ?? 0,
        })),
        [readyTracks, tracks, trackSymbols]
    );

    const layers = useMemo(
        () => [
            terrainLayer,
            baseMapLayer,
            reliefGlazeLayer,
            ...bridgeLayers,
            ...pointSymbolLayers,
        ],
        [terrainLayer, baseMapLayer, reliefGlazeLayer, bridgeLayers, pointSymbolLayers]
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
                getCursor={() => (hoveredPoint != null ? 'pointer' : 'grab')}
            />

            <div
                style={{
                    position: 'absolute',
                    top: 12,
                    left: 12,
                    zIndex: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 6,
                    background: 'rgba(255, 255, 255, 0.95)',
                    border: '1px solid #ddd',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: 11,
                    color: '#333',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <label
                        htmlFor="mintarder-height-mode"
                        style={{ fontSize: 11, color: '#555', whiteSpace: 'nowrap' }}
                    >
                        Point height
                    </label>
                    <select
                        id="mintarder-height-mode"
                        value={heightMode}
                        onChange={(event) => setHeightMode(event.target.value)}
                        style={{
                            padding: '3px 6px',
                            border: '1px solid #bbb',
                            borderRadius: 4,
                            background: '#fff',
                            color: '#333',
                            fontFamily: 'inherit',
                            fontSize: 11,
                            cursor: 'pointer',
                        }}
                    >
                        <option value="h_ref">H_REF (above DEM)</option>
                        <option value="h">H (absolute)</option>
                    </select>
                </div>

                <div>
                    <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>Tracks</div>
                    <div
                        role="group"
                        aria-label="InSAR tracks"
                        style={{ display: 'flex', gap: 4 }}
                    >
                        {TRACKS.map((track) => {
                            const state = tracks[track.id];
                            const isActive = visibleTrackIds.has(track.id);
                            const isTrackLoading = isActive && state?.status === 'loading';
                            const hasFailed = isActive && state?.status === 'error';
                            return (
                                <button
                                    key={track.id}
                                    type="button"
                                    onClick={() => handleToggleTrack(track.id)}
                                    aria-pressed={isActive}
                                    aria-busy={isTrackLoading || undefined}
                                    title={hasFailed
                                        ? `${track.id} (${track.direction}) failed to load: ${state.error} Click to retry.`
                                        : `${track.id} (${track.direction})`}
                                    style={trackButtonStyle(isActive, hasFailed)}
                                >
                                    {trackLabel(track)}
                                    {isTrackLoading ? ' …' : ''}
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>

            {visibleTracks.length > 0 && loadingTracks.length === visibleTracks.length && (
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
                    Loading InSAR points ({loadingTracks.map((track) => track.id).join(', ')})…
                </div>
            )}

            {failedTracks.length > 0 && (
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
                    {failedTracks.map((track) => (
                        <div key={track.id} style={{ lineHeight: 1.45 }}>
                            {tracks[track.id].error}
                        </div>
                    ))}
                    <button
                        type="button"
                        onClick={() => failedTracks.forEach((track) => loadTrack(track.id))}
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
                        Retry failed
                    </button>
                </div>
            )}

            {legendGroups.length > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        right: 12,
                        zIndex: 10,
                        pointerEvents: 'none',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                    }}
                >
                    {legendGroups.map((group) => (
                        <ColorScaleLegend
                            key={group.orbit}
                            colorScale={(value) => velocityLegendColor(group.orbit, value)}
                            domain={[VEL_AVG_DOMAIN[0], 0, VEL_AVG_DOMAIN[1]]}
                            title={`VEL_AVG ${group.orbit} (mm/yr) · ${group.ids.join(', ')} · ${group.points.toLocaleString()} pts`}
                        />
                    ))}
                </div>
            )}

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
                    mesh with an on-the-fly Swiss relief glaze, and the bridge is offset
                    to the sampled ground.
                </div>
                <div>
                    InSAR:{' '}
                    {readyTrackSummaries.length === 0
                        ? 'no tracks loaded'
                        : readyTrackSummaries.map((summary, index) => (
                            <span key={summary.id}>
                                {index > 0 ? ', ' : ''}
                                {summary.id} ({summary.points.toLocaleString()} pts:{' '}
                                {summary.spheres.toLocaleString()} spheres,{' '}
                                {summary.arrows.toLocaleString()} arrows)
                            </span>
                        ))}
                    {' '}— spheres for |VEL_AVG| ≤ 0.5 mm/yr, 3D LOS arrows
                    otherwise, anchored at{' '}
                    {heightMode === 'h_ref' ? 'H_REF above the DEM' : 'absolute H'}.
                    VEL_AVG scale −2.5 → +2.5 mm/yr; ascending (A) tracks run blue →
                    red and descending (D) tracks are inverted (red → blue). Toggle
                    tracks in the top-left Tracks row; click a symbol for its d_*
                    displacement series.
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
                        trackLabel={selectedFeature.trackId}
                        onClose={() => setSelectedPoint(null)}
                    />
                </div>
            )}
        </div>
    );
}

export default MintarderRuhrtalbruecke;

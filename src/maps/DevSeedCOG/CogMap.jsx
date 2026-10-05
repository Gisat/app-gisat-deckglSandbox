import { useState, useCallback, useRef, useEffect } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import {
    Colormap,
    CreateTexture,
    FilterNoDataVal,
    LinearRescale,
    COLORMAP_INDEX,
    createColormapTexture,
    decodeColormapSprite,
} from '@developmentseed/deck.gl-raster/gpu-modules';
import colormapsPngUrl from '@developmentseed/deck.gl-raster/gpu-modules/colormaps.png';
import { CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import chroma from 'chroma-js';
import { cartoLightBasemapUrl } from '../basemaps';

const RASTER_BASE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters';
const PRECOLORED_COG_URL = `${RASTER_BASE_URL}/ndviMAX_2025_11_blues_cog.tif`;
const COLORMAPPED_COG_URL = `${RASTER_BASE_URL}/ndviMAX_2025_11_cog_not_weboptimized.tif`;
const COGBITMAP_COG_URL = `${RASTER_BASE_URL}/COG_ndviMAX_2021_11.tif`;

const INITIAL_VIEW_STATE = {
    longitude: 0,
    latitude: 0,
    zoom: 2,
    bearing: 0,
    pitch: 0,
};

const NDVI_NODATA = -32768;
const NDVI_RESCALE_MIN = -6000;
const NDVI_RESCALE_MAX = 10000;

const DEFAULT_COLORMAP = 'viridis';
const COLORMAP_NAMES = [
    'viridis',
    'blues',
    'reds',
    'greens',
    'magma',
    'inferno',
    'plasma',
    'turbo',
    'spectral',
    'terrain',
    'ylgn',
    'rdylgn',
];

const NEAREST_SAMPLER = { minFilter: 'nearest', magFilter: 'nearest' };

const SetAlpha1 = {
    name: 'set-alpha-1',
    inject: {
        'fs:DECKGL_FILTER_COLOR': 'color = vec4(color.rgb, 1.0);',
    },
};

const toFloat32 = (values) => (values instanceof Float32Array ? values : Float32Array.from(values));

function toRgba8(data, width, height) {
    const pixelCount = width * height;
    if (data.length === pixelCount * 4) return data;
    if (data.length !== pixelCount * 3) {
        throw new Error(`Expected 3 or 4 samples per pixel, got ${data.length / pixelCount}`);
    }
    const rgba = new Uint8Array(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        rgba[i * 4] = data[i * 3];
        rgba[i * 4 + 1] = data[i * 3 + 1];
        rgba[i * 4 + 2] = data[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

async function getTileArray(image, { x, y, signal, pool }) {
    const tile = await image.fetchTile(x, y, { signal, pool, boundless: false });
    const { array } = tile;
    if (array.layout === 'band-separate') {
        throw new Error('Expected a pixel-interleaved COG');
    }
    return array;
}

function createNearestTexture(device, data, format, width, height, convert) {
    return device.createTexture({
        data: convert ? convert(data) : data,
        format,
        width,
        height,
        sampler: NEAREST_SAMPLER,
    });
}

async function precoloredGetTileData(image, options) {
    const { data, width, height } = await getTileArray(image, options);
    const texture = createNearestTexture(
        options.device,
        data,
        'rgba8unorm',
        width,
        height,
        (values) => toRgba8(values, width, height),
    );
    return { texture, width, height };
}

function precoloredRenderTile({ texture }) {
    return {
        renderPipeline: [
            { module: CreateTexture, props: { textureName: texture } },
        ],
    };
}

async function colormappedGetTileData(image, options) {
    const { data, width, height } = await getTileArray(image, options);
    const texture = createNearestTexture(options.device, data, 'r32float', width, height, toFloat32);
    return { texture, width, height };
}

const destroyTileTexture = (tile) => tile.content?.texture.destroy();

const overlayStyle = {
    position: 'fixed',
    zIndex: 9999,
    top: 20,
    right: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    pointerEvents: 'auto',
    fontFamily: 'sans-serif',
    fontSize: 14,
    color: '#333',
};

const panelStyle = {
    background: 'white',
    padding: 15,
    borderRadius: 4,
    boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
};

const panelTitleStyle = { display: 'block', marginBottom: 8, fontWeight: 'bold' };

const checkboxLabelStyle = { display: 'block', marginBottom: 4, cursor: 'pointer' };

function CogMap() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [showCogBitmapLayer, setShowCogBitmapLayer] = useState(true);
    const [showPrecoloredLayer, setShowPrecoloredLayer] = useState(true);
    const [showColormappedLayer, setShowColormappedLayer] = useState(true);
    const [device, setDevice] = useState(null);
    const [colormapImage, setColormapImage] = useState(null);
    const [colormapTexture, setColormapTexture] = useState(null);
    const [colormapName, setColormapName] = useState(DEFAULT_COLORMAP);
    const hasFittedBounds = useRef(false);

    const onCogLoad = useCallback((_geotiff, { geographicBounds }) => {
        if (hasFittedBounds.current) return;
        hasFittedBounds.current = true;
        const { west, south, east, north } = geographicBounds;
        setViewState((currentViewState) => {
            const viewport = new WebMercatorViewport({
                ...currentViewState,
                width: window.innerWidth,
                height: window.innerHeight,
            });
            return {
                ...currentViewState,
                ...viewport.fitBounds([[west, south], [east, north]], { padding: 40 }),
            };
        });
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const response = await fetch(colormapsPngUrl);
            const bytes = await response.arrayBuffer();
            const image = await decodeColormapSprite(bytes);
            if (!cancelled) setColormapImage(image);
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!device || !colormapImage) return undefined;
        const texture = createColormapTexture(device, colormapImage);
        setColormapTexture(texture);
        return () => {
            texture.destroy();
        };
    }, [device, colormapImage]);

    const colormappedRenderTile = useCallback(({ texture }) => {
        if (!colormapTexture) return null;
        return {
            renderPipeline: [
                { module: CreateTexture, props: { textureName: texture } },
                { module: FilterNoDataVal, props: { value: NDVI_NODATA } },
                { module: LinearRescale, props: { rescaleMin: NDVI_RESCALE_MIN, rescaleMax: NDVI_RESCALE_MAX } },
                {
                    module: Colormap,
                    props: {
                        colormapTexture,
                        colormapIndex: COLORMAP_INDEX[colormapName],
                    },
                },
                { module: SetAlpha1 },
            ],
        };
    }, [colormapTexture, colormapName]);

    const basemapLayer = new TileLayer({
        id: 'base-map',
        data: cartoLightBasemapUrl,
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,
        renderSubLayers: (props) => {
            const { west, south, east, north } = props.tile.bbox;
            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [west, south, east, north],
            });
        },
    });

    const cogBitmapLayer = new CogBitmapLayer({
        id: 'cog-bitmap-layer',
        rasterData: COGBITMAP_COG_URL,
        isTiled: true,
        cogBitmapOptions: {
            type: 'image',
            blurredTexture: false,
            useChannel: 1,
            useHeatMap: true,
            colorScale: chroma.brewer.Reds,
            colorScaleValueRange: [-5000, 9000],
        },
    });

    const precoloredCogLayer = new COGLayer({
        id: 'cog-precolored',
        geotiff: PRECOLORED_COG_URL,
        getTileData: precoloredGetTileData,
        renderTile: precoloredRenderTile,
        onGeoTIFFLoad: onCogLoad,
        onTileUnload: destroyTileTexture,
    });

    const colormappedCogLayer = colormapTexture
        ? new COGLayer({
            id: 'cog-colormapped',
            geotiff: COLORMAPPED_COG_URL,
            getTileData: colormappedGetTileData,
            renderTile: colormappedRenderTile,
            updateTriggers: { renderTile: [colormapName, colormapTexture] },
            onTileUnload: destroyTileTexture,
        })
        : null;

    const layers = [
        basemapLayer,
        ...(showColormappedLayer && colormappedCogLayer ? [colormappedCogLayer] : []),
        ...(showPrecoloredLayer ? [precoloredCogLayer] : []),
        ...(showCogBitmapLayer ? [cogBitmapLayer] : []),
    ];

    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={({ viewState: nextViewState }) => setViewState(nextViewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
                onDeviceInitialized={setDevice}
                style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}
            >
                <div style={overlayStyle}>
                    <div style={panelStyle}>
                        <div style={panelTitleStyle}>Layers</div>
                        <label style={checkboxLabelStyle}>
                            <input
                                type="checkbox"
                                checked={showCogBitmapLayer}
                                onChange={(e) => setShowCogBitmapLayer(e.target.checked)}
                                style={{ marginRight: 6 }}
                            />
                            CogBitmapLayer
                        </label>
                        <label style={checkboxLabelStyle}>
                            <input
                                type="checkbox"
                                checked={showPrecoloredLayer}
                                onChange={(e) => setShowPrecoloredLayer(e.target.checked)}
                                style={{ marginRight: 6 }}
                            />
                            COGLayer (precolored blue)
                        </label>
                        <label style={{ ...checkboxLabelStyle, marginBottom: 0 }}>
                            <input
                                type="checkbox"
                                checked={showColormappedLayer}
                                onChange={(e) => setShowColormappedLayer(e.target.checked)}
                                style={{ marginRight: 6 }}
                            />
                            COGLayer (colormapped)
                        </label>
                    </div>
                    <div style={panelStyle}>
                        <label htmlFor="colormap-select" style={panelTitleStyle}>Colormap</label>
                        <select
                            id="colormap-select"
                            value={colormapName}
                            onChange={(e) => setColormapName(e.target.value)}
                            style={{ width: '100%', padding: 4 }}
                        >
                            {COLORMAP_NAMES.map((name) => (
                                <option key={name} value={name}>{name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            </DeckGL>
        </div>
    );
}

export default CogMap;

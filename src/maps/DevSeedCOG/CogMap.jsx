import React, { useState, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import { toProj4 } from 'geotiff-geokeys-to-proj4';
import proj4 from 'proj4';
import {CogBitmapLayer} from "@gisatcz/deckgl-geolib";
import chroma from "chroma-js";

const INITIAL_VIEW_STATE = {
    longitude: 0,
    latitude: 0,
    zoom: 2,
    bearing: 0,
    pitch: 0,
};

const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/ndviMAX_2025_11_blues_cog.tif';

async function geoKeysParser(geoKeys) {
  const projDefinition = toProj4(geoKeys);
  return {
    def: projDefinition.proj4,
    parsed: proj4(projDefinition.proj4),
    coordinatesUnits: 'meters',
  };
}

function CogMap() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [textureFilter, setTextureFilter] = useState('nearest'); // 'nearest' or 'linear'

    const onCogLoad = useCallback((tiff, options) => {
        const { west, south, east, north } = options.geographicBounds;
        setViewState(currentViewState => {
            const viewport = new WebMercatorViewport({ ...currentViewState, width: window.innerWidth, height: window.innerHeight });
            const newViewState = viewport.fitBounds(
                [[west, south], [east, north]],
                { padding: 40 }
            );
            return { ...currentViewState, ...newViewState };
        });
    }, []);

    // The Custom Loader: Focuses ONLY on passing the filter
    const getTileData = useCallback(async (image, { device, signal, pool, window }) => {
        // 1. Load the data (standard way)
        const rasterData = await image.readRasters({ signal, pool, window, interleave: true });

        // 2. Format the data for GPU (Boilerplate helper, see bottom of file)
        const { data, format } = prepareDataForGPU(rasterData, image.getSamplesPerPixel());

        // 3. Create Texture with YOUR Custom Filter
        const texture = device.createTexture({
            data: data,
            width: rasterData.width,
            height: rasterData.height,
            format: format,
            sampler: {
                minFilter: textureFilter, // <--- THIS IS THE KEY CONTROL
                magFilter: textureFilter,
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge'
            }
        });

        return { texture, width: rasterData.width, height: rasterData.height };
    }, [textureFilter]);

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
        new COGLayer({
            id: 'cog-layer',
            geotiff: COG_URL,
            geoKeysParser,
            onGeoTIFFLoad: onCogLoad,

            // Pass the custom loader
            getTileData: getTileData,
            updateTriggers: {
                getTileData: [textureFilter] // Re-run when filter changes
            }
        }),
        new CogBitmapLayer({
            id: 'cog-bitmap-layer',
            rasterData: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/COG_ndviMAX_2021_11.tif',
            isTiled: true,
            cogBitmapOptions: {
                type: 'image',
                blurredTexture: false,
                useChannel: 1,
                useHeatMap: true,
                colorScale: chroma.brewer.Reds,
                colorScaleValueRange: [-5000, 9000],
            }
        })
    ];

    // Important: Use 100vw/100vh to ensure the map is visible
    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
            />
        </div>
    );
}

// --- HELPER: Mandatory GPU Format Plumbing ---
// This is not "coloring" logic; it is just ensuring the data
// shape matches what WebGL requires (e.g. 4 channels for RGB).
function prepareDataForGPU(rasterData, samples) {
    let data = rasterData;
    let format = 'rgba8unorm';
    console.log(rasterData, samples)

    if (rasterData instanceof Float32Array) {
        // For NDVI/Elevation data
        format = samples === 1 ? 'r32float' : 'rgba32float';
    } else if (samples === 3) {
        // RGB -> RGBA conversion (Required by WebGL)
        const count = rasterData.width * rasterData.height;
        const newData = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
            newData[i * 4 + 0] = rasterData[i * 3 + 0];
            newData[i * 4 + 1] = rasterData[i * 3 + 1];
            newData[i * 4 + 2] = rasterData[i * 3 + 2];
            newData[i * 4 + 3] = 255;
        }
        data = newData;
    }
    return { data, format };
}

export default CogMap;

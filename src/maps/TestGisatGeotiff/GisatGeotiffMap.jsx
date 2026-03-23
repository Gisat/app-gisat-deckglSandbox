/* eslint-disable react/prop-types */
import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { CogBitmapLayer, CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import chroma from 'chroma-js';

function getRawValuesAtUv(info) {
    const uv = info.uv || (info.bitmap && info.bitmap.uv);
    if (!info.tile?.content?.raw || !uv) return null;
    const { raw, width, height } = info.tile.content;
    const [u, v] = uv;
    const x = Math.floor(u * width);
    const y = Math.floor(v * height);
    const channels = raw.length / (width * height);
    const pixelIndex = Math.floor((y * width + x) * channels);
    return Array.from(raw.slice(pixelIndex, pixelIndex + channels));
}

const INITIAL_VIEW_STATE = {
    longitude: 20,
    latitude: 0,
    zoom: 3,
    pitch: 0,
    bearing: 0
};
const GisatGeotiffMap = () => {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

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
        new CogBitmapLayer({
            id: 'cog-bitmap-layer',
            rasterData: 'https://eu-central-1.linodeobjects.com/gisat-data/LUISA_GST-66/app-esaLuisa/prod/v3/rasters/continental/hanpp_harv/openEO_2019-01-01Z_cog.tif',
            // rasterData: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/merged_cog.tif',
            isTiled: true,
            pickable: true,
            onClick: (info) => {
                const values = getRawValuesAtUv(info);
                if (values !== null) console.log('Raw COG values at click (all bands):', values);
            },
            cogBitmapOptions: {
                type: 'image',
                // blurredTexture: false,
                useChannel: 1,
                // useHeatMap: true,
                // colorScale: chroma.brewer.Reds,
                // colorScaleValueRange: [-5000, 9000],
            }
        }),
        // new CogTerrainLayer({
        //     id: 'cog-bitmap-layer',
        //     rasterData: 'https://eu-central-1.linodeobjects.com/gisat-gis/3dflus/COG_ndviMAX_2021_11.tif',
        //     isTiled: true,
        //     cogBitmapOptions: {
        //         type: 'image',
        //         blurredTexture: false,
        //         useChannel: 1,
        //         useHeatMap: true,
        //         colorScale: chroma.brewer.Reds,
        //         colorScaleValueRange: [-5000, 9000],
        //     }
        // })
    ];

    return (
        <DeckGL
            getCursor={() => 'crosshair'}
            viewState={viewState}
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            controller={true}
            layers={layers}
            views={new MapView({ repeat: true })}
            getTooltip={(info) => {
                const values = getRawValuesAtUv(info);
                return values !== null ? { text: `Value: ${values[0].toFixed(2)}` } : null;
            }}
            style={{ width: '100vw', height: '100vh' }} // Ensure it takes full screen
        />
    );
};

export default GisatGeotiffMap;

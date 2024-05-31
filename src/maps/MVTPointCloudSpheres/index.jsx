// src/maps/MapApp1.jsx
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { MVTLayer } from "@deck.gl/geo-layers";
import { PointCloudLayer } from '@deck.gl/layers';
import geolib from "@gisatcz/deckgl-geolib";
import chroma from "chroma-js";
import { scaleLinear } from 'd3-scale';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';

const CogTerrainLayer = geolib.CogTerrainLayer;

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const sphereSizeScale = scaleLinear([0.45, 1], [1, 10]);


const INITIAL_VIEW_STATE = {
    longitude: 14.015511800867504,
    latitude: 50.571906640192161,
    zoom: 13,
    pitch: 0,
    bearing: 0,
};

const layers = [
    new CogTerrainLayer({
        id: 'CogTerrainLayerD8Dem',
        elevationData:  'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/LITC52_53_4g_5m_4326_cog_nodata.tif',
        minZoom: 12,
        maxZoom: 14,
        opacity: 1,
        isTiled: true,
        useChannel: null,
        tileSize: 256,
        meshMaxError: 5,
        operation: 'terrain+draw',
        terrainOptions: {
            type: 'terrain',
            multiplier: 1,
            terrainSkirtHeight: 1,
        }
    }),
    new TileLayer({
        data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        id: 'standard-tile-layer',
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,

        renderSubLayers: (props) => {
            const {
                bbox: {
                    west, south, east, north,
                },
            } = props.tile;

            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [west, south, east, north],
            });
        },
    }),
    new MVTLayer({
        // data ascending
        data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_ASC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
        // data descending
        // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
        binary: false,
        renderSubLayers: (props) => {
            if (props.data) {
                return new PointCloudLayer({
                    ...props,
                    id: `${props.id}-sphere`,
                    pickable: false,
                    sizeUnits: 'meters',
                    pointSize: 7,
                    // dve varianty vysek 'h' a 'h_dtm' podle H.Kolomaznika se to musi otestovat co bude vypadat lepe
                    // getPosition: (d) => [...d.geometry.coordinates, d.properties.h],
                    getPosition: (d) => [...d.geometry.coordinates, d.properties.h_dtm + 5],
                    getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
                });
            }
            return null;
        },
        minZoom: 8,
        maxZoom: 14,
    }),
    // new SimpleMeshLayer({
    //     data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_selected_arrows.geojson',
    //     id: 'sphere-mesh',
    //     mesh: new SphereGeometry(),
    //     getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    //     getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
    //     getPosition: (d) => d.geometry.coordinates,
    //     getTranslation: [0,0,100],
    //     pickable: true,
    // })
]
function MapApp1() {
    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layers}
            className="deckgl-map"
        >
        </DeckGL>
    );
}

export default MapApp1;

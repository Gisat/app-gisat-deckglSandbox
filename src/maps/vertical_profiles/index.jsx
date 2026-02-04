// src/maps/MapApp1.jsx
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { MVTLayer } from "@deck.gl/geo-layers";
import { PointCloudLayer } from '@deck.gl/layers';
import chroma from "chroma-js";
import { scaleLinear } from 'd3-scale';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import {COORDINATE_SYSTEM} from '@deck.gl/core';
import { CogTerrainLayer } from "@gisatcz/deckgl-geolib";

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const sphereSizeScale = scaleLinear([0.45, 1], [2, 9]).clamp(true);

function getVerticalProfileBounds(
    leftX,
    leftY,
    rightX,
    rightY,
    leftProfileHeight,
    profileHeight,
    imageHeight
) {
    const heightAboveProfile = imageHeight ? imageHeight - profileHeight : 0;
    return [
        [leftX, leftY, leftProfileHeight - profileHeight],
        [leftX, leftY, leftProfileHeight + heightAboveProfile],
        [rightX, rightY, leftProfileHeight + heightAboveProfile],
        [rightX, rightY, leftProfileHeight - profileHeight],
    ];
}

const INITIAL_VIEW_STATE = {
    longitude: 14.015511800867504,
    latitude: 50.571906640192161,
    zoom: 13,
    pitch: 0,
    bearing: 0,
};

const layers = [
    new BitmapLayer({
        id: 'verticalProfileLayer_D8_Stab_L1',
        bounds: getVerticalProfileBounds(14.015445, 50.570605, 14.028419600527943, 50.570945823734725, 370, 220, 230),
        image: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/png_profiles/Stab-L1.png',
    }),
    // new TileLayer({
    //     data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
    //     id: 'standard-tile-layer',
    //     minZoom: 0,
    //     maxZoom: 19,
    //     tileSize: 256,
    //
    //     renderSubLayers: (props) => {
    //         const {
    //             bbox: {
    //                 west, south, east, north,
    //             },
    //         } = props.tile;
    //
    //         return new BitmapLayer(props, {
    //             data: null,
    //             image: props.data,
    //             bounds: [west, south, east, north],
    //         });
    //     },
    //     extensions: [new TerrainExtension()],
    // }),
    new CogTerrainLayer({
        id: 'CogTerrainLayerD8Dem',
        elevationData:  'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/LITC52_53_4g_5m_4326_cog_nodata.tif',
        minZoom: 12,
        maxZoom: 14,
        opacity: 0.5,
        isTiled: true,
        useChannel: null,
        tileSize: 256,
        meshMaxError: 1,
        operation: 'terrain+draw',
        terrainOptions: {
            type: 'terrain',
            multiplier: 1,
            terrainSkirtHeight: 1,
        }
    }),
    // new MVTLayer({
    //     // data ascending
    //     data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_ASC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
    //     // data descending
    //     // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
    //     binary: false,
    //     renderSubLayers: (props) => {
    //         if (props.data) {
    //             // console.log(props.data)
    //             const meshLayer = new SimpleMeshLayer({
    //                 data:props.data,
    //                 id: `${props.id}-sphere-mesh`,
    //                 mesh: new SphereGeometry(),
    //                 modelMatrix: props.modelMatrix,
    //                 extensions: props.extensions,
    //                 positionFormat: props.positionFormat,
    //                 coordinateSystem: props.coordinateSystem,
    //                 coordinateOrigin: props.coordinateOrigin,
    //                 getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    //                 getScale:  [1,1,1],
    //                 // getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
    //                 getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], 0],
    //                 // getTranslation: (d) => [0,0,sphereSizeScale(d.properties.coh)*0.75],
    //                 // pickable: true,
    //                 // extensions: [new TerrainExtension()],
    //             })
    //             return meshLayer
    //             // return new PointCloudLayer({
    //             //     ...props,
    //             //     id: `${props.id}-sphere`,
    //             //     pickable: false,
    //             //     sizeUnits: 'meters',
    //             //     pointSize: 7,
    //             //     // dve varianty vysek 'h' a 'h_dtm' podle H.Kolomaznika se to musi otestovat co bude vypadat lepe
    //             //     // getPosition: (d) => [...d.geometry.coordinates, d.properties.h],
    //             //     getPosition: (d) => [...d.geometry.coordinates, d.properties.h_dtm + 5],
    //             //     getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    //             // });
    //         }
    //         return null;
    //     },
    //     minZoom: 8,
    //     maxZoom: 14,
    // }),
    new SimpleMeshLayer({
        data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_selected_arrows.geojson',
        id: 'sphere-mesh',
        mesh: new SphereGeometry(),
        getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
        getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
        getPosition: (d) => d.geometry.coordinates,
        getTranslation: (d) => [0,0,sphereSizeScale(d.properties.coh)*0.75],
        pickable: true,
        extensions: [new TerrainExtension()],
    })
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

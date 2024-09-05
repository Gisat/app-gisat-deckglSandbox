// src/maps/MapApp1.jsx
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, IconLayer } from '@deck.gl/layers';
import { MVTLayer } from "@deck.gl/geo-layers";
import geolib from "@gisatcz/deckgl-geolib";
import chroma from "chroma-js";
import { scaleLinear } from 'd3-scale';
import { PointCloudLayer } from '@deck.gl/layers';
import {_TerrainExtension as TerrainExtension, DataFilterExtension} from '@deck.gl/extensions';

const CogTerrainLayer = geolib.CogTerrainLayer;

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const sphereSizeScale = scaleLinear([0.45, 1], [2, 9]).clamp(true);


const INITIAL_VIEW_STATE = {
    longitude: 14.015511800867504,
    latitude: 50.571906640192161,
    zoom: 13,
    pitch: 20,
    bearing: 0,
};

const DEM = new CogTerrainLayer({
    id: 'CogTerrainLayerD8Dem',
    elevationData:  'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/LITC52_53_4g_5m_4326_cog_nodata.tif',
    minZoom: 12,
    maxZoom: 14,
    opacity: 1,
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
})
const iconScale = scaleLinear([0,1], [10,50]).clamp(true)

const iconArrow = new IconLayer({
    id: 'icon-arrow',
    data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_selected_arrows.geojson',
    getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    getIcon: (d) => d.properties.vel_rel > 0 ? 'arrow': 'arrow-filled',
    getPosition: (d) => [...d.geometry.coordinates, 1],
    getAngle: (d) => d.properties.az_ang,
    billboard: false,
    sizeUnits: "meters",
    getSize: (d) => iconScale(Math.abs(d.properties.vel_rel)),
   // mask: true,
    iconAtlas: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_icon_atlas.png',
    iconMapping: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_icon_atlas.json',
    getFilterValue: d => Math.abs(d.properties.coh),
    filterRange: [0.4, 40],
    extensions: [new DataFilterExtension({filterSize: 1})],
    // extensions: [new TerrainExtension()],
});

const mvt_insar_points = new MVTLayer({
    // data ascending
    // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_ASC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
    // data descending
    data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_DESC_upd3_psd_los_4326_height/{z}/{x}/{y}.pbf',
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
                // getPosition: (d) => [...d.geometry.coordinates, d.properties.h_dtm + 5],
                getPosition: (d) => [...d.geometry.coordinates],
                getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
                getFilterValue: d => Math.abs(d.properties.coh),
                filterRange: [0.4, 40],
                extensions: [new DataFilterExtension({filterSize: 1})],
            });
        }
        return null;
    },
    minZoom: 8,
    maxZoom: 14,
})

const osm_basemap = new TileLayer({
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
    // extensions: [new TerrainExtension()],
})

const layers = [
    // DEM,
    // mvt_insar_points,
    iconArrow,
    osm_basemap
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

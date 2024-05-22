import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer, Tile3DLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import {Tiles3DLoader} from '@loaders.gl/3d-tiles';
import geolib from "@gisatcz/deckgl-geolib";
import {I3SLoader} from '@loaders.gl/i3s';

const CogTerrainLayer = geolib.CogTerrainLayer;


const INITIAL_VIEW_STATE = {
    // longitude: -75.61209430782448,
    // latitude: 40.042530611425896,
    // longitude:0.0028252481285212998,
    // latitude:  70.39914981969095,
    longitude: 14.454852597089905,
    latitude:50.036186732943776,
    zoom: 13,
    pitch: 40,
    bearing: 0,
};

const layers = [
    new CogTerrainLayer({
        id: 'CogTerrainLayerPrahaDTM',
        elevationData:  'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/dtm/dtm1m_3857_cog_nodata.tif',
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
    }),

    new Tile3DLayer({
        id: 'tile-3d-layer',
        // data: '/3d-tiles-samples-main/1.0/TilesetWithDiscreteLOD/tileset.json',
        data:  "https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/2018/Lyon_2018_LOD_Buildings_TileSet/tileset.json",
        // data: '/dragon_i3s/SceneServer/layers/0',
        loader: Tiles3DLoader,
        // loader: I3SLoader,
        onTilesetLoad: (tileset) => {
          const {cartographicCenter, zoom} = tileset;
          console.log(cartographicCenter)
        },
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
    })
]
function MapApp() {
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

export default MapApp;

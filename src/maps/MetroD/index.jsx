import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer, Tile3DLayer, MVTLayer } from '@deck.gl/geo-layers';
import {BitmapLayer, PointCloudLayer} from '@deck.gl/layers';
import {Tiles3DLoader} from '@loaders.gl/3d-tiles';
import geolib from "@gisatcz/deckgl-geolib";
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import {I3SLoader} from '@loaders.gl/i3s';
import chroma from 'chroma-js';

const CogTerrainLayer = geolib.CogTerrainLayer;

const TILESET_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const INITIAL_VIEW_STATE = {
    longitude: 14.437713740781064,
    latitude: 50.05105178409062,
    zoom: 15,
    pitch: 40,
    bearing: 0,
};

const inSAR_points =  new MVTLayer({
    id: 'inSAR_body',
    data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/inSAR/gisat_metrod_insar_tsx_los_etapa3_pilot1_3857/{z}/{x}/{y}.pbf',
    binary: false,
    minZoom: 10,
    maxZoom: 16,
    stroked: false,
    filled: true,
    pointType: 'circle',
    getFillColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    getPointRadius: (d) => d.properties.coh * 10, // coh interval (0.13-0.98)
    // extensions: [new TerrainExtension()],
})

const buildings =  new MVTLayer({
    id: 'prague_buildings',
    data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/budovy/SO_Praha_Neratovice_4326/{z}/{x}/{y}.pbf',
    binary: true,
    minZoom: 10,
    maxZoom: 14,
    stroked: false,
    filled: true,
    getFillColor: (d) => {
        if (d.properties.TYP_KOD === 0){
            return [228, 26, 28, 150]
        } else if (d.properties.TYP_KOD === 1){
            return [55, 126, 184, 150]
        } else if (d.properties.TYP_KOD === 2) {
            return [152, 78, 163, 150]
        } else return [255, 127, 0, 150]
    },
    extensions: [new TerrainExtension()],
})

const buildings_geojson = new GeoJsonLayer({
    id: 'GeoJsonLayer',
    data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/budovy/SO_Praha_Neratovice_4326_selection.geojson',
    // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/budovy/SO_Praha_Neratovice_3857_selection_test.geojson',
    // coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
    // coordinateOrigin: [0.001,-0.1,0],
    // positionFormat:"XY",
    getFillColor: [255, 0, 0, 255],
})

const inSAR_spheres = new MVTLayer({
        // dataset with all parameters
        // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/inSAR/gisat_metrod_insar_tsx_los_etapa3_pilot1_3857_all/{z}/{x}/{y}.pbf',
        // dataset with selected parameters
        data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/inSAR/gisat_metrod_insar_tsx_los_etapa3_pilot1_3857/{z}/{x}/{y}.pbf',
        binary: false,
        renderSubLayers: (props) => {
            if (props.data) {
                return new PointCloudLayer({
                    ...props,
                    id: `${props.id}-sphere`,
                    pickable: false,
                    sizeUnits: 'meters',
                    pointSize: 5,
                    // dve varianty vysek 'h' a 'h_dtm' podle H.Kolomaznika se to musi otestovat co bude vypadat lepe
                    // getPosition: (d) => [...d.geometry.coordinates, d.properties.h],
                    getPosition: (d) => [...d.geometry.coordinates, d.properties.h_dtm + 50],
                    getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
                });
            }
            return null;
        },
        minZoom: 10,
        maxZoom: 16,
    })

const google3Dtile = new Tile3DLayer({
    id: 'google-3d-tiles',
    data: TILESET_URL,
    onTilesetLoad: tileset3d => {
        tileset3d.options.onTraversalComplete = selectedTiles => {
            const uniqueCredits = new Set();
            selectedTiles.forEach(tile => {
                const {copyright} = tile.content.gltf.asset;
                copyright.split(';').forEach(uniqueCredits.add, uniqueCredits);
            });
            // setCredits([...uniqueCredits].join('; '));
            return selectedTiles;
        };
    },
    loadOptions: {
        fetch: {headers: {'X-GOOG-API-KEY': import.meta.env.VITE_GOOGLE_MAPS_API_KEY}}
    },
    operation: 'terrain+draw',
    opacity:1
})

const DTM = new CogTerrainLayer({
    id: 'CogTerrainLayerPrahaDTM',
    elevationData:  'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/metroD/dtm/dtm1m_3857_cog_nodata.tif',
    minZoom: 12,
    maxZoom: 14,
    opacity: 0.7,
    isTiled: true,
    useChannel: null,
    tileSize: 256,
    meshMaxError: 1,
    // operation: 'terrain+draw',
    terrainOptions: {
        type: 'terrain',
        multiplier: 1,
        terrainSkirtHeight: 1,
    }
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
})

const layers = [
    // osm_basemap,
    // DTM,
    google3Dtile,
    // inSAR_points,
    buildings,
    // buildings_geojson,
    // inSAR_spheres,
    // new Tile3DLayer({
    //     id: 'tile-3d-layer',
    //     // data: '/3d-tiles-samples-main/1.0/TilesetWithDiscreteLOD/tileset.json',
    //     data:  "https://dataset-dl.liris.cnrs.fr/three-d-tiles-lyon-metropolis/2018/Lyon_2018_LOD_Buildings_TileSet/tileset.json",
    //     // data: '/dragon_i3s/SceneServer/layers/0',
    //     loader: Tiles3DLoader,
    //     // loader: I3SLoader,
    //     onTilesetLoad: (tileset) => {
    //       const {cartographicCenter, zoom} = tileset;
    //       console.log(cartographicCenter)
    //     },
    // }),
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

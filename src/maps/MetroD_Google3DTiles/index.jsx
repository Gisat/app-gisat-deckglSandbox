import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { Tile3DLayer, MVTLayer } from '@deck.gl/geo-layers';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import chroma from 'chroma-js';
import {SphereGeometry} from "@luma.gl/engine";
import {scaleLinear} from "d3-scale";

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

const buildings =  new MVTLayer({
    id: 'prague_buildings',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/SO_Praha_Neratovice_4326/{z}/{x}/{y}.pbf',
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

const sphereSizeScale = scaleLinear([0.45, 1], [0.5, 2.5]).clamp(true);

const inSAR_mesh_spheres = new SimpleMeshLayer({
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/gisat_metrod_insar_tsx_los_etapa3_pilot1_4326_selected_mesh.json',
    id: 'sphere-mesh',
    mesh: new SphereGeometry(),
    getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
    getPosition: (d) => d.geometry.coordinates,
    getTranslation: (d) => [0,0,sphereSizeScale(d.properties.coh)*0.75],
    pickable: true,
    extensions: [new TerrainExtension()],
})

const layers = [
    google3Dtile,
    // inSAR_mesh_arrow,
    inSAR_mesh_spheres,
    buildings,
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

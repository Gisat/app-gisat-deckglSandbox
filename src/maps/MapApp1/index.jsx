// src/maps/MapApp1.jsx
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import geolib from "@gisatcz/deckgl-geolib";

const CogTerrainLayer = geolib.CogTerrainLayer;

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
        texture: 'tile-service.com/{z}/{x}/{y}.png',
        minZoom: 12,
        maxZoom: 14,
        opacity: 0.1,
        isTiled: true,
        // useChannel: null,
        tileSize: 256,
        // meshMaxError: 5,
        operation: 'terrain+draw',
        terrainOptions: {
            type: 'terrain',
            multiplier: 1,
            terrainSkirtHeight: 1,
            terrainMinValue: 300,
        }
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

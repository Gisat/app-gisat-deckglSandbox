// src/maps/MapApp1.jsx
import React from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

const INITIAL_VIEW_STATE = {
    longitude: -122.4,
    latitude: 37.8,
    zoom: 14,
    pitch: 0,
    bearing: 0,
};

const layers = [
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

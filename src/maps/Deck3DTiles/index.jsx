// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {MVTLayer, TileLayer} from '@deck.gl/geo-layers';
import {Tile3DLayer} from '@deck.gl/geo-layers';
import {} from '@loaders.gl/3d-tiles';
import {Tiles3DLoader, CesiumIonLoader} from '@loaders.gl/3d-tiles';
import {BitmapLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import {_TerrainExtension as TerrainExtension, PathStyleExtension} from "@deck.gl/extensions";
import geolib from "@gisatcz/deckgl-geolib";
const CogTerrainLayer = geolib.CogTerrainLayer;
import cesium1 from '../../assets/3d-tiles-samples/1.0/TilesetWithDiscreteLOD/tileset.json';
import cesium2 from '../../assets/3d-tiles-samples/1.0/TilesetWithTreeBillboards/tileset.json';

const INITIAL_VIEW_STATE = {
    // cesium 1.1
    // longitude: 45,
    // latitude: 35.446011426401625,
    // cesium 1.0
    longitude: -75.61209430782448,
    latitude: 40.042530611425896,
    // longitude: 14.409285324765367,
    // latitude: 50.08581041614817,
    zoom: 15,
    pitch: 40,
    bearing: 0,
};

// Layer configurations
const layerConfigs = [
    {
        id: 'tile-3d-layer-ion',
        type: Tile3DLayer,
        options: {
            visible: false,
            // Tileset json file url
            // data: 'https://assets.cesium.com/96188/tileset.json',
            data: 'https://assets.cesium.com/2499258/tileset.json',
            loader: CesiumIonLoader,
            loadOptions: {
                'cesium-ion': {accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI4NGNhMzk5NC1kYjk5LTQ5ZDEtOTM5Yy0zYmUyYWEwMjY5MmQiLCJpZCI6NTgyNjksImlhdCI6MTYyMzA1NTMyMX0.7jidfR2a2M5t8KsvDho5TJcBLBZl04UBj3jdeAB1otY'}
            },
            onTilesetLoad: (tileset) => {
                // Recenter to cover the tileset
                const {cartographicCenter, zoom} = tileset;
                // console.log({cartographicCenter, zoom})
                // setInitialViewState({
                //     longitude: cartographicCenter[0],
                //     latitude: cartographicCenter[1],
                //     zoom
                // });
            },
            pointSize: 2
        },
        name: 'ION 3D tiles',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'tile-3d-layer',
        type: Tile3DLayer,
        options: {
            visible: true,
            // data: cesium2,
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/cesium_3dtiles_v1_dragon/tileset.json',
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/3d-tiles-samples/1.0/TilesetWithDiscreteLOD/tileset.json',
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/3d-tiles-samples/1.0/TilesetWithRequestVolume/tileset.json',
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/3d-tiles-samples/1.1/SparseImplicitOctree/tileset.json',
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/Prah_7-1_3D_Tiles_v2/tileset.json',
            loader: Tiles3DLoader,
            onTilesetLoad: (tileset) => {
                // Recenter to cover the tileset
                const {cartographicCenter, zoom} = tileset;
                console.log({cartographicCenter, zoom})
                // setInitialViewState({
                //     longitude: cartographicCenter[0],
                //     latitude: cartographicCenter[1],
                //     zoom
                // });
            },
        },
        name: '3D tiles',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'tile-3d-layer-dragon',
        type: Tile3DLayer,
        options: {
            visible: false,
            data: cesium1,
            loader: Tiles3DLoader,
            onTilesetLoad: (tileset) => {
                // Recenter to cover the tileset
                const {cartographicCenter, zoom} = tileset;
                // console.log({cartographicCenter, zoom})
                // setInitialViewState({
                //     longitude: cartographicCenter[0],
                //     latitude: cartographicCenter[1],
                //     zoom
                // });
            },
        },
        name: 'Cesium samples',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'tile-layer',
        type: TileLayer,
        options: {
            data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            visible: true,
            renderSubLayers: (props) => {
                const { bbox: { west, south, east, north } } = props.tile;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north],
                });
            },
            // extensions: [new TerrainExtension()],
        },
        name: 'Basemap',
        showVisibilityToggle: false, // Show visibility toggle for this layer
    },
];


// Function to create a layer based on its configuration, visibility, and properties
const createLayer = (config, visibility, properties) => {
    const options = { ...config.options, id: config.id, visible: visibility };
    if (properties) {
        Object.keys(properties).forEach((key) => {
            options[key] = properties[key];
        });
    }
    return new config.type(options);
};

function MapApp1() {
    // Initial visibility state and layer properties for all layers
    const initialVisibility = layerConfigs.reduce((acc, config) => {
        acc[config.id] = config.options.visible;
        return acc;
    }, {});

    const initialProperties = layerConfigs.reduce((acc, config) => {
        if (config.controls) {
            acc[config.id] = {};
            Object.keys(config.controls).forEach(key => {
                acc[config.id][key] = config.options[key];
            });
        }
        return acc;
    }, {});

    const [layerVisibility, setLayerVisibility] = useState(initialVisibility);
    const [layerProperties, setLayerProperties] = useState(initialProperties);

    // Update the layers array based on visibility and properties state
    const layers = layerConfigs.map(config => createLayer(config, layerVisibility[config.id], layerProperties[config.id]));

    useEffect(() => {
        // Initialize dat.gui
        const gui = new dat.GUI();

        // Add visibility controls for each layer
        layerConfigs.forEach(config => {
            if (config.showVisibilityToggle) {
                gui.add(layerVisibility, config.id).name(config.name).onChange((value) => {
                    setLayerVisibility((prevState) => ({
                        ...prevState,
                        [config.id]: value,
                    }));
                });
            }
        });

        // Add dropdown controls for properties of specific layers
        layerConfigs.forEach(config => {
            if (config.controls) {
                const folder = gui.addFolder(config.name + ' Properties');
                Object.keys(config.controls).forEach(property => {
                    const options = config.controls[property];
                    if (typeof options === 'object' && !Array.isArray(options)) {
                        const controlObject = { selected: Object.keys(options)[0] };
                        folder.add(controlObject, 'selected', Object.keys(options)).name(property).onChange((value) => {
                            setLayerProperties((prevState) => ({
                                ...prevState,
                                [config.id]: {
                                    ...prevState[config.id],
                                    [property]: options[value],
                                },
                            }));
                        });
                    } else {
                        folder.add(layerProperties[config.id], property, options).onChange((value) => {
                            setLayerProperties((prevState) => ({
                                ...prevState,
                                [config.id]: {
                                    ...prevState[config.id],
                                    [property]: value,
                                },
                            }));
                        });
                    }
                });
            }
        });

        // Cleanup dat.gui on unmount
        return () => {
            gui.destroy();
        };
    }, []);

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

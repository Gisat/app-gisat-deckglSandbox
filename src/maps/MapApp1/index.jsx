// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import {PathStyleExtension} from "@deck.gl/extensions";

const INITIAL_VIEW_STATE = {
    longitude: 14.437713740781064,
    latitude: 50.05105178409062,
    zoom: 15,
    pitch: 40,
    bearing: 0,
};

// Layer configurations
const layerConfigs = [
    {
        id: 'tile-layer',
        type: TileLayer,
        options: {
            data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: (props) => {
                const { bbox: { west, south, east, north } } = props.tile;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north],
                });
            },
        },
        name: 'Tile Layer',
    },
    {
        id: 'razba_osa',
        type: GeoJsonLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/razba_osa.geojson',
            pickable: true,
            stroked: true,
            getLineColor: [15, 15, 15],
            getLineWidth: 2,
            getDashArray: [3, 2],
            dashJustified: true,
            dashGapPickable: true,
            extensions: [new PathStyleExtension({dash: true})]
        },
        name: 'GeoJson Layer',
        controls: {
            getLineColor: {
                Black: [0, 0, 0, 255],
                Red: [255, 0, 0, 255],
                Blue: [0, 0, 255, 255],
                Green: [0, 255, 0, 255],
            }
            // heightProperty: ['elevation', 'value']
        }
    }
];

// Function to create a layer based on its configuration, visibility, and properties
const createLayer = (config, visibility, properties) => {
    const options = { ...config.options, visible: visibility };
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
        acc[config.id] = true;
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
            gui.add(layerVisibility, config.id).name(config.name).onChange((value) => {
                setLayerVisibility((prevState) => ({
                    ...prevState,
                    [config.id]: value,
                }));
            });
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

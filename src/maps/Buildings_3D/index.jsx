// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {MVTLayer, TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer, PolygonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import {_TerrainExtension as TerrainExtension, PathStyleExtension} from "@deck.gl/extensions";
import {SimpleMeshLayer} from "@deck.gl/mesh-layers";
import {SphereGeometry} from "@luma.gl/engine";
import chroma from "chroma-js";
import {scaleLinear} from "d3-scale";
import {OBJLoader} from "@loaders.gl/obj";
import geolib from "@gisatcz/deckgl-geolib";
const CogTerrainLayer = geolib.CogTerrainLayer;

const INITIAL_VIEW_STATE = {
    longitude: 14.41188380380868,
    latitude: 50.08890726049832,
    zoom: 15,
    pitch: 40,
    bearing: 0,
};

const riskColors = {
    0: [255, 255, 255],
    1: [255, 213, 213],
    2: [255, 170, 170],
    3: [255, 128, 128],
    4: [255, 85, 85],
    5: [255, 42, 42]
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
    {
        id: 'cog-terrain-dtm-praha',
        type: CogTerrainLayer,
        options: {
            elevationData:  'https://gisat-data.eu-central-1.linodeobjects.com/3DFlus_GST-22/app-esa3DFlusMetroD/dev/rasters/dtm1m_4326_cog_nodata.tif',
            minZoom: 12,
            maxZoom: 17,
            // opacity: 0.7,
            isTiled: true,
            useChannel: null,
            tileSize: 256,
            meshMaxError: 1,
            visible: true,
            operation: 'terrain+draw',
            terrainOptions: {
                type: 'terrain',
                multiplier: 1,
                terrainSkirtHeight: 1,
            }
        },
        name: 'DTM Prague',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'buildings',
        type: MVTLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/SO_Praha_Neratovice_4326/{z}/{x}/{y}.pbf',
            binary: true,
            minZoom: 10,
            maxZoom: 14,
            stroked: false,
            filled: true,
            extruded: true,
            visible: false,
            getElevation: (d) => d.properties.h,
            getFillColor: (d) => riskColors[d.properties.cl_risk_e3] || [255, 255, 255, 255],
            extensions: [new TerrainExtension()],
        },
        name: 'Building',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'test_building',
        type: PolygonLayer,
        options: {
            data: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/sf-zipcodes.json',
            getPolygon: d => d.contour,
            getElevation: d => d.population / d.area / 10,
            getFillColor: d => [d.population / d.area / 60, 140, 0],
            getLineColor: [255, 255, 255],
            getLineWidth: 20,
            lineWidthMinPixels: 1,
            // pickable: true,
            visible: false,
            // extensions: [new TerrainExtension()],
        },
        name: 'test Building',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: '3d_building',
        type: GeoJsonLayer,
        options: {
            // data: 'https://raw.githubusercontent.com/visgl/deck.gl-data/master/website/sf-zipcodes.json',
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/3dtiles/Prah_7-1_4326.geojson',
            getFillColor: (d) => {
                if (d.properties.TYP === 'Strecha'){
                    // https://mycolor.space/?hex=%23A00F0F&sub=1
                    return [160, 15, 15, 255]
                }
                else if (d.properties.TYP === 'Stena'){
                    // https://mycolor.space/?hex=%237F8A84&sub=1
                    return [127,138,132,255]
                }
                else if (d.properties.TYP === 'Detail'){
                    return [157, 9, 13, 255]
                }

                // else if (d.properties.TYP === 'Zakladova deska'){
                //     return [201,61,45,255]
                // }
            },
            getLineColor: (d) => {
                if (d.properties.TYP === 'Strecha'){
                    return [115, 0, 0, 255]
                }
                else if (d.properties.TYP === 'Stena'){
                    return [108 ,125,121,255]
                }
                else if (d.properties.TYP === 'Detail'){
                    return [118,0,0,255]
                }
            },
            getLineWidth: 0.2,
            // lineWidthMinPixels: 1,
            // pickable: true,
            visible: true,
            _full3d: true,
            // extensions: [new TerrainExtension()],
        },
        name: '3D Building',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    }
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

// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {MVTLayer, TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import {_TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
import {SimpleMeshLayer} from "@deck.gl/mesh-layers";
import chroma from "chroma-js";
import {OBJLoader} from "@loaders.gl/obj";
import {SphereGeometry} from "@luma.gl/engine";
import { CogTerrainLayer } from "@gisatcz/deckgl-geolib";

const INITIAL_VIEW_STATE = {
    longitude: 14.440544794048083,
    latitude: 50.04894986887636,
    zoom: 16,
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

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const meshIconFlatArrowDiscreteScaleMVT = (value) => {
    if (value < 1) return 0.015;
    if (value < 2) return 0.03;
    return 0.06;
}

const FLAT_ARROW_SIZE = 0.451564; // value taken from Blender, for flat arrow: https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/arrows/arrow_filled_v2.obj

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
            extensions: [new TerrainExtension()],
        },
        name: 'Basemap',
        showVisibilityToggle: false, // Show visibility toggle for this layer
    },
    {
        id: 'insar-arrow-mvt',
        type: MVTLayer,
        options: {
            // data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_mvt/compo_area_vellast_e4e5_sipky/{z}/{x}/{y}.pbf',
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_mvt_v4/{z}/{x}/{y}.pbf',
            binary: false,
            renderSubLayers: (props) => {
                if (props.data) {
                    return new SimpleMeshLayer({
                        ...props,
                        id: `${props.id}-arrowObject`, // Create a unique ID for each tile's mesh sublayer
                        data: props.data, // Crucially, pass the parsed data for the current tile to SimpleMeshLayer
                        mesh: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/arrows/arrow_filled_v2.obj',
                        getColor: (d) => [...colorScale(d.properties.VEL_L_EW_e5).rgb(), 255],
                        getOrientation: (d) => {
                            const orientation = d.properties.VEL_L_EW_e5 >= 0 ? 90 : -90;
                            return [0, 180 + orientation, 90]
                        },
                        getTranslation: (d) => {
                            if (d.properties.VEL_L_EW_e5 >= 0) {
                                return [FLAT_ARROW_SIZE * meshIconFlatArrowDiscreteScaleMVT(Math.abs(d.properties.VEL_L_EW_e5)),0,0];
                            } else {
                                return [
                                    -FLAT_ARROW_SIZE * meshIconFlatArrowDiscreteScaleMVT(Math.abs(d.properties.VEL_L_EW_e5)),0, 0];
                            }
                        },
                        getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.H_DSM],
                        getScale: (d) => {
                            // [delka sipky, tloustka ve 3d - nema smysl pro 2d sipky, sirka sipky]
                            return [meshIconFlatArrowDiscreteScaleMVT(Math.abs(d.properties.VEL_L_EW_e5)), 1, meshIconFlatArrowDiscreteScaleMVT(Math.abs(d.properties.VEL_L_EW_e5))]
                        },
                        loaders: [OBJLoader],
                    });
                }
                return null;
            },
            visible: true,
            minZoom: 8,
            maxZoom: 15,
        },
        name: 'arrows MVT',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'insar-sphere-mvt',
        type: MVTLayer,
        options: {
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_mvt_v4/{z}/{x}/{y}.pbf',
            binary: false,
            renderSubLayers: (props) => {
                if (props.data) {
                    return new SimpleMeshLayer({
                        ...props,
                        id: `${props.id}-sphereObject`, // Create a unique ID for each tile's mesh sublayer
                        data: props.data, // Crucially, pass the parsed data for the current tile to SimpleMeshLayer
                        mesh: new SphereGeometry(),
                        getScale: [0.001,0.001,1],
                        getColor: (d) => [...colorScale(d.properties.VEL_L_EW_e5).rgb(), 255],
                        getOrientation: [0,0,0],
                        getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.H_DSM+4],
                    });
                }
                return null;
            },
            visible: true,
            minZoom: 8,
            maxZoom: 15,
        },
        name: 'spheres MVT',
        showVisibilityToggle: true, // Show visibility toggle for this layer
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
        showVisibilityToggle: false, // Show visibility toggle for this layer
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
            visible: true,
            getElevation: (d) => d.properties.h,
            getFillColor: (d) => riskColors[d.properties.cl_risk_e3] || [255, 255, 255, 255],
            extensions: [new TerrainExtension()],
        },
        name: 'Building',
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

// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {MVTLayer, TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import {_TerrainExtension as TerrainExtension, DataFilterExtension} from "@deck.gl/extensions";
import {SimpleMeshLayer} from "@deck.gl/mesh-layers";
import chroma from "chroma-js";
import {scaleLinear} from "d3-scale";
import {OBJLoader} from "@loaders.gl/obj";
import geolib from "@gisatcz/deckgl-geolib";
import {SphereGeometry} from "@luma.gl/engine";
const CogTerrainLayer = geolib.CogTerrainLayer;

const INITIAL_VIEW_STATE = {
    longitude: 14.440544794048083,
    latitude: 50.04894986887636,
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

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const sphereSizeScale = scaleLinear([0, 1], [0.5, 2.5]).clamp(true); //for rel len
// const sphereSizeScale = scaleLinear([0.45, 1], [0.5, 2.5]).clamp(true); //for coh
const pointSizeScale = scaleLinear([0.45,1],[0.1, 2.5]).clamp(true);
const meshIconFlatArrowVelScale= scaleLinear([0,30], [10,200]).clamp(true)
const meshIconFlatArrowDiscreteScale = (value) => {
    if (value < 1) return 5;
    if (value < 2) return 10;
    return 20;
}


const scaleXYArrowWidth = scaleLinear([0.1, 20], [0.1 , 0.3]).clamp(true);
const scaleZArrowLength = scaleLinear([0.1, 20], [0.05, 2]).clamp(true);

const ARROW_SIZE = 67; // eyeball measured, only for this object: https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_v3.obj
const FLAT_ARROW_SIZE = 0.451564; // eyeball measured

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
        id: 'insar-points-sphere',
        type: SimpleMeshLayer,
        options: {
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.json',
            mesh: new SphereGeometry(),
            visible: true,
            getColor: (d) => [...colorScale(d.properties.VEL_LA_EW).rgb(), 255],
            getScale: [0.5,0.5,0.5],
            // getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.VEL_LA_EW)),
            // InSAR body clamped to ground (h_dtm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            // InSAR body clamped to ground (h_dsm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dsm],
            // InSAR body vykreslene dle jejich vysky (h)
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1]],
            // getTranslation: (d) => [0,0,sphereSizeScale(d.properties.VEL_LA_EW)*0.75],
            getTranslation: (d) => [0,0,1],
            pickable: true,
            extensions: [new TerrainExtension()],
        },
        name: 'sphere points',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'insar-points-arrow',
        type: SimpleMeshLayer,
        options: {
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.json',
            mesh: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/assets/arrow_v3.obj',
            getColor: (d) => [...colorScale(d.properties.VEL_LA_EW).rgb(), 255],
            getOrientation: (d) => {
                const orientation = d.properties.VEL_LA_EW >= 0 ? 90 : -90;
                if (d.properties.VEL_LA_EW > 0) {
                    return [0, d.properties.AZ_ANG, 180 + orientation];
                } else {return [0, d.properties.AZ_ANG, orientation]};
            },
            visible: false,
            getTranslation: (d) => {
                const orientation = d.properties.VEL_LA_EW >= 0 ? 90 : -90;
                const orientation_rad = orientation * Math.PI / 180;
                const AZ_ANG_rad = d.properties.AZ_ANG * Math.PI / 180;
                if (d.properties.VEL_LA_EW > 0) {
                    return [
                        Math.sin(orientation_rad) * Math.sin(AZ_ANG_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.VEL_LA_EW),
                        -Math.sin(orientation_rad) * Math.cos(AZ_ANG_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.VEL_LA_EW),
                        Math.cos(orientation_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.VEL_LA_EW)];
                } return [
                    -Math.sin(orientation_rad) * Math.sin(AZ_ANG_rad) * ARROW_SIZE * scaleZArrowLength(Math.abs(d.properties.VEL_LA_EW)),
                    -Math.sin(orientation_rad) * Math.cos(AZ_ANG_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.VEL_LA_EW),
                    Math.cos(orientation_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.VEL_LA_EW)];
            },
            // InSAR body clamped to ground (h_dtm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            // InSAR body clamped to ground (h_dsm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dsm],
            // InSAR body vykreslene dle jejich vysky (h)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h],
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1],1],
            getScale: (d) => {
                if (d.properties.VEL_LA_EW > 0) {
                    return [scaleXYArrowWidth(d.properties.VEL_LA_EW), scaleXYArrowWidth(d.properties.VEL_LA_EW), scaleZArrowLength(d.properties.VEL_LA_EW)];
                }
                return [scaleXYArrowWidth(Math.abs(d.properties.VEL_LA_EW)), scaleXYArrowWidth(Math.abs(d.properties.VEL_LA_EW)), scaleZArrowLength(Math.abs(d.properties.VEL_LA_EW))];
            },
            loaders: [OBJLoader],
            pickable: true,
            extensions: [new TerrainExtension()],
        },
        name: 'arrow not flat',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'insar-points-arrow-flat',
        type: SimpleMeshLayer,
        options: {
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.json',
            // mesh: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_filled.obj',
            mesh: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/arrows/arrow_filled_v2.obj',
            id: 'insar-points-arrow-mesh',
            getColor: (d) => [...colorScale(d.properties.VEL_LA_EW).rgb(), 255],
            getOrientation: (d) => {
                const orientation = d.properties.VEL_LA_EW >= 0 ? 90 : -90;
                return [0, 180 + orientation, 90]
            },
            getTranslation: (d) => {
                if (d.properties.VEL_LA_EW >= 0) {
                    return [FLAT_ARROW_SIZE * meshIconFlatArrowDiscreteScale(Math.abs(d.properties.VEL_LA_EW)),0,0];
                } else {
                    return [
                       -FLAT_ARROW_SIZE * meshIconFlatArrowDiscreteScale(Math.abs(d.properties.VEL_LA_EW)),0, 0];
                }
            },
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], 1],
            getScale: (d) => {
                // [delka sipky, tloustka ve 3d - nema smysl pro 2d sipky, sirka sipky]
                return [meshIconFlatArrowDiscreteScale(Math.abs(d.properties.VEL_LA_EW)), 1, meshIconFlatArrowDiscreteScale(Math.abs(d.properties.VEL_LA_EW))]
            },
            loaders: [OBJLoader],
            getFilterValue: d => d.properties.rel_len,
            // filterRange: insarPointRelLenThresholdInterval,
            // pickable: true,
            // extensions: [new DataFilterExtension({filterSize: 1})],
            extensions: [new TerrainExtension()],
            visible: true,
        },
        name: 'arrow flat',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    // {
    //     id: 'geojson-points',
    //     type: GeoJsonLayer, // <-- Using GeoJsonLayer
    //     options: {
    //         data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.geojson',
    //         getPointRadius: 0.5,
    //         visible: true, // Start invisible for comparison, toggle via GUI
    //         extensions: [new TerrainExtension()],
    //     },
    //     name: 'points',
    //     showVisibilityToggle: true,
    // },
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
            visible: false,
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

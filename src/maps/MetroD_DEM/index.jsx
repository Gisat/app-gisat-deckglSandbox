// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {MVTLayer, TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
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
    longitude: 14.437713740781064,
    latitude: 50.05105178409062,
    zoom: 15,
    pitch: 40,
    bearing: 0,
};

const zoneColors = {
    20190701: [253, 231, 37],
    20220301: [171, 220, 50],
    20220401: [93, 201, 98],
    20220501: [39, 174, 128],
    20220601: [32, 144, 141],
    20230701: [43, 114, 142],
    20230731: [58, 82, 139],
    20230901: [70, 44, 123],
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
        id: 'razba-zona',
        type: GeoJsonLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/razba_zona-ovlivneni_buffer_chronologie_v2.geojson',
            filled: true,
            pickable: true,
            getFillColor: (d) => zoneColors[d.properties.CL_START] || [0, 0, 0, 0],
            stroked: true,
            visible: true,
            getLineColor: [15,15,15],
            getLineWidth: 0.5,
            extensions: [new TerrainExtension()],
        },
        name: 'Chronology',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'razba-osa',
        type: GeoJsonLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/razba_osa.geojson',
            pickable: true,
            stroked: true,
            getLineColor: [15, 15, 15],
            getLineWidth: 2,
            getDashArray: [3, 2],
            dashJustified: true,
            visible: true,
            dashGapPickable: true,
            extensions: [new TerrainExtension(), new PathStyleExtension({dash: true})]
        },
        name: 'Axis',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    // {
    //     id: 'insar-points-mvt',
    //     type: MVTLayer,
    //     options: {
    //         data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/gisat_metrod_insar_tsx_los_etapa3_pilot1_4326/{z}/{x}/{y}.pbf',
    //         binary: false,
    //         minZoom: 10,
    //         maxZoom: 16,
    //         stroked: false,
    //         filled: true,
    //         pointType: 'circle',
    //         visible: false,
    //         getFillColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
    //         getPointRadius: (d) => pointSizeScale(d.properties.coh), // coh interval (0.13-0.98)
    //         extensions: [new TerrainExtension()],
    //     },
    //     name: 'InSAR points MVT',
    //     showVisibilityToggle: true, // Show visibility toggle for this layer
    // },
    {
        id: 'insar-points-sphere',
        type: SimpleMeshLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/gisat_metrod_insar_tsx_los_etapa3_pilot1_4326_selected_mesh.json',
            mesh: new SphereGeometry(),
            visible: true,
            getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
            getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
            // InSAR body clamped to ground (h_dtm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            // InSAR body clamped to ground (h_dsm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dsm],
            // InSAR body vykreslene dle jejich vysky (h)
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dsm],
            getTranslation: (d) => [0,0,sphereSizeScale(d.properties.rel_len)*0.75],
            pickable: true,
            // extensions: [new TerrainExtension()],
        },
        name: 'InSAR sphere',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'insar-points-arrow',
        type: SimpleMeshLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/vectors/gisat_metrod_insar_tsx_los_etapa3_pilot1_4326_selected_mesh.json',
            mesh: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/app-esa3DFlusMetroD/dev/assets/arrow_v3.obj',
            getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
            getOrientation: (d) => {
                if (d.properties.vel_rel > 0) {
                    return [0, d.properties.az_ang, 180 + d.properties.inc_ang];
                } else {return [0, d.properties.az_ang, d.properties.inc_ang]};
            },
            visible: false,
            getTranslation: (d) => {
                if (d.properties.vel_rel > 0) {
                    const inc_ang_rad = d.properties.inc_ang * Math.PI / 180;
                    const az_ang_rad = d.properties.az_ang * Math.PI / 180;
                    return [
                        Math.sin(inc_ang_rad) * Math.sin(az_ang_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.vel_rel),
                        -Math.sin(inc_ang_rad) * Math.cos(az_ang_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.vel_rel),
                        Math.cos(inc_ang_rad) * ARROW_SIZE * scaleZArrowLength(d.properties.vel_rel)];
                } return [0, 0, 0];
            },
            // InSAR body clamped to ground (h_dtm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            // InSAR body clamped to ground (h_dsm)
            // getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dsm],
            // InSAR body vykreslene dle jejich vysky (h)
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h],
            getScale: (d) => {
                if (d.properties.vel_rel > 0) {
                    return [scaleXYArrowWidth(d.properties.vel_rel), scaleXYArrowWidth(d.properties.vel_rel), scaleZArrowLength(d.properties.vel_rel)];
                }
                return [scaleXYArrowWidth(Math.abs(d.properties.vel_rel)), scaleXYArrowWidth(Math.abs(d.properties.vel_rel)), scaleZArrowLength(Math.abs(d.properties.vel_rel))];
            },
            loaders: [OBJLoader],
            pickable: true,
            // extensions: [new TerrainExtension()],
        },
        name: 'InSAR arrow',
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

const scaleXYArrowWidth = scaleLinear([0.1, 20], [0.1 , 0.3]).clamp(true);
const scaleZArrowLength = scaleLinear([0.1, 20], [0.05, 2]).clamp(true);

const ARROW_SIZE = 67; // eyeball measured, only for this object: https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_v3.obj


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

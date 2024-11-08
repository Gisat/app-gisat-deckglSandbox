// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import {scaleLinear} from 'd3-scale';
import {OBJLoader} from '@loaders.gl/obj';
import * as dat from 'dat.gui';
import {SimpleMeshLayer} from "@deck.gl/mesh-layers";
import chroma from "chroma-js";
import {DataFilterExtension} from '@deck.gl/extensions';

const INITIAL_VIEW_STATE = {
    longitude: 14.015511800867504,
    latitude: 50.571906640192161,
    zoom: 13,
    pitch: 20,
    bearing: 0,
};

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const scaleXYArrowWidth = scaleLinear([0.1, 20], [0.1, 0.3]).clamp(true);
const scaleZArrowLength = scaleLinear([0.1, 20], [0.05, 2]).clamp(true);

const ARROW_SIZE = 67; // eyeball measured, only for this object: https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_v3.obj

const getScale = item => {
    if (item.properties.vel_rel > 0) {
        return [
            scaleXYArrowWidth(item.properties.vel_rel),
            scaleXYArrowWidth(item.properties.vel_rel),
            scaleZArrowLength(item.properties.vel_rel),
        ];
    }
    return [
        scaleXYArrowWidth(Math.abs(item.properties.vel_rel)),
        scaleXYArrowWidth(Math.abs(item.properties.vel_rel)),
        scaleZArrowLength(Math.abs(item.properties.vel_rel)),
    ];
};

const getOrientation = item => {
    if (item.properties.vel_rel > 0) {
        return [0, 180+360-item.properties.az_ang, 180 + item.properties.inc_ang];
    } else {
        return [0, 180+360-item.properties.az_ang, item.properties.inc_ang];
    }
};

const getTranslation = item => {
    if (item.properties.vel_rel > 0) {
        const inc_ang_rad = (item.properties.inc_ang * Math.PI) / 180;
        const az_ang_rad = (item.properties.az_ang * Math.PI) / 180;
        return [
            Math.sin(inc_ang_rad) *
            Math.sin(az_ang_rad) *
            ARROW_SIZE *
            scaleZArrowLength(item.properties.vel_rel),
            Math.sin(inc_ang_rad) *
            Math.cos(az_ang_rad) *
            ARROW_SIZE *
            scaleZArrowLength(item.properties.vel_rel),
            Math.cos(inc_ang_rad) *
            ARROW_SIZE *
            scaleZArrowLength(item.properties.vel_rel),
        ];
    } else {
        return [0, 0, 0];
    }
};


// Layer configurations
const layerConfigs = [
    {
        id: 'tile-layer',
        type: TileLayer,
        options: {
            visible:true,
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
        id: 'insar-points-geojson',
        type: GeoJsonLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_ASC_upd3_psd_los_4326.geojson',
            binary: false,
            getFillColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
            // getFillColor: "red",
            id: `insarpointsGEOJSON`,
            getFilterValue: d => Math.abs(d.properties.coh),
            filterRange: [0.4, 40],
            extensions: [new DataFilterExtension({filterSize: 1})],
            visible: true,
            minZoom: 8,
            maxZoom: 14,
        },
        name: 'insar points GeoJSON',
    },
    {
        id: 'trim_d8_ASC_arrows',
        type: SimpleMeshLayer,
        options: {
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/InSAR/trim_d8_ASC_upd3_psd_los_4326_height_mesh.json',
            id: 'trim_d8_ASC_arrows',
            mesh: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/d8/arrow_v3.obj',
            getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
            getOrientation: getOrientation,
            // getPosition: d => [...d.geometry.coordinates, d.properties.h_dtm],
            getPosition: d => [...d.geometry.coordinates],
            getScale: getScale,
            getTranslation: getTranslation,
            loaders: [OBJLoader],
            getFilterValue: d => Math.abs(d.properties.coh),
            filterRange: [0.4, 40],
            visible: true,
            extensions: [new DataFilterExtension({filterSize: 1})],
        },
        name: 'inSAR arrows ASC',
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
            gui.add(layerVisibility, config.id).name(config.name).onChange((value) => {
                setLayerVisibility((prevState) => ({
                    ...prevState,
                    [config.id]: value,
                }));
            });
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

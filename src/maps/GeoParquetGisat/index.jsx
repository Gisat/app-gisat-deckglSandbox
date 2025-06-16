// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import { tableFromIPC } from "apache-arrow";
import { GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers';
import initWasm, {readParquet} from "parquet-wasm";
import chroma from "chroma-js";

const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 15,
    pitch: 0,
    bearing: 0,
};

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-2, 2]);


console.log('Starting WASM initialization...');

// Call wasmInit() and wait for it to initialize the WASM bundle
await initWasm(`${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`);

console.log('WASM initialized successfully!');

// Now you can safely use `readParquet` or other functions
// Example usage after WASM is initialized

// --- Data Loading ---
// --- 1. Load GeoParquetGisat (client-side calculated color) ---

const geoParquetPathClientColor = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet' // Assuming this is your original GeoParquetGisat
// const geoParquetPathClientColor = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.parquet' // Assuming this is your original GeoParquetGisat
console.time('Load_GP_ClientColor');
const parquetResponseClientColor = await fetch(geoParquetPathClientColor);
if (!parquetResponseClientColor.ok) {
    console.error(`Failed to fetch GeoParquet (client-side color) file: ${parquetResponseClientColor.statusText}`);
}
const parquetArrayBufferClientColor = await parquetResponseClientColor.arrayBuffer();
const wasmTableClientColor = readParquet(new Uint8Array(parquetArrayBufferClientColor));
const jsTableClientColor = tableFromIPC(wasmTableClientColor.intoIPCStream());
// console.log('Loaded GeoParquetGisat (client-side color - jsTableClientColor):', jsTableClientColor);
console.timeEnd('Load_GP_ClientColor');
const geomVectorClientColor = jsTableClientColor.getChild("geometry");


// --- 2. Load GeoParquetGisat (with precomputed color) ---
const geoParquetPathPrecomputedColor = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK_colors.parquet'; // <--- NEW FILE PATH
console.time('Load_GP_ClientColor');
const parquetResponsePrecomputedColor = await fetch(geoParquetPathPrecomputedColor);
if (!parquetResponsePrecomputedColor.ok) {
    console.error(`Failed to fetch GeoParquet (client-side color) file: ${parquetResponsePrecomputedColor.statusText}`);
}
const parquetArrayBufferPrecomputedColor = await parquetResponsePrecomputedColor.arrayBuffer();
const wasmTablePrecomputedColor = readParquet(new Uint8Array(parquetArrayBufferPrecomputedColor));
const jsTablePrecomputedColor = tableFromIPC(wasmTablePrecomputedColor.intoIPCStream());
// console.log('Loaded GeoParquetGisat (precomputed color - jsTablePrecomputedColor):', jsTablePrecomputedColor);
console.timeEnd('Load_GP_ClientColor');
const geomVectorPrecomputedColor = jsTablePrecomputedColor.getChild("geometry");
const colorsVectorPrecomputedColor = jsTablePrecomputedColor.getChild("colors"); // Get the precomputed colors column

// --- 3. GeoJSON Data Loading (client-side calculated color) ---
const geoJsonPathClientColor = `https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky.geojson`;
console.time('Load_GeoJSON_ClientColor');
const geoJsonClientColorResponse = await fetch(geoJsonPathClientColor);
const geoJsonClientColorData = await geoJsonClientColorResponse.json();
console.timeEnd('Load_GeoJSON_ClientColor');

// --- 4. GeoJSON Data Loading (client-side calculated color) ---
const geoJsonPathPrecomputedColor = `https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.geojson`;
console.time('Load_GeoJSON_PrecomputedColor');
const geoJsonPrecomputedColorResponse = await fetch(geoJsonPathPrecomputedColor);
const geoJsonPrecomputedColorData = await geoJsonPrecomputedColorResponse.json();
console.timeEnd('Load_GeoJSON_PrecomputedColor');



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
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'geoparquet-points',
        type: GeoArrowScatterplotLayer,
        options: {
            data: jsTableClientColor, // Pass the entire Arrow Table as data
            // The getPosition accessor MUST be the GeoArrow Vector itself
            getPosition: geomVectorClientColor,
            // getFillColor: [0, 100, 60, 160], // Example color
            getFillColor: ({ index, data }) => {
                const recordBatch = data.data;
                const row = recordBatch.get(index);
                return colorScale(row["VEL_LA_EW"]).rgb();
            },
            // getFillColor: jsTable.getChild("colors"),
            // getRadius: ({ index, data }) => {
            //     const recordBatch = data.data;
            //     const row = recordBatch.get(index);
            //     return row["VEL_LA_UP"] * 5;
            // },
            getRadius: 5,
            visible: true,
        },
        name: 'Geoparquet Points',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },

    {
        id: 'geoparquet-points-color',
        type: GeoArrowScatterplotLayer,
        options: {
            data: jsTablePrecomputedColor, // Pass the entire Arrow Table as data
            // The getPosition accessor MUST be the GeoArrow Vector itself
            getPosition: geomVectorPrecomputedColor,
            getFillColor: colorsVectorPrecomputedColor,
            getRadius: 5,
            visible: true,
        },
        name: 'Geoparquet Points Color',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'geojson-points',
        type: GeoJsonLayer, // <-- Using GeoJsonLayer
        options: {
            data: geoJsonClientColorData,
            pointRadiusMinPixels: 2, // Minimum radius in pixels for points
            // getPointRadius: d => {
            //     // GeoJSON feature properties are under d.properties
            //     const vel_la_up = d.properties.VEL_LA_UP;
            //     return vel_la_up ? vel_la_up * 5 : 5; // Default to 5 if property not found
            // },
            getRadius: 5,
            getFillColor: d => {
                // Prioritize precomputed 'geojson_color' if it exists
                if (d.properties && d.properties.geojson_color) {
                    return d.properties.geojson_color;
                }
                // Fallback to real-time calculation using chroma.js if no precomputed color
                const vel_la_ew = d.properties.VEL_LA_EW;
                return vel_la_ew !== undefined ? colorScale(vel_la_ew).rgb() : [128, 128, 128, 160]; // Default grey if not found
            },
            visible: true, // Start invisible for comparison, toggle via GUI
            pickable: true,
        },
        name: 'GeoJSON Points',
        showVisibilityToggle: true,
    },
    {
        id: 'geojson-points-color',
        type: GeoJsonLayer, // <-- Using GeoJsonLayer
        options: {
            data: geoJsonPrecomputedColorData,
            pointRadiusMinPixels: 2, // Minimum radius in pixels for points
            // getPointRadius: d => {
            //     // GeoJSON feature properties are under d.properties
            //     const vel_la_up = d.properties.VEL_LA_UP;
            //     return vel_la_up ? vel_la_up * 5 : 5; // Default to 5 if property not found
            // },
            getPointRadius: 5,
            getFillColor: d => {
                // Prioritize precomputed 'geojson_color' if it exists
                if (d.properties && d.properties.geojson_color) {
                    return d.properties.geojson_color;
                }
                // Fallback to real-time calculation using chroma.js if no precomputed color
                const vel_la_ew = d.properties.VEL_LA_EW;
                return vel_la_ew !== undefined ? colorScale(vel_la_ew).rgb() : [128, 128, 128, 160]; // Default grey if not found
            },
            visible: true, // Start invisible for comparison, toggle via GUI
            pickable: true,
        },
        name: 'GeoJSON Points Color',
        showVisibilityToggle: true,
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

function GeoParquet() {
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
        const gui = new dat.GUI({ width: 350 });

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

export default GeoParquet;

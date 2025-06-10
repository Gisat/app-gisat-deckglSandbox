// src/maps/MapApp1.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import { tableFromIPC } from "apache-arrow";
import { GeoArrowSolidPolygonLayer, GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers';
import initWasm, {readParquet} from "parquet-wasm";
import chroma from "chroma-js";


// const INITIAL_VIEW_STATE = {
//     longitude: -111.89411386472318,
//     latitude: 40.75150168091724,
//     zoom: 10,
//     pitch: 0,
//     bearing: 0,
// };
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

const response = await fetch('https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/compo_area_vellast_sipky_MK.parquet');  // Load Parquet file from URL
// const response = await fetch('/geoparquet/Utah@1.parquet');  // Load Parquet file from URL
// const response = await fetch('https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/demo_data/Utah@1.parquet');  // Load Parquet file from URL
const arrayBuffer = await response.arrayBuffer();   //parquetBytes
const wasmTable = readParquet(new Uint8Array(arrayBuffer));
console.log('Arrow Data:', wasmTable);
console.log('Type of Arrow Data:', typeof wasmTable);
const jsTable = tableFromIPC(wasmTable.intoIPCStream());


console.log('Full jsTable:', jsTable); // Inspect the full table structure
console.log('jsTable schema fields:', jsTable.schema.fields);

const geometryField = jsTable.schema.fields.find(f => f.name === 'geometry');

if (!geometryField) {
    console.error("Error: 'geometry' field not found in the table.");
    // return;
}

// Check the type of the geometry field to ensure it's GeoArrow Point
console.log('Geometry Field Type:', geometryField.type);
console.log('Geometry Field Extension Name:', geometryField.metadata.get('ARROW:extension:name'));
console.log('Geometry Field Extension Type:', geometryField.metadata.get('ARROW:extension:metadata')); // Check if this shows geoarrow.point

const geomVector = jsTable.getChild("geometry");

if (!geomVector) {
    console.error("Error: Could not get 'geometry' vector from the table.");
    // return;
}

// Basic sanity checks on the vector
console.log('Geometry Vector Length:', geomVector.length);
console.log('Geometry Vector Type:', geomVector.type);
// For FixedSizeList (common for points), check the child type and size
if (geomVector.type.children && geomVector.type.children.length > 0) {
    console.log('Geometry Vector Child Type:', geomVector.type.children[0].type);
    console.log('Geometry Vector Fixed Size List Size:', geomVector.type.listSize); // For FixedSizeList
}


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
            data: jsTable, // Pass the entire Arrow Table as data
            // The getPosition accessor MUST be the GeoArrow Vector itself
            getPosition: geomVector,
            // getFillColor: [0, 100, 60, 160], // Example color
            getFillColor: ({ index, data }) => {
                const recordBatch = data.data;
                const row = recordBatch.get(index);
                return colorScale(row["VEL_LA_EW"]).rgb();
            },
            getRadius: ({ index, data }) => {
                const recordBatch = data.data;
                const row = recordBatch.get(index);
                return row["VEL_LA_UP"] * 5;
            },
            visible: true,
        },
        name: 'Geoparquet Points (GeoArrow)',
        showVisibilityToggle: true, // Show visibility toggle for this layer
    },
    {
        id: 'geojson-points',
        type: GeoJsonLayer, // <-- Using GeoJsonLayer
        options: {
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky.geojson',
            pointRadiusMinPixels: 2, // Minimum radius in pixels for points
            getPointRadius: d => {
                // GeoJSON feature properties are under d.properties
                const vel_la_up = d.properties.VEL_LA_UP;
                return vel_la_up ? vel_la_up * 5 : 5; // Default to 5 if property not found
            },
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
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.geojson',
            pointRadiusMinPixels: 2, // Minimum radius in pixels for points
            getPointRadius: d => {
                // GeoJSON feature properties are under d.properties
                const vel_la_up = d.properties.VEL_LA_UP;
                return vel_la_up ? vel_la_up * 5 : 5; // Default to 5 if property not found
            },
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
    // {
    //     id: 'geoparquet-buildings',
    //     type: GeoArrowSolidPolygonLayer,
    //     options: {
    //         data: jsTable,
    //         getPolygon: jsTable.getChild("GEOMETRY"),
    //         getFillColor: [0, 100, 60, 160],
    //         visible: true,
    //     },
    //     name: 'Geoparquet',
    //     showVisibilityToggle: true, // Show visibility toggle for this layer
    // },
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
        const gui = new dat.GUI({ width: 300 });

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

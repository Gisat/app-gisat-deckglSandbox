// src/maps/GPG.jsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, GeoJsonLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui';
import { tableFromIPC } from "apache-arrow";
import { GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers';
import initWasm, {readParquet} from "parquet-wasm"; // parquet-wasm imports
import chroma from "chroma-js";


const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 11,
    pitch: 0,
    bearing: 0,
};

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-2, 2]);


// --- Define Data Paths (Constants) ---
// not zipped file
// const GEO_PARQUET_PATH_CLIENT_COLOR = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet';
// zipped file
const GEO_PARQUET_PATH_CLIENT_COLOR = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK_zipped.parquet';
const GEO_PARQUET_PATH_PRECOMPUTED_COLOR = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK_colors.parquet';
const GEO_JSON_PATH_CLIENT_COLOR = `https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky.geojson`;
const GEO_JSON_PATH_PRECOMPUTED_COLOR = `https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_colors.geojson`;
const GEO_PARQUET_PATH_EGMS_GEOM_ONLY = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/EGMS_L2b_146_0296_IW2_VV_2019_2023_1_geom_only.parquet';
// const GEO_PARQUET_PATH_EGMS = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/EGMS_L2b_146_0296_IW2_VV_2019_2023_1.parquet';


// Helper function to create a layer instance
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
    // --- State for Loaded Data ---
    const [isWasmReady, setIsWasmReady] = useState(false); // Tracks if parquet-wasm is initialized
    const [jsTableClientColor, setJsTableClientColor] = useState(null);
    const [jsTablePrecomputedColor, setJsTablePrecomputedColor] = useState(null);
    const [geoJsonClientColorData, setGeoJsonClientColorData] = useState(null);
    const [geoJsonPrecomputedColorData, setGeoJsonPrecomputedColorData] = useState(null);
    // --- NEW: State for Geometry-Only GeoParquet Data ---
    const [jsTableGeomOnly, setJsTableGeomOnly] = useState(null);

    // --- State for Layer Visibility and Properties (controlled by dat.GUI) ---
    const [layerVisibility, setLayerVisibility] = useState({});
    const [layerProperties, setLayerProperties] = useState({});

    const renderedLayerIds = useRef(new Set());


    // --- Define Initial Layer Configurations ---
    const initialLayerConfigs = [
        {
            id: 'tile-layer',
            type: TileLayer,
            options: {
                data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                minZoom: 0, maxZoom: 19, tileSize: 256, visible: true, // Basemap remains visible by default
                renderSubLayers: (props) => {
                    const { bbox: { west, south, east, north } = {} } = props.tile || {};
                    return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
                },
            },
            name: 'Basemap', showVisibilityToggle: true,
        },
        {
            id: 'geoparquet-points-client-color',
            type: GeoArrowScatterplotLayer,
            options: {
                data: jsTableClientColor, // Data state variable (initially null)
                getPosition: jsTableClientColor ? jsTableClientColor.getChild("geometry") : null,
                getFillColor: ({ index, data }) => {
                    if (!data || !data.data) return [128, 128, 128, 160];
                    const row = data.data.get(index);
                    return colorScale(row["VEL_LA_EW"]).rgb();
                },
                getRadius: ({ index, data }) => {
                    if (!data || !data.data) return 5;
                    const row = data.data.get(index);
                    return row["VEL_LA_UP"] ? row["VEL_LA_UP"] * 5 : 5;
                },
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
                visible: false, // Starts OFF
                pickable: true,
            },
            name: 'GP (Client-side Color)',
            showVisibilityToggle: true,
        },
        {
            id: 'geoparquet-points-precomputed-color',
            type: GeoArrowScatterplotLayer,
            options: {
                data: jsTablePrecomputedColor, // Data state variable (initially null)
                getPosition: jsTablePrecomputedColor ? jsTablePrecomputedColor.getChild("geometry") : null,
                getFillColor: jsTablePrecomputedColor ? jsTablePrecomputedColor.getChild("colors") : null,
                getRadius: ({ index, data }) => {
                    if (!data || !data.data) return 5;
                    const row = data.data.get(index);
                    return row["VEL_LA_UP"] ? row["VEL_LA_UP"] * 5 : 5;
                },
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
                visible: false, // Starts OFF
                pickable: true,
            },
            name: 'GP (Precomputed Color)',
            showVisibilityToggle: true,
        },
        // --- NEW: Geometry Only GeoParquet Layer ---
        {
            id: 'geoparquet-points-geom-only',
            type: GeoArrowScatterplotLayer,
            options: {
                data: jsTableGeomOnly, // Data state variable (initially null)
                getPosition: jsTableGeomOnly ? jsTableGeomOnly.getChild("geometry") : null,
                getFillColor: [0, 200, 255, 180], // Static color since no attributes
                getRadius: 5, // Static radius since no attributes
                visible: false, // Starts OFF
                pickable: true,
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
            },
            name: 'GP EGMS (Geom Only)',
            showVisibilityToggle: true,
        },
        {
            id: 'geojson-points-client-color',
            type: GeoJsonLayer,
            options: {
                data: geoJsonClientColorData, // Data state variable (initially null)
                pointRadiusMinPixels: 2,
                getPointRadius: d => { // Ensure property names match your GeoJSON
                    return d.properties && d.properties.VEL_LA_UP ? d.properties.VEL_LA_UP * 5 : 5;
                },
                getFillColor: d => { // Ensure property names match your GeoJSON
                    return d.properties && d.properties.VEL_LA_EW !== undefined ? colorScale(d.properties.VEL_LA_EW).rgb() : [128, 128, 128, 160];
                },
                visible: false, // Starts OFF
                pickable: true,
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
            },
            name: 'GeoJSON (Client-side Color)',
            showVisibilityToggle: true,
        },
        {
            id: 'geojson-points-precomputed-color',
            type: GeoJsonLayer,
            options: {
                data: geoJsonPrecomputedColorData, // Data state variable (initially null)
                pointRadiusMinPixels: 2,
                getPointRadius: d => {
                    return d.properties && d.properties.VEL_LA_UP ? d.properties.VEL_LA_UP * 5 : 5;
                },
                getFillColor: d => {
                    return d.properties && d.properties.geojson_color ? d.properties.geojson_color : [128, 128, 128, 160];
                },
                visible: false, // Starts OFF
                pickable: true,
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
            },
            name: 'GeoJSON (Precomputed Color)',
            showVisibilityToggle: true,
        },
    ];

    // --- Dynamic Layer Generation ---
    const layers = useCallback(() => {
        return initialLayerConfigs.filter(config => {
            if (config.id === 'tile-layer') return true;
            return config.options.data !== null;
        }).map(config => createLayer(config, layerVisibility[config.id], layerProperties[config.id]));
    }, [
        jsTableClientColor, jsTablePrecomputedColor, jsTableGeomOnly, // NEW: Added jsTableGeomOnly
        geoJsonClientColorData, geoJsonPrecomputedColorData,
        layerVisibility, layerProperties
    ]);


    // --- WASM Initialization Effect (for parquet-wasm) ---
    useEffect(() => {
        console.log('GPG: useEffect triggered for WASM initialization.');
        if (!isWasmReady) {
            console.log('GPG: Starting WASM initialization (parquet-wasm)...');
            initWasm(`${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`)
                .then(() => {
                    console.log('GPG: WASM initialized successfully (parquet-wasm)!');
                    setIsWasmReady(true);
                })
                .catch(error => console.error('GPG: Failed to init WASM:', error));
        }
    }, [isWasmReady]);


    // --- Lazy Data Loading Effects ---
    // GeoParquet (Client-side Color)
    useEffect(() => {
        if (layerVisibility['geoparquet-points-client-color'] && !jsTableClientColor && isWasmReady) {
            console.time('Load_GP_ClientColor_Lazy');
            fetch(GEO_PARQUET_PATH_CLIENT_COLOR)
                .then(response => response.arrayBuffer())
                .then(arrayBuffer => readParquet(new Uint8Array(arrayBuffer)))
                .then(wasmTable => tableFromIPC(wasmTable.intoIPCStream()))
                .then(table => {
                    setJsTableClientColor(table);
                    console.timeEnd('Load_GP_ClientColor_Lazy');
                })
                .catch(error => console.error("Lazy Load Error (GP Client Color):", error));
        }
    }, [layerVisibility['geoparquet-points-client-color'], jsTableClientColor, isWasmReady]);

    // GeoParquet (Precomputed Color)
    useEffect(() => {
        if (layerVisibility['geoparquet-points-precomputed-color'] && !jsTablePrecomputedColor && isWasmReady) {
            console.time('Load_GP_PrecomputedColor_Lazy');
            fetch(GEO_PARQUET_PATH_PRECOMPUTED_COLOR)
                .then(response => response.arrayBuffer())
                .then(arrayBuffer => readParquet(new Uint8Array(arrayBuffer)))
                .then(wasmTable => tableFromIPC(wasmTable.intoIPCStream()))
                .then(table => {
                    setJsTablePrecomputedColor(table);
                    console.timeEnd('Load_GP_PrecomputedColor_Lazy');
                })
                .catch(error => console.error("Lazy Load Error (GP Precomputed Color):", error));
        }
    }, [layerVisibility['geoparquet-points-precomputed-color'], jsTablePrecomputedColor, isWasmReady]);

    // --- NEW: Lazy Load Effect for Geometry-Only GeoParquet ---
    useEffect(() => {
        if (layerVisibility['geoparquet-points-geom-only'] && !jsTableGeomOnly && isWasmReady) {
            console.time('Load_GP_GeomOnly_Lazy');
            fetch(GEO_PARQUET_PATH_EGMS_GEOM_ONLY)
                .then(response => response.arrayBuffer())
                .then(arrayBuffer => readParquet(new Uint8Array(arrayBuffer)))
                .then(wasmTable => tableFromIPC(wasmTable.intoIPCStream()))
                .then(table => {
                    setJsTableGeomOnly(table);
                    console.timeEnd('Load_GP_GeomOnly_Lazy');
                })
                .catch(error => console.error("Lazy Load Error (GP Geometry Only):", error));
        }
    }, [layerVisibility['geoparquet-points-geom-only'], jsTableGeomOnly, isWasmReady]);

    // GeoJSON (Client-side Color)
    useEffect(() => {
        if (layerVisibility['geojson-points-client-color'] && !geoJsonClientColorData) {
            console.time('Load_GeoJSON_ClientColor_Lazy');
            fetch(GEO_JSON_PATH_CLIENT_COLOR)
                .then(response => response.json())
                .then(data => {
                    setGeoJsonClientColorData(data);
                    console.timeEnd('Load_GeoJSON_ClientColor_Lazy');
                })
                .catch(error => console.error("Lazy Load Error (GeoJSON Client Color):", error));
        }
    }, [layerVisibility['geojson-points-client-color'], geoJsonClientColorData]);

    // GeoJSON (Precomputed Color)
    useEffect(() => {
        if (layerVisibility['geojson-points-precomputed-color'] && !geoJsonPrecomputedColorData) {
            console.time('Load_GeoJSON_PrecomputedColor_Lazy');
            fetch(GEO_JSON_PATH_PRECOMPUTED_COLOR)
                .then(response => response.json())
                .then(data => {
                    setGeoJsonPrecomputedColorData(data);
                    console.timeEnd('Load_GeoJSON_PrecomputedColor_Lazy');
                })
                .catch(error => console.error("Lazy Load Error (GeoJSON Precomputed Color):", error));
        }
    }, [layerVisibility['geojson-points-precomputed-color'], geoJsonPrecomputedColorData]);


    // --- GUI Setup Effect (Runs once on mount) ---
    useEffect(() => {
        const gui = new dat.GUI({ width: 350 });

        const initialViz = initialLayerConfigs.reduce((acc, config) => {
            acc[config.id] = config.options.visible;
            return acc;
        }, {});
        setLayerVisibility(initialViz);

        const initialProps = initialLayerConfigs.reduce((acc, config) => {
            if (config.controls) { acc[config.id] = {}; Object.keys(config.controls).forEach(key => { acc[config.id][key] = config.options[key]; }); }
            return acc;
        }, {});
        setLayerProperties(initialProps);


        initialLayerConfigs.forEach(config => {
            if (config.showVisibilityToggle) {
                gui.add(initialViz, config.id)
                    .name(config.name)
                    .onChange((value) => {
                        setLayerVisibility((prevState) => ({
                            ...prevState,
                            [config.id]: value,
                        }));
                    });
            }
        });

        // Add dropdown controls for properties of specific layers (if any)
        initialLayerConfigs.forEach(config => {
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
                        folder.add(initialProps[config.id], property, options).onChange((value) => {
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
    }, []); // Empty dependency array ensures this effect runs once on mount


    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layers()}
            className="deckgl-map"
        >
        </DeckGL>
    );
}

export default GeoParquet;

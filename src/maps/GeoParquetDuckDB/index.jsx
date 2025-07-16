// src/maps/GPDuckDB.jsx
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core'; // Added WebMercatorViewport
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer} from '@deck.gl/layers';
import * as dat from 'dat.gui'; // For the GUI controls

import { tableFromIPC } from "apache-arrow";
import { GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers'; // Layer for point data
import initWasm, {readParquet} from "parquet-wasm"; // parquet-wasm imports


// --- Configuration Constants ---
// Adjusted INITIAL_VIEW_STATE to Prague coordinates for the EGMS data
const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 13, // Start a bit zoomed out to see more data
    pitch: 0,
    bearing: 0,
};

// Define the URL for your Python backend API endpoint
const BACKEND_API_URL = 'http://localhost:5000/api/filtered-geoparquet';


// Helper function to create a layer instance (used internally by DeckGL)
const createLayer = (config, visibility, properties) => {
    const options = { ...config.options, id: config.id, visible: visibility };
    if (properties) {
        Object.keys(properties).forEach((key) => {
            options[key] = properties[key];
        });
    }
    return new config.type(options);
};


function GPDuckDB() { // Renamed component for clarity
    // --- State for Loaded Data ---
    const [isWasmReady, setIsWasmReady] = useState(false); // Tracks parquet-wasm initialization status
    const [jsTableFilteredData, setJsTableFilteredData] = useState(null); // Data filtered and served by the backend

    // --- State to track current viewport, crucial for backend queries ---
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

    // --- State for Layer Visibility and Properties (controlled by dat.GUI) ---
    const [layerVisibility, setLayerVisibility] = useState({});
    const [layerProperties, setLayerProperties] = useState({});

    const renderedLayerIds = useRef(new Set()); // Ref to track which layers have completed their initial render


    // --- Base Layer Configurations (no direct data state assignment here) ---
    // This array defines the base properties and types for all possible layers.
    // The 'data' prop will be assigned dynamically in layersToRender.
    const baseLayerConfigs = [ // Renamed from initialLayerConfigs for clarity in this pattern
        {
            id: 'tile-layer',
            type: TileLayer,
            options: {
                data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                minZoom: 0, maxZoom: 19, tileSize: 256, visible: true,
                renderSubLayers: (props) => {
                    const { bbox: { west, south, east, north } = {} } = props.tile || {};
                    return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
                },
            },
            name: 'Basemap', showVisibilityToggle: true,
        },
        {
            id: 'geoparquet-filtered-data', // Specific ID for this filtered layer
            type: GeoArrowScatterplotLayer, // For point data (from EGMS_L2b_146_0296_IW2_VV_2019_2023_1_geom_only.parquet)
            options: {
                // data: jsTableFilteredData, <--- NOT HERE. Assigned dynamically below.
                getPosition: null, // Will be set dynamically from jsTableFilteredData.getChild("geometry")
                getFillColor: [255, 0, 0, 180], // Static red color
                getRadius: 5,
                visible: true, // Start visible to see the initial load
                pickable: true,
                stroked: true,
                getLineColor: [50, 50, 50, 160],
                getLineWidth: 0.5,
            },
            name: 'DuckDB Filtered Points',
            showVisibilityToggle: true,
        },
    ];

    // --- Dynamic Layer Generation for DeckGL ---
    // This `useCallback` hook generates the actual array of Deck.gl layer instances
    // to be passed to the <DeckGL> component, dynamically assigning data and filtering by readiness.
    const layersToRender = useCallback(() => {
        // Create a temporary array to hold the full layer configurations with current data/accessors
        const currentLayerConfigs = baseLayerConfigs.map(baseConfig => {
            // Clone the base config to modify its options
            const config = { ...baseConfig, options: { ...baseConfig.options } };

            // Dynamically assign 'data' and specific accessors based on current state
            if (config.id === 'geoparquet-filtered-data') {
                config.options.data = jsTableFilteredData;
                config.options.getPosition = jsTableFilteredData ? jsTableFilteredData.getChild("geometry") : null;
                // Add other accessors that depend on jsTableFilteredData here, if they need to be dynamic
            }
            // Add other layer types here if they depend on other specific data states
            // e.g., if (config.id === 'geojson-layer') { config.options.data = geoJsonData; ... }

            return config;
        });

        // Filter out layers that do not have their data loaded (data is null)
        return currentLayerConfigs.filter(config => {
            if (config.id === 'tile-layer') return true; // Basemap is always included
            return config.options.data !== null; // Only include if data is loaded
        }).map(config => createLayer(config, layerVisibility[config.id], layerProperties[config.id]));
    }, [
        jsTableFilteredData, // Layer redraws when filtered data changes
        layerVisibility, layerProperties // Trigger when visibility/properties change via GUI
    ]);


    // --- WASM Initialization Effect (for parquet-wasm) ---
    // Runs once on component mount to initialize the parquet-wasm module.
    useEffect(() => {
        console.log('GPDuckDB: useEffect triggered for WASM initialization.');
        if (!isWasmReady) {
            console.log('GPDuckDB: Starting WASM initialization (parquet-wasm)...');
            initWasm(`${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`)
                .then(() => {
                    console.log('GPDuckDB: WASM initialized successfully (parquet-wasm)!');
                    setIsWasmReady(true);
                })
                .catch(error => console.error('GPDuckDB: Failed to init WASM:', error));
        }
    }, [isWasmReady]); // Dependency: re-run only if isWasmReady is false (on initial mount)


    // --- Lazy Data Loading Effect for DuckDB Backend Data ---
    // This effect triggers data loading from the backend whenever the viewState changes.
    // It also waits for WASM to be ready.
    useEffect(() => {
        // Only proceed if WASM is ready and we have a valid viewState
        if (isWasmReady && viewState) {
            // Calculate current viewport bounding box
            const viewport = new WebMercatorViewport(viewState);
            const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();

            // Construct the API URL with bbox parameters
            const backendQueryUrl = `${BACKEND_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}`;

            const timerLabel = `Load_DuckDB_Filtered_Z${viewState.zoom.toFixed(0)}`;
            console.time(timerLabel);
            console.log(`GPDuckDB: Starting backend-filtered load from: ${backendQueryUrl}`);

            fetch(backendQueryUrl)
                .then(response => {
                    if (!response.ok) {
                        throw new Error(`HTTP error! Status: ${response.status} ${response.statusText}`);
                    }
                    return response.arrayBuffer();
                })
                .then(arrayBuffer => readParquet(new Uint8Array(arrayBuffer))) // Read the small filtered GeoParquet
                .then(wasmTable => tableFromIPC(wasmTable.intoIPCStream()))
                .then(table => {
                    console.log(`GPDuckDB: Backend-filtered data loaded successfully. Rows: ${table.numRows}`);
                    setJsTableFilteredData(table); // Update state with the new filtered data
                    console.timeEnd(timerLabel);
                })
                .catch(error => {
                    console.error("GPDuckDB: Backend Load Error (Filtered Data):", error);
                    setJsTableFilteredData(null); // Reset data on error
                });
        } else {
            console.log(`GPDuckDB: Filtered data load condition not met: wasmReady=${isWasmReady}, viewState=${!!viewState}`);
        }
    }, [isWasmReady, viewState]); // Trigger when WASM is ready or viewState changes


    // --- GUI Setup Effect (Runs once on mount) ---
    useEffect(() => {
        const gui = new dat.GUI({ width: 350 });

        // Initialize layerVisibility and layerProperties states for dat.GUI controls.
        // These are based on the 'baseLayerConfigs' defined above.
        const initialViz = baseLayerConfigs.reduce((acc, config) => {
            acc[config.id] = config.options.visible;
            return acc;
        }, {});
        setLayerVisibility(initialViz);

        const initialProps = baseLayerConfigs.reduce((acc, config) => {
            if (config.controls) { acc[config.id] = {}; Object.keys(config.controls).forEach(key => { acc[config.id][key] = config.options[key]; }); }
            return acc;
        }, {});
        setLayerProperties(initialProps);

        // Add visibility controls for each layer to dat.gui
        baseLayerConfigs.forEach(config => {
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
        baseLayerConfigs.forEach(config => {
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
            // Crucial: Update viewState on map interaction (pan, zoom)
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layersToRender()} // Call layersToRender() to get the dynamically generated layers array
            className="deckgl-map"
        >
        </DeckGL>
    );
}

export default GPDuckDB;

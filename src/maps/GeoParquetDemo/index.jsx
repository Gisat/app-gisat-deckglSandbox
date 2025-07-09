// src/maps/GPDemo.jsx
import React, { useEffect, useState, useCallback, useRef } from 'react'; // Added useCallback, useRef
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer } from '@deck.gl/layers'; // Corrected BitmapLayer import
import * as dat from 'dat.gui'; // For the GUI controls
import { tableFromIPC } from "apache-arrow"; // For converting WASM output to Apache Arrow Table
import { GeoArrowSolidPolygonLayer } from '@geoarrow/deck.gl-layers'; // Layer for solid polygons
import initWasm, {readParquet} from "parquet-wasm"; // parquet-wasm imports for reading .parquet files


const INITIAL_VIEW_STATE = {
    longitude: -111.89411386472318, // Adjusted for Utah data
    latitude: 40.75150168091724,
    zoom: 11,
    pitch: 0,
    bearing: 0,
};

// Data URL for the polygon file (moved from top-level await)
const POLYGON_GEO_PARQUET_PATH = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/demo_data/Utah@1.parquet';


// Helper function to create a Deck.gl layer instance from its configuration
const createLayer = (config, visibility, properties) => {
    const options = { ...config.options, id: config.id, visible: visibility };
    if (properties) {
        Object.keys(properties).forEach((key) => {
            options[key] = properties[key];
        });
    }
    return new config.type(options);
};


function GeoParquet() { // Component name based on your file
    // --- State for Loaded Data ---
    // isWasmReady tracks if parquet-wasm is initialized and ready to use.
    const [isWasmReady, setIsWasmReady] = useState(false);
    // jsTablePolygonData holds the loaded Apache Arrow Table for the polygon data.
    const [jsTablePolygonData, setJsTablePolygonData] = useState(null);

    // --- State for Layer Visibility and Properties (controlled by dat.GUI) ---
    // These are initialized within the first useEffect based on initialLayerConfigs.
    const [layerVisibility, setLayerVisibility] = useState({});
    const [layerProperties, setLayerProperties] = useState({});

    // Ref to track which layers have completed their initial render (for console.timeEnd measurement)
    const renderedLayerIds = useRef(new Set());


    // --- Define Initial Layer Configurations ---
    // This array holds the base configuration for all layers available in the app.
    // Data layer starts hidden (`visible: false`) to enable lazy loading on GUI toggle.
    const initialLayerConfigs = [
        {
            id: 'tile-layer',
            type: TileLayer,
            options: {
                data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
                minZoom: 0, maxZoom: 19, tileSize: 256, visible: true, // Basemap visible by default
                renderSubLayers: (props) => {
                    // Safely destructure bbox, providing default empty object if props.tile or props.tile.bbox is undefined
                    const { bbox: { west, south, east, north } = {} } = props.tile || {};
                    return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
                },
            },
            name: 'Basemap', showVisibilityToggle: true,
        },
        {
            id: 'geoparquet-buildings',
            type: GeoArrowSolidPolygonLayer, // Using Solid Polygon Layer for building footprints
            options: {
                data: jsTablePolygonData, // Data state variable (initially null), will be populated via lazy loading
                // getPolygon accessor needs to be conditional as jsTablePolygonData is null initially
                getPolygon: jsTablePolygonData ? jsTablePolygonData.getChild("GEOMETRY") : null, // Access geometry column (all caps) from Arrow Table
                getFillColor: [0, 100, 60, 160], // Static fill color for buildings
                visible: false, // Starts OFF, loads on toggle via GUI
                pickable: true, // Enable picking for user interaction
            },
            name: 'GeoParquet Buildings', // Descriptive name for GUI
            showVisibilityToggle: true,
        },
    ];

    // --- Dynamic Layer Generation for DeckGL ---
    // This `useCallback` hook generates the actual array of Deck.gl layer instances
    // to be passed to the <DeckGL> component. It filters out layers whose data is not yet loaded.
    const layers = useCallback(() => {
        return initialLayerConfigs.filter(config => {
            // Basemap layer is always included regardless of its data state (it loads from URL directly)
            if (config.id === 'tile-layer') return true;

            // For data layers, only include them if their 'data' prop (the state variable) is not null.
            // This prevents Deck.gl from trying to initialize layers with null data, avoiding errors.
            return config.options.data !== null;
        }).map(config => createLayer(config, layerVisibility[config.id], layerProperties[config.id]));
    }, [
        // Dependencies for this useCallback:
        // The array of layers needs to be regenerated if:
        jsTablePolygonData, // Polygon data loads
        layerVisibility,    // Visibility toggles change
        layerProperties     // Layer properties change via GUI
    ]);


    // --- WASM Initialization Effect (for parquet-wasm) ---
    // This effect runs once on component mount to initialize the parquet-wasm module.
    // It uses 'isWasmReady' state to ensure initialization happens only once.
    useEffect(() => {
        console.log('GPDemo: useEffect triggered for WASM initialization.');
        if (!isWasmReady) { // Only initialize if WASM is not already marked as ready
            console.log('GPDemo: Starting WASM initialization (parquet-wasm)...');
            initWasm(`${import.meta.env.BASE_URL}esm/parquet_wasm_bg.wasm`)
                .then(() => {
                    console.log('GPDemo: WASM initialized successfully (parquet-wasm)!');
                    setIsWasmReady(true); // Set state to true when WASM is ready
                })
                .catch(error => console.error('GPDemo: Failed to init WASM:', error));
        }
    }, [isWasmReady]); // Dependency: re-run only if isWasmReady is false (on initial mount)


    // --- Lazy Data Loading Effect for Polygon GeoParquet ---
    // This effect triggers data loading for the polygon layer.
    // It runs when:
    // 1. 'geoparquet-buildings' layer visibility is true.
    // 2. Polygon data (jsTablePolygonData) is null (not yet loaded).
    // 3. WASM module (isWasmReady) is initialized.
    useEffect(() => {
        if (layerVisibility['geoparquet-buildings'] && !jsTablePolygonData && isWasmReady) {
            console.time('Load_GP_Buildings_Lazy'); // Start timer for lazy data load
            console.log(`GPDemo: Starting to load GeoParquet Polygon data from: ${POLYGON_GEO_PARQUET_PATH}`);
            fetch(POLYGON_GEO_PARQUET_PATH)
                .then(response => {
                    if (!response.ok) { // Check for HTTP errors
                        throw new Error(`HTTP error! Status: ${response.status}`);
                    }
                    return response.arrayBuffer(); // Read response as ArrayBuffer
                })
                .then(arrayBuffer => readParquet(new Uint8Array(arrayBuffer))) // Decode Parquet using WASM
                .then(wasmTable => tableFromIPC(wasmTable.intoIPCStream())) // Convert to Apache Arrow Table
                .then(table => {
                    console.log('GPDemo: GeoParquet Polygon data loaded successfully:', table);
                    setJsTablePolygonData(table); // Update state with the loaded data
                    console.timeEnd('Load_GP_Buildings_Lazy'); // End timer
                })
                .catch(error => {
                    console.error("GPDemo: Lazy Load Error (GP Buildings):", error);
                    setJsTablePolygonData(null); // Reset state to null if loading fails
                });
        }
    }, [layerVisibility['geoparquet-buildings'], jsTablePolygonData, isWasmReady]); // Dependencies: trigger on visibility, data state, WASM readiness


    // --- GUI Setup Effect (Runs once on mount) ---
    useEffect(() => {
        const gui = new dat.GUI({ width: 350 }); // Initialize dat.gui with a custom width

        // Initialize layerVisibility and layerProperties states for dat.GUI controls.
        // This ensures the GUI correctly reflects initial 'visible' states (all data layers OFF by default).
        const initialViz = initialLayerConfigs.reduce((acc, config) => {
            acc[config.id] = config.options.visible;
            return acc;
        }, {});
        setLayerVisibility(initialViz); // Set initial visibility state

        const initialProps = initialLayerConfigs.reduce((acc, config) => {
            if (config.controls) { acc[config.id] = {}; Object.keys(config.controls).forEach(key => { acc[config.id][key] = config.options[key]; }); }
            return acc;
        }, {});
        setLayerProperties(initialProps); // Set initial properties state

        // Add visibility controls for each layer to dat.gui
        initialLayerConfigs.forEach(config => {
            if (config.showVisibilityToggle) {
                gui.add(initialViz, config.id) // Bind GUI control to the initial visibility object
                    .name(config.name) // Display layer name in GUI
                    .onChange((value) => { // Callback when GUI toggle changes
                        setLayerVisibility((prevState) => ({
                            ...prevState,
                            [config.id]: value, // Update React state for layer visibility
                        }));
                    });
            }
        });

        // Add dropdown controls for properties of specific layers (if any)
        initialLayerConfigs.forEach(config => {
            if (config.controls) {
                const folder = gui.addFolder(config.name + ' Properties'); // Create a folder in GUI
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
                        folder.add(initialProps[config.id], property, options).onChange((value) => { // Bind to initialProps for GUI, update state on change
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

        // Cleanup dat.gui on unmount to prevent memory leaks
        return () => {
            gui.destroy();
        };
    }, []); // Empty dependency array ensures this effect runs only once on component mount


    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            controller={true} // Enable map controls (pan, zoom, rotate)
            views={new MapView({ repeat: true })} // Use MapView for standard 2D map interaction
            layers={layers()} // Call layers() to get the dynamically generated layers array
            className="deckgl-map" // CSS class for styling the map container
        >
        </DeckGL>
    );
}

export default GeoParquet;

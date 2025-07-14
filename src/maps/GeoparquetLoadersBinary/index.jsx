// src/maps/GeoparquetLoadersBinary.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer } from '@deck.gl/layers';
import { GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers'; // Layer for optimized Arrow Table rendering

// loaders.gl imports for Parquet loading
import { load } from '@loaders.gl/core';
import { ParquetWasmLoader } from '@loaders.gl/parquet';
// Note: 'apache-arrow' Table type is internally returned by ParquetWasmLoader,
// so explicit import 'Table' is not strictly needed here for basic use.


// --- Configuration ---
const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 15,
    pitch: 0,
    bearing: 0,
};

// URL to the GeoParquet file
// not zipped file
// const GEO_PARQUET_FILE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet';
// zipped file
const GEO_PARQUET_FILE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK_zipped.parquet';

function GeoparquetLoadersBinary() {
    console.log('GPLBinary: Component rendering...');

    // State to hold the loaded Apache Arrow Table instance
    // Initialized to null, will be set once data is loaded asynchronously.
    const [geoParquetData, setGeoParquetData] = useState(null);


    // Effect to load the GeoParquet data using loaders.gl with ParquetWasmLoader
    // This effect runs once on component mount to initiate data loading.
    useEffect(() => {
        console.log('GPLBinary: useEffect triggered for data loading.');

        // Only load data if it hasn't been loaded yet (i.e., geoParquetData is null)
        if (!geoParquetData) {
            console.time('Load_GeoParquet_Time'); // Start timer for data loading
            console.log(`GeoparquetLoadersBinary: Starting to load GeoParquet from: ${GEO_PARQUET_FILE_URL}`);

            // Use loaders.gl's load function with ParquetWasmLoader.
            // ParquetWasmLoader internally leverages WASM and is designed to return
            // an object where 'data' property is an Apache Arrow Table instance.
            load(GEO_PARQUET_FILE_URL, ParquetWasmLoader)
                .then(result => {
                    // 'result.data' contains the actual Apache Arrow Table instance
                    const loadedArrowTable = result.data;

                    console.log('GPLBinary: GeoParquet loaded successfully (as Arrow Table):', loadedArrowTable);
                    setGeoParquetData(loadedArrowTable); // Update state with the loaded Table
                    console.timeEnd('Load_GeoParquet_Time'); // End timer
                })
                .catch(error => {
                    console.error('GPLBinary: CRITICAL ERROR during GeoParquet loading:', error);
                    setGeoParquetData(null); // Reset state to null if loading fails
                });
        }

    }, [geoParquetData]); // Dependency: Re-run only if geoParquetData becomes null (on initial load)


    // Conditionally define the GeoArrowScatterplotLayer
    // The layer is created only when geoParquetData is not null (i.e., data is loaded).
    const geoParquetScatterplotLayer = geoParquetData ?
        new GeoArrowScatterplotLayer({
            id: 'geo-parquet-points', // Unique ID for the layer
            data: geoParquetData, // Pass the loaded Apache Arrow Table

            // Accessors: use getChild("geometry") directly on the Arrow Table
            // The conditional check ensures getChild is only called when data is ready.
            getPosition: geoParquetData.getChild("geometry"),

            getFillColor: [255, 0, 0, 160], // Simple red color for points
            getRadius: 5, // Radius in meters
            stroked: true,
            getLineColor: [50, 50, 50, 160],
            getLineWidth: 0.5,
            visible: true, // Layer is visible once data is loaded
            pickable: true, // Enable picking for interaction
        }) : null; // If geoParquetData is null, the layer instance is null


    // Define layers to be rendered by DeckGL
    const layers = [
        // Basemap Layer (always visible)
        new TileLayer({
            id: 'basemap-layer',
            data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            visible: true,
            renderSubLayers: (props) => {
                // Safely destructure bbox, providing default empty object if props.tile or props.tile.bbox is undefined
                const { bbox: { west, south, east, north } = {} } = props.tile || {};
                return new BitmapLayer(props, {
                    data: null, // Image data (from props.data which is the tile image)
                    image: props.data,
                    bounds: [west, south, east, north], // Bounds for the image
                });
            },
        }),
        // Add the GeoParquet data layer only if it's not null (i.e., data has been loaded)
        // The spread operator `...` ensures that `null` is skipped if geoParquetScatterplotLayer is null.
        ...(geoParquetScatterplotLayer ? [geoParquetScatterplotLayer] : []),
    ];

    // Log the number of loaded data points for debugging/verification.
    // Access numRows property of the Apache Arrow Table, or 0 if null.
    console.log('GPLBinary: Layers prepared. Data loaded? (Total rows):', geoParquetData ? geoParquetData.numRows : 0);

    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            controller={true} // Enable map controls (pan, zoom, rotate)
            views={new MapView({ repeat: true })} // Use MapView for standard 2D map interaction
            layers={layers} // Pass the array of Deck.gl layers
            className="deckgl-map" // CSS class for styling
        >
        </DeckGL>
    );
}

export default GeoparquetLoadersBinary;

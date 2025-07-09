// src/maps/GeoparquetLoadersJSObjects.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers'; // TileLayer from geo-layers
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers'; // BitmapLayer, ScatterplotLayer from layers

// loaders.gl imports for Parquet loading
import { load, loadInBatches } from '@loaders.gl/core'; // Core loading functions
import { ParquetLoader } from '@loaders.gl/parquet'; // Parquet loader that outputs plain JS objects


// --- Configuration ---
const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 15,
    pitch: 0,
    bearing: 0,
};

// URL to the GeoParquet file
const GEO_PARQUET_FILE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet';

// --- Toggle between full load and batch load ---
// Set to 'true' for incremental batch loading, 'false' for single full file load.
const LOAD_IN_BATCHES = true;
// --- End Configuration ---


function GeoparquetLoadersJSObjects() { // Renamed component
    console.log('GPLJSObjects: Component rendering...');

    // State to hold the loaded GeoParquet data.
    // It will be an array of JavaScript objects (rows), accumulating in batch mode.
    const [geoParquetData, setGeoParquetData] = useState([]);

    // Effect to handle data loading (either full file or in batches)
    // Runs once on component mount to initiate data loading based on LOAD_IN_BATCHES.
    useEffect(() => {
        console.log('GPLJSObjects: useEffect triggered for data loading.');

        // Only load data if the array is currently empty (i.e., first load)
        if (geoParquetData.length === 0) {
            if (LOAD_IN_BATCHES) {
                // --- Batch Loading Logic ---
                console.time('Load_Parquet_Batches_Time');
                console.log(`GPLJSObjects: Starting to load GeoParquet in batches from: ${GEO_PARQUET_FILE_URL}`);

                const loadDataInBatches = async () => {
                    try {
                        // loadInBatches returns an AsyncIterable of data batches (plain JS objects/arrays)
                        const batches = await loadInBatches(GEO_PARQUET_FILE_URL, ParquetLoader, {
                            // ParquetLoader option: get rows as plain JS objects per batch
                            parquet: { columnar: false }
                        });

                        let batchCount = 0;
                        let totalRows = 0;

                        // Iterate over each batch asynchronously
                        for await (const batch of batches) {
                            batchCount++;
                            totalRows += batch.data.length; // batch.data is an array of row objects for this batch
                            console.log(`GPLJSObjects: Batch ${batchCount} loaded (${batch.data.length} rows). Total rows so far: ${totalRows}`);

                            // Append data from the current batch to the component state
                            setGeoParquetData(prevData => [...prevData, ...batch.data]);
                        }

                        console.log(`GPLJSObjects: Finished loading all batches. Final total rows: ${totalRows}`);
                        console.timeEnd('Load_Parquet_Batches_Time');

                    } catch (error) {
                        console.error('GPLJSObjects: CRITICAL ERROR during batch loading:', error);
                        setGeoParquetData([]); // Reset to empty array on error
                    }
                };

                loadDataInBatches(); // Initiate the async batch loading function

            } else {
                // --- Full File Loading Logic ---
                console.time('Load_Parquet_Full_Time');
                console.log(`GPLJSObjects: Starting to load GeoParquet (full file) from: ${GEO_PARQUET_FILE_URL}`);

                // load() returns a Promise that resolves to the full parsed data (plain JS object/array)
                load(GEO_PARQUET_FILE_URL, ParquetLoader, {
                    parquet: { columnar: false } // Option for full file load to get plain JS row objects
                })
                    .then(result => {
                        console.log('GPLJSObjects: Full GeoParquet file loaded:', result);
                        // result.data contains the array of row objects for the full file
                        setGeoParquetData(result.data);
                        console.timeEnd('Load_Parquet_Full_Time');
                    })
                    .catch(error => {
                        console.error('GPLJSObjects: CRITICAL ERROR during full file loading:', error);
                        setGeoParquetData([]); // Reset to empty array on error
                    });
            }
        }

    }, []); // Empty dependency array ensures this effect runs only once on mount.


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
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north],
                });
            },
        }),

        // GeoParquet Data Layer (using ScatterplotLayer for plain JS objects)
        // This layer automatically updates as 'geoParquetData' accumulates batches.
        new ScatterplotLayer({
            id: 'test-geoparquet-layer',
            data: geoParquetData, // Pass the accumulating array of row objects

            // Accessors read directly from properties of the plain JS row object 'd'
            // Ensure LON_CENTER and LAT_CENTER are the correct column names in your data.
            getPosition: d => [Number(d.LON_CENTER), Number(d.LAT_CENTER)],
            getFillColor: [255, 0, 0, 160], // Simple red color (RGBA)
            getRadius: 5, // Radius in meters
            visible: true,
            pickable: true,
        }),
    ];

    // Log the number of loaded data points for debugging/verification.
    // Access .length property of the JavaScript array.
    console.log('GPLJSObjects: Layers prepared. Data loaded? (Total rows):', geoParquetData.length);

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

export default GeoparquetLoadersJSObjects;

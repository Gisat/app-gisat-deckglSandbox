// src/maps/MapApp2.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
// Import both load and loadInBatches
import { load, loadInBatches } from '@loaders.gl/core';
import { ParquetLoader } from '@loaders.gl/parquet';


// --- Configuration ---
const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 15,
    pitch: 0,
    bearing: 0,
};

const TEST_GEO_PARQUET_PATH = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet';

// --- NEW CONFIGURATION CONSTANT ---
const LOAD_IN_BATCHES = false; // Set to 'true' for batch loading, 'false' for full file load
// --- END NEW CONFIGURATION CONSTANT ---


function MapApp2() {
    console.log('MapApp2: Component rendering...');

    const [geoParquetData, setGeoParquetData] = useState([]);

    useEffect(() => {
        console.log('MapApp2: useEffect triggered for data loading.');

        // Only load if the array is empty (first load)
        if (geoParquetData.length === 0) {
            if (LOAD_IN_BATCHES) {
                // --- Batch Loading Logic ---
                console.time('MapApp2_Load_Parquet_Batches');
                console.log(`MapApp2: Starting to load GeoParquet in batches from: ${TEST_GEO_PARQUET_PATH}`);

                const loadDataInBatches = async () => {
                    try {
                        const batches = await loadInBatches(TEST_GEO_PARQUET_PATH, ParquetLoader, {
                            parquet: { columnar: false }
                        });

                        let batchCount = 0;
                        let totalRows = 0;

                        for await (const batch of batches) {
                            batchCount++;
                            totalRows += batch.data.length;
                            console.log(`MapApp2: Batch ${batchCount} loaded (${batch.data.length} rows). Total rows so far: ${totalRows}`);

                            setGeoParquetData(prevData => [...prevData, ...batch.data]);
                        }

                        console.log(`MapApp2: Finished loading all batches. Final total rows: ${totalRows}`);
                        console.timeEnd('MapApp2_Load_Parquet_Batches');

                    } catch (error) {
                        console.error('MapApp2: Error loading GeoParquet in batches:', error);
                        setGeoParquetData([]);
                    }
                };

                loadDataInBatches();

            } else {
                // --- Full File Loading Logic ---
                console.time('MapApp2_Load_Parquet_Full');
                console.log(`MapApp2: Starting to load GeoParquet (full file) from: ${TEST_GEO_PARQUET_PATH}`);

                load(TEST_GEO_PARQUET_PATH, ParquetLoader, { parquet: { columnar: false } })
                    .then(result => {
                        console.log('MapApp2: Full GeoParquet file loaded:', result);
                        // result.data will be the Array of row objects for full load
                        setGeoParquetData(result.data);
                        console.timeEnd('MapApp2_Load_Parquet_Full');
                    })
                    .catch(error => {
                        console.error('MapApp2: Error loading full GeoParquet file:', error);
                        setGeoParquetData([]);
                    });
            }
        }

    }, []);


    // Define layers to be rendered
    const layers = [
        // Basemap Layer
        new TileLayer({
            id: 'basemap-layer',
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
        }),

        // GeoParquet Data Layer (using ScatterplotLayer for plain JS objects)
        new ScatterplotLayer({
            id: 'test-geoparquet-layer',
            data: geoParquetData, // This will be an accumulating array of row objects

            // Accessors now read directly from properties of the plain JS row object 'd'
            getPosition: d => [Number(d.LON_CENTER), Number(d.LAT_CENTER)],
            getFillColor: [255, 0, 0, 160],
            getRadius: 5,
            visible: true,
            pickable: true,
        }),
    ];

    console.log('MapApp2: Layers prepared. Data loaded? (Total rows):', geoParquetData.length);

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

export default MapApp2;

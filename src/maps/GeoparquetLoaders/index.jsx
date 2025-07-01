// src/maps/MapApp2.jsx
import React, { useEffect, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import {TileLayer} from '@deck.gl/geo-layers';
import {BitmapLayer, ScatterplotLayer } from '@deck.gl/layers'; // <-- Changed: import ScatterplotLayer
// GeoArrowScatterplotLayer might still be imported but won't be used with this data
// import { GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-layers';
import { load } from '@loaders.gl/core';
import { ParquetLoader } from '@loaders.gl/parquet';
// No need for Table or tableFromIPC if using ScatterplotLayer with object-row-table
// import { Table, tableFromIPC } from 'apache-arrow';


// --- Configuration ---
const INITIAL_VIEW_STATE = {
    longitude: 14.440015596229106,
    latitude: 50.05104860235221,
    zoom: 15,
    pitch: 0,
    bearing: 0,
};

const TEST_GEO_PARQUET_PATH = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/sipky/compo_area_vellast_sipky_MK.parquet';


function MapApp2() {
    console.log('MapApp2: Component rendering...');

    // This state will now hold the plain JavaScript object from loaders.gl
    const [geoParquetData, setGeoParquetData] = useState(null);

    useEffect(() => {
        console.log('MapApp2: useEffect triggered for data loading.');

        if (!geoParquetData) {
            console.time('MapApp2_Load_Parquet');
            console.log(`MapApp2: Starting to load GeoParquet from: ${TEST_GEO_PARQUET_PATH}`);

            // We expect object-row-table output from loaders.gl for ScatterplotLayer
            load(TEST_GEO_PARQUET_PATH, ParquetLoader, { parquet: { columnar: false } }) // Explicitly request object-row-table
                .then(result => {
                    console.log('MapApp2: Raw data from loaders.gl (object-row-table):', result);

                    // Store the plain JS data directly
                    // result.data will be the Array(64027) of row objects
                    setGeoParquetData(result.data);
                    console.timeEnd('MapApp2_Load_Parquet');
                })
                .catch(error => {
                    console.error('MapApp2: Error loading GeoParquet:', error);
                    setGeoParquetData(null);
                });
        }

    }, [geoParquetData]);


    // Define layers to be rendered
    const layers = [
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

        // --- Using ScatterplotLayer for plain JS data ---
        new ScatterplotLayer({ // Changed from GeoArrowScatterplotLayer
            id: 'test-geoparquet-layer',
            data: geoParquetData, // Pass the plain JS array of objects

            // Accessors now read directly from properties of the plain JS row object 'd'
            getPosition: d => [Number(d.LON_CENTER), Number(d.LAT_CENTER)], // Assuming 'longitude' and 'latitude' are property names in your row objects
            getFillColor: [255, 0, 0, 160],
            getRadius: 5,
            visible: true,
            pickable: true,
        }),
    ];

    console.log('MapApp2: Layers prepared. Data loaded?', !!geoParquetData);

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

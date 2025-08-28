// src/maps/PolygonMap3D.jsx
import React, { useEffect, useState, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { PolygonLayer, BitmapLayer } from '@deck.gl/layers';
import { load } from '@loaders.gl/core';
import { ArrowLoader } from '@loaders.gl/arrow';

function useDebounce(value, delay) {
    const [debouncedValue, setDebouncedValue] = useState(value);
    useEffect(() => {
        const handler = setTimeout(() => { setDebouncedValue(value); }, delay);
        return () => { clearTimeout(handler); };
    }, [value, delay]);
    return debouncedValue;
}


const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 14, pitch: 45, bearing: 0, minPitch: 30 };
const DATA_API_URL = 'http://localhost:5001/api/polygon-data';
const riskColors = {
    0: [237, 248, 251],
    1: [191, 211, 230],
    2: [158, 188, 218],
    3: [140, 150, 198],
    4: [136, 86, 167],
    5: [129, 15, 124]
};

function PolygonMap3D() {
    const [data, setData] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [isLoading, setIsLoading] = useState(true);
    const mapContainerRef = useRef(null);
    const debouncedViewState = useDebounce(viewState, 300);

    useEffect(() => {
        if (!mapContainerRef.current || mapContainerRef.current.clientWidth === 0) return;
        const { clientWidth, clientHeight } = mapContainerRef.current;
        const viewport = new WebMercatorViewport({ ...debouncedViewState, width: clientWidth, height: clientHeight });
        const [minLon, minLat, maxLon, maxLat] = viewport.getBounds();
        const backendQueryUrl = `${DATA_API_URL}?minx=${minLon}&miny=${minLat}&maxx=${maxLon}&maxy=${maxLat}`;

        setIsLoading(true);

        // ✅ Use the same 'object-row-table' shape as your working point map
        load(backendQueryUrl, ArrowLoader, { arrow: { shape: 'object-row-table' } })
            .then(loadedData => {
                // ✅ ADD THIS LINE to see what the loader is returning
                console.log("Data received from loader:", loadedData);
                // ✅ Since 'geometry' is a GeoJSON string, we must parse it
                const finalData = loadedData.data.map(d => ({
                    ...d,
                    geometry: JSON.parse(d.geometry)
                }));
                console.log(finalData);
                setData(finalData);
            })
            .catch(error => console.error("Backend Load Error:", error))
            .finally(() => setIsLoading(false));
    }, [debouncedViewState]);

    const layers = [
        new TileLayer({
            id: 'tile-layer', data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new PolygonLayer({
            id: 'polygon-layer',
            data,
            extruded: true,
            // ✅ Use simple accessors because 'data' is now a simple array of objects
            getPolygon: d => d.geometry.coordinates[0],
            getElevation: d => d.h,
            getFillColor: (d) => riskColors[d.cl_risk_e3] || [255, 255, 255, 255],
            getLineColor: [80, 80, 80],
            lineWidthMinPixels: 1,
            pickable: true,
        })
    ];

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            {isLoading && <div style={{position: 'absolute', top: 10, left: 10, background: 'white', padding: 5, zIndex: 2}}>Loading...</div>}
            <DeckGL
                initialViewState={INITIAL_VIEW_STATE}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
            />
        </div>
    );
}

export default PolygonMap3D;

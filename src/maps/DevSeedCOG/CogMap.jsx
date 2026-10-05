import { useState, useCallback, useRef } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import {CogBitmapLayer} from "@gisatcz/deckgl-geolib";
import chroma from "chroma-js";
import { cartoLightBasemapUrl } from '../basemaps';

const INITIAL_VIEW_STATE = {
    longitude: 0,
    latitude: 0,
    zoom: 2,
    bearing: 0,
    pitch: 0,
};

const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/ndviMAX_2025_11_blues_cog.tif';

function CogMap() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [showCogLayer, setShowCogLayer] = useState(true);
    const [showCogBitmapLayer, setShowCogBitmapLayer] = useState(true);
    const hasFittedBounds = useRef(false);

    const onCogLoad = useCallback((tiff, options) => {
        if (hasFittedBounds.current) return;
        hasFittedBounds.current = true;
        const { west, south, east, north } = options.geographicBounds;
        setViewState(currentViewState => {
            const viewport = new WebMercatorViewport({ ...currentViewState, width: window.innerWidth, height: window.innerHeight });
            const newViewState = viewport.fitBounds(
                [[west, south], [east, north]],
                { padding: 40 }
            );
            return { ...currentViewState, ...newViewState };
        });
    }, []);

    const cogLayer = new COGLayer({
        id: 'cog-layer',
        geotiff: COG_URL,
        onGeoTIFFLoad: onCogLoad
    });

    const cogBitmapLayer = new CogBitmapLayer({
        id: 'cog-bitmap-layer',
        rasterData: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/COG_ndviMAX_2021_11.tif',
        isTiled: true,
        cogBitmapOptions: {
            type: 'image',
            blurredTexture: false,
            useChannel: 1,
            useHeatMap: true,
            colorScale: chroma.brewer.Reds,
            colorScaleValueRange: [-5000, 9000],
        }
    });

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: cartoLightBasemapUrl,
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        }),
        ...(showCogLayer ? [cogLayer] : []),
        ...(showCogBitmapLayer ? [cogBitmapLayer] : [])
    ];

    // Important: Use 100vw/100vh to ensure the map is visible
    return (
        <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={({ viewState }) => setViewState(viewState)}
                controller={true}
                views={new MapView({ repeat: true })}
                layers={layers}
                style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}
            >
                {/* UI placed INSIDE DeckGL renders safely on top */}
                <div style={{
                    position: 'fixed',
                    zIndex: 9999,
                    top: 20,
                    right: 20,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    pointerEvents: 'auto',
                    fontFamily: 'sans-serif',
                    fontSize: 14,
                    color: '#333'
                }}>
                    <div style={{
                        background: 'white',
                        padding: 15,
                        borderRadius: 4,
                        boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
                    }}>
                        <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
                            Layers
                        </label>
                        <label style={{ display: 'block', marginBottom: 4, cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={showCogLayer}
                                onChange={(e) => setShowCogLayer(e.target.checked)}
                                style={{ marginRight: 6 }}
                            />
                            COGLayer
                        </label>
                        <label style={{ display: 'block', cursor: 'pointer' }}>
                            <input
                                type="checkbox"
                                checked={showCogBitmapLayer}
                                onChange={(e) => setShowCogBitmapLayer(e.target.checked)}
                                style={{ marginRight: 6 }}
                            />
                            CogBitmapLayer
                        </label>
                    </div>
                </div>
            </DeckGL>
        </div>
    );
}

export default CogMap;

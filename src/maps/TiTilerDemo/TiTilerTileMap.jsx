import { useState } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

const DEFAULT_TITILER_URL = 'http://localhost:8000';
// Base URL of the TiTiler instance (see deploy/titiler/docker-compose.yml).
// Override via .env: VITE_TITILER_URL=https://your-deployed-titiler.example
const TITILER_URL = import.meta.env.VITE_TITILER_URL || DEFAULT_TITILER_URL;

/**
 * Generic TiTiler COG tile map: deck.gl TileLayer + BitmapLayer over a
 * light base map. Tiles are generated on the fly by TiTiler
 * (/cog/tiles/{z}/{x}/{y}.png?url=...&...).
 *
 * @param {string} cogUrl        - public COG URL passed to TiTiler as `url` param
 * @param {string} queryParams   - already-URL-encoded extra params (bands, rescale, colormap, nodata...)
 * @param {object} initialViewState - per-dataset initial camera
 * @param {number} maxZoom       - max zoom for the TiTiler tile layer
 */
function TiTilerTileMap({ cogUrl, queryParams, initialViewState, maxZoom = 16 }) {
    const [viewState, setViewState] = useState(initialViewState);

    const params = queryParams ? `&${queryParams}` : '';
    // TiTiler 2.x route: /cog/tiles/{tileMatrixSetId}/{z}/{x}/{y}.png (WebMercatorQuad = default)
    const tileUrl = `${TITILER_URL}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=${encodeURIComponent(cogUrl)}${params}`;

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
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
        new TileLayer({
            id: 'titiler-tiles',
            data: tileUrl,
            minZoom: 0,
            maxZoom: maxZoom,
            tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        })
    ];

    return (
        <DeckGL
            viewState={viewState}
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            controller={true}
            layers={layers}
            views={new MapView({ repeat: true })}
            style={{ width: '100vw', height: '100vh' }}
        />
    );
}

export default TiTilerTileMap;

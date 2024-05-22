import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { Tile3DLayer } from '@deck.gl/geo-layers';

const TILESET_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json';

const INITIAL_VIEW_STATE = {
    latitude: 50.089,
    longitude: 14.42,
    zoom: 16,
    pitch: 60,
    bearing: 0,
};

const layers = [
    new Tile3DLayer({
      id: 'google-3d-tiles',
      data: TILESET_URL,
      onTilesetLoad: tileset3d => {
        tileset3d.options.onTraversalComplete = selectedTiles => {
          const uniqueCredits = new Set();
          selectedTiles.forEach(tile => {
            const {copyright} = tile.content.gltf.asset;
            copyright.split(';').forEach(uniqueCredits.add, uniqueCredits);
          });
          // setCredits([...uniqueCredits].join('; '));
          return selectedTiles;
        };
      },
      loadOptions: {
        fetch: {headers: {'X-GOOG-API-KEY': import.meta.env.VITE_GOOGLE_MAPS_API_KEY}}
      },
      operation: 'terrain+draw',
      opacity:1
    }),
]
function MapApp() {
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

export default MapApp;

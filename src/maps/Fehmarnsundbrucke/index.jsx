import { DeckGL } from 'deck.gl';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { cartoLightBasemapUrl } from '../basemaps';

const ANCHOR = [11.1125624, 54.4018203];
const BRIDGE_MIDPOINT = [11.1117306, 54.4005333];
const BRIDGE_OBJ_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets/fehmarnsund_bridge.obj';

const INITIAL_VIEW_STATE = {
    longitude: BRIDGE_MIDPOINT[0],
    latitude: BRIDGE_MIDPOINT[1],
    zoom: 14.75,
    pitch: 60,
    bearing: -47,
    minZoom: 12,
    maxZoom: 18,
};

function Fehmarnsundbrucke() {
    const layers = [
        new TileLayer({
            id: 'base-map',
            data: cartoLightBasemapUrl,
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: (props) => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north],
                });
            },
        }),
        new SimpleMeshLayer({
            id: 'fehmarnsund-bridge',
            data: [{}],
            mesh: BRIDGE_OBJ_URL,
            loaders: [OBJLoader],
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: ANCHOR,
            getPosition: () => [0, 0, 0],
            getScale: () => [1, 1, 1],
            getOrientation: () => [0, 0, 0],
            getColor: () => [199, 204, 212, 255],
            getPolygonOffset: () => [0, 0],
            material: {
                ambient: 0.35,
                diffuse: 0.6,
                shininess: 32,
                specularColor: [60, 64, 70],
            },
            pickable: false,
        }),
    ];

    return (
        <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
            <DeckGL initialViewState={INITIAL_VIEW_STATE} controller={true} layers={layers} />

            <div
                style={{
                    position: 'absolute',
                    bottom: 6,
                    left: 8,
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: 'rgba(255, 255, 255, 0.75)',
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: 10,
                    color: '#333',
                    pointerEvents: 'none',
                }}
            >
                MiLi1954 / Thingiverse thing:3982427, CC BY · © OpenStreetMap contributors
            </div>
        </div>
    );
}

export default Fehmarnsundbrucke;

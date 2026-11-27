import { DeckGL } from 'deck.gl';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { cartoLightBasemapUrl } from '../basemaps';

// Values below are copied from the asset sidecar
// build/mintarder_ruhrtalbruecke.json (see 3DFLUS CCN/Mintarder Ruhrtalbrucke).
const ANCHOR = [6.9031544, 51.3799921]; // main-span midpoint, s = 1023 m
const DECK_MIDPOINT = [6.9018349, 51.3794818]; // s = 915 m, used for framing

// The OBJ is in local ENU metres (+X east, +Y north, +Z up) with its origin at
// ANCHOR, so no rotation is needed: getOrientation stays [0, 0, 0].
//
// Local copies live in public/assets/mintarder/ and are served by Vite as-is.
const ASSET_BASE = `${import.meta.env.BASE_URL}assets/mintarder`;
// Deployed alternative, matching the other sandbox assets:
// const ASSET_BASE = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets/mintarder';

// One layer per material split; colours are the manifest `colors` values.
const PARTS = [
    { id: 'deck', file: 'mintarder_deck.obj', color: [111, 116, 124, 255] }, // #6f747c
    { id: 'steel', file: 'mintarder_steel.obj', color: [199, 204, 212, 255] }, // #c7ccd4
    { id: 'concrete', file: 'mintarder_concrete.obj', color: [185, 179, 167, 255] }, // #b9b3a7
    { id: 'guardrails', file: 'mintarder_guardrails.obj', color: [174, 182, 194, 255] }, // #aeb6c2
];

const MATERIAL = {
    ambient: 0.35,
    diffuse: 0.6,
    shininess: 32,
    specularColor: [60, 64, 70],
};

const WIKIPEDIA_URL = 'https://de.wikipedia.org/wiki/Mintarder_Ruhrtalbr%C3%BCcke';
const WIKIPEDIA_LICENSE_URL = 'https://creativecommons.org/licenses/by-sa/4.0/';
const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1-0/';
const CARTO_ATTRIBUTION_URL = 'https://carto.com/attributions';

const ATTRIBUTION_LINK_STYLE = {
    color: '#1a4f8a',
    pointerEvents: 'auto',
};

const INITIAL_VIEW_STATE = {
    longitude: DECK_MIDPOINT[0],
    latitude: DECK_MIDPOINT[1],
    zoom: 14.8,
    pitch: 58,
    bearing: 33,
    minZoom: 12,
    maxZoom: 18,
};

function MintarderRuhrtalbruecke() {
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
        ...PARTS.map(
            (part) =>
                new SimpleMeshLayer({
                    id: `mintarder-${part.id}`,
                    data: [{}],
                    mesh: `${ASSET_BASE}/${part.file}`,
                    loaders: [OBJLoader],
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: ANCHOR,
                    getPosition: () => [0, 0, 0],
                    getScale: () => [1, 1, 1],
                    getOrientation: () => [0, 0, 0],
                    getColor: () => part.color,
                    getPolygonOffset: () => [0, 0],
                    material: MATERIAL,
                    pickable: false,
                })
        ),
    ];

    return (
        <div style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
            <DeckGL initialViewState={INITIAL_VIEW_STATE} controller={true} layers={layers} />

            <div
                style={{
                    position: 'absolute',
                    bottom: 6,
                    left: 8,
                    maxWidth: 560,
                    padding: '4px 7px',
                    borderRadius: 3,
                    background: 'rgba(255, 255, 255, 0.85)',
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: 10,
                    lineHeight: 1.45,
                    color: '#333',
                    pointerEvents: 'none',
                }}
            >
                <div>
                    Mintarder Ruhrtalbrücke (as-built 1966, A52): 1,830 m · R 3,000 m arc · 27.5 m wide ·
                    18 piers · 126 m main span · 65 m max deck. Simplified LOD mesh (8,684 triangles),
                    not an engineering record.
                </div>
                <div>
                    Alignment/anchor data:{' '}
                    <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © OpenStreetMap contributors
                    </a>
                    ,{' '}
                    <a href={ODBL_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        ODbL
                    </a>
                    . Documented dimensions:{' '}
                    <a href={WIKIPEDIA_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        Wikipedia „Mintarder Ruhrtalbrücke”
                    </a>
                    ,{' '}
                    <a href={WIKIPEDIA_LICENSE_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        CC BY-SA
                    </a>
                    .
                </div>
                <div>
                    Basemap:{' '}
                    <a href={CARTO_ATTRIBUTION_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © CARTO
                    </a>
                    ,{' '}
                    <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer" style={ATTRIBUTION_LINK_STYLE}>
                        © OpenStreetMap contributors
                    </a>
                    .
                </div>
            </div>
        </div>
    );
}

export default MintarderRuhrtalbruecke;

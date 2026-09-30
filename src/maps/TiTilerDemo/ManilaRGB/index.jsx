import TiTilerTileMap from './TiTilerTileMap';

// Manila Sentinel-2 RGB composite (uint8 3-band COG, Mercator).
// True RGB: no params needed — TiTiler serves the RGB bands straight to PNG.
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif';

const queryParams = '';

// Manila COG actual bounds (from /cog/info, EPSG:3857):
// lon 118.13–123.75, lat 11.13–16.58 — Luzon-wide composite, not just the city
const INITIAL_VIEW_STATE = {
    longitude: 120.94,
    latitude: 13.86,
    zoom: 8,
    pitch: 0,
    bearing: 0
};

const ManilaRGB = () => (
    <TiTilerTileMap
        cogUrl={COG_URL}
        queryParams={queryParams}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={16}
    />
);

export default ManilaRGB;

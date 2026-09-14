import TiTilerTileMap from './TiTilerTileMap';

// ESA-WorldCereal active cropland map, 2021 tc-maize-main season (V1.0.0).
// Single-band uint8 COG, EPSG:3857. Legend (from COG dataset tags):
//   0 = not active, 100 = active cropland, 254 = No crop, 255 = nodata.
// Small discrete class set + uint8 -> categorical colormap, no rescale needed.
const COG_URL = 'https://gisat-data.eu-central-1.linodeobjects.com/WorldCereal_GST-10/project/demo/merged_cog.tif';

// TiTiler colormap (index -> [r,g,b,a]); values outside 0/100/254/255 are
// transparent. nodata (255) and "No crop" (254) are both see-through so the
// base map shows through everywhere there is no active cropland.
const COLORMAP = JSON.stringify({
    0:   [207, 207, 207, 255],  // not active — light gray
    100: [26,  150,  65, 255],  // active cropland — green
    254: [0, 0, 0, 0],          // No crop — transparent
    255: [0, 0, 0, 0]           // nodata — transparent
});

// `bidx=1` pins the single band (TiTiler colormap requires exactly 1 band).
const queryParams = [
    'bidx=1',
    `colormap=${encodeURIComponent(COLORMAP)}`
].join('&');

// WorldCereal coverage (from COG bounds, EPSG:3857 -> deg):
// lon -20.0…+73.0, lat -35.5…+45.7 (Africa/Europe/Middle East).
const INITIAL_VIEW_STATE = {
    longitude: 26.5,
    latitude: 5.9,
    zoom: 4,
    pitch: 0,
    bearing: 0
};

const WorldCereal = () => (
    <TiTilerTileMap
        cogUrl={COG_URL}
        queryParams={queryParams}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={14} // COG is tiled at zoom 14 (TILING_SCHEME_ZOOM_LEVEL); cap there
    />
);

export default WorldCereal;

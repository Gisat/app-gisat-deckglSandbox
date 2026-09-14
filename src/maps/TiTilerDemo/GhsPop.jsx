import TiTilerTileMap from './TiTilerTileMap';
import { GHS_POP_COLORMAP } from './colormaps';

// GHSL population density 2015 (float32 persons/pixel, EPSG:3857, global).
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/GHS_POP_E2015_COGeoN.tif';

// Population density is massively right-skewed (windowed probe: min 0, max
// ~29.5, mean ~0.07; p2/p50 = 0, p98 ~0.0000002), so a naive p2-p98 rescale
// would render everything dark purple. TiTiler only supports a *linear*
// rescale, so use 0,10: dense urban cores (>=10) light up yellow/green while
// rural/background stays in the dark low end ("landmass dim, cities lit").
//
// PNG can't carry float32 -> bidx=1 + rescale to bytes + viridis colormap
// (matplotlib viridis: #440154 -> #3b528b -> #21918c -> #5ec962 -> #fde725).
const RESCALE = '0,10';

// Clear the lowest 11 bytes (0-10 of 256) -> population below ~0.43/px hidden,
// plus nodata -200 (clamps to byte 0) also transparent.
//
// We send this as a compact override against the NAMED viridis colormap
// (colormap_name=viridis), not the full 256-entry ramp. A ~9KB inline colormap
// bypasses the nginx tile cache (deploy/titiler-caching) entirely - measured:
// no X-Cache-Status, nothing stored. colormap_name + a ~130-byte override keeps
// the query short so caching engages and repeat views are server-cache HITs.
const GHS_POP_TRANSPARENT_LOW = (() => {
    const colormap = JSON.parse(GHS_POP_COLORMAP);
    const out = {};
    for (let i = 0; i < 11; i++) out[i] = [...colormap[i], 0];
    return JSON.stringify(out);
})();

const queryParams = [
    'bidx=1',
    `rescale=${RESCALE}`,
    `colormap_name=viridis`,
    `colormap=${encodeURIComponent(GHS_POP_TRANSPARENT_LOW)}`
].join('&');

// Global COG -> whole Earth visible from the start.
const INITIAL_VIEW_STATE = {
    longitude: 0,
    latitude: 0,
    zoom: 2,
    pitch: 0,
    bearing: 0
};

const GhsPop = () => (
    <TiTilerTileMap
        cogUrl={COG_URL}
        queryParams={queryParams}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={14} // overviews to 2048x native make low/mid zooms cheap; cap detail here
    />
);

export default GhsPop;

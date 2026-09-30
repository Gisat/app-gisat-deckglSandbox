import TiTilerTileMap from './TiTilerTileMap';

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
// Delivered as a SERVER-SIDE registered colormap: the full 256-entry RGBA ramp
// (alpha=0 on bytes 0-10) is written to deploy/titiler/colormaps/ghs_pop_transparent_low.json
// and registered by TiTiler at startup via COLORMAP_DIRECTORY (mounted into both
// the plain and caching compose stacks). The client references it by the short
// `colormap_name=ghs_pop_transparent_low`, so the tile query stays small & the
// nginx tile cache (depoy/titiler-caching, proxy_cache_key = full $args) engages.
//
// Why server-side and not inline: TiTiler's colormap dependency short-circuits
// on colormap_name (src/titiler/core/titiler/core/dependencies.py: `if
// colormap_name: return cmap.get(colormap_name)`), so a `colormap_name` +
// compact `colormap` override is NEVER merged. A full inline ramp DOES render
// transparent but its ~10KB query bypasses the nginx cache; the registered
// colormap gives transparency AND caching. If the JSON is missing, the tile URL
// 400s with "Invalid colormap name" — both stacks must be restarted after adding
// a colormap (COLORMAP_DIRECTORY is scanned at startup only).
const queryParams = [
    'bidx=1',
    `rescale=${RESCALE}`,
    `colormap_name=ghs_pop_transparent_low`
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

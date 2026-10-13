import TileserverTileMap from './shared/TileserverTileMap';

// STAC + mosaic demonstration: Sentinel-2 L2A true-color tiles discovered
// and composited on the fly by tileserver-rs.
//
// Every tile request triggers a STAC POST /search on Earth Search
// (earth-search.aws.element84.com/v1, collection sentinel-2-l2a) with the
// tile's WGS-84 bbox; up to `max_items = 5` intersecting items are rendered
// concurrently and composited into one tile (Phase 3 mosaic), with
// pixel_selection = "first" (first opaque pixel wins — short-circuits, the
// lowest-latency strategy). A single intersecting item renders directly
// (Phase 2). See deploy/tileserver/config.toml → [[sources]] sentinel2-mosaic.
//
// The rendered PNG is kept in the in-process [cache] (identity-raster-cache
// build): repeat requests for the same tile are served from memory within the
// TTL — watch the timing HUD: first (uncached) load = STAC search + remote
// COG reads + warp + PNG; reload/revisit = milliseconds.
//
// stac_bbox = [26.0, 4.5, 27.0, 5.5] anchors the source bounds (South
// Sudan / East Africa overlap zone for adjacent S2 granules).
const SOURCE_ID = 'sentinel2-mosaic';

const INITIAL_VIEW_STATE = {
    longitude: 26.75,
    latitude: 5.0,
    zoom: 8,
    pitch: 0,
    bearing: 0
};

// In-bounds probe tile (lon 26.75, lat 5.0 at z6) for the systemic-error gate.
const PROBE_TILE = '6/36/31.png';

const Sentinel2Mosaic = () => (
    <TileserverTileMap
        sourceId={SOURCE_ID}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={14} // source maxzoom (config.toml); S2 visual is 10 m (~z14 native)
        probeTile={PROBE_TILE}
    />
);

export default Sentinel2Mosaic;

import TileserverTileMap from './shared/TileserverTileMap';

// Tileserver-RS alternative to the TiTiler "Manila RGB" demo: the SAME COG
// (Manila Sentinel-2 RGB composite, uint8 3-band, EPSG:3857, DEFLATE) is
// rendered by tileserver-rs instead of TiTiler. True RGB 3-band — no
// colormap needed (colormap applies only when band_count == 1) — so both
// demos render the same imagery and this one exercises tileserver-rs's
// server-side COG warp + PNG encode + in-process tile cache.
//
// The STAC demo that previously lived here (sentinel2-mosaic, Earth Search
// dynamic /search + mosaic) was removed: its low-zoom tiles were mostly
// black because `pixel_selection = "first"` picks by STAC order (newest
// scenes, 89-99 % cloud in this region) and the demo isn't trustworthy.
// A plain, proven COG is the reliable baseline for the Tileserver-RS
// category.
const SOURCE_ID = 'manila-rgb';

// Same initial camera as the TiTiler Manila RGB demo (Luzon, lon
// 118.13-123.75 / lat 11.13-16.58).
const INITIAL_VIEW_STATE = {
    longitude: 120.94,
    latitude: 13.86,
    zoom: 8,
    pitch: 0,
    bearing: 0
};

// In-bounds probe tile (lon 120.94, lat 13.86 at z6 -> 53/29) for the
// systemic-error gate.
const PROBE_TILE = '6/53/29.png';

const ManilaRGB = () => (
    <TileserverTileMap
        sourceId={SOURCE_ID}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={15} // COG native tiling zoom (Sentinel-2 10 m)
        probeTile={PROBE_TILE}
    />
);

export default ManilaRGB;

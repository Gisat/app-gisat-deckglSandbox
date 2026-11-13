import TileserverTileMap from './shared/TileserverTileMap';

// The true STAC + mosaic demo for the Tileserver-RS category.
//
// `io-10m-annual-lulc` on the Impact Observatory STAC API is a global 10 m
// land-cover product: one COG per Sentinel-2 MGRS supercell per year
// (2017-2024), 9 classes, EPSG:UTM (326xx/327xx). With `dynamic = true`
// tileserver-rs runs a per-tile bbox POST /search, renders the returned
// supercells concurrently and composites them into a seamless class raster.
// That is the real STAC demonstration.
//
// Why UTM and not the previous EUGW_LCMH (EPSG:3035): tileserver-rs warps
// every asset into EPSG:3857 (XYZ tiles are WebMercator by definition). A
// conic equal-area grid (3035) is rotated relative to Mercator everywhere,
// so adjacent warped footprints left growing wedge gaps when zooming out.
// UTM is a transverse Mercator: near a zone's central meridian its grid is
// essentially axis-aligned in Mercator, so the residual skew is negligible.
// Munich (11.5E) sits close to UTM 32N's 9E central meridian. Measured
// 2026-10-27: rendered coverage z10 96.0%, z11 100%, z12/z13 interior 100%.
//
// Why this works where the removed `sentinel2-mosaic` did not: that was a
// TEMPORAL scene collection where `pixel_selection = "first"` picked by STAC
// rank (= newest = 89-99 % cloud), so low-zoom tiles came out black. Here
// every item is a cloud-free annual composite, so `first` is simply "an
// adjacent supercell of the grid" — exactly what a mosaic wants.
//
// Server-side (deploy/tileserver/config.toml, [[sources]] id "io-lulc"):
//   - asset_role = "supercell"      (the data asset key; roles:["data"])
//   - resampling = "nearest"        (categorical class ids — never interpolate)
//   - [sources.colormap] discrete, rescale_mode = "none", nodata ->
//     transparent. Colors are the standard IO 9-class legend.
const SOURCE_ID = 'io-lulc';

// Centred on Munich, Bavaria (lon 11.58, lat 48.14), where IO LULC tiles
// contiguously. Zoom 10 shows several adjacent supercells mosaicking into a
// seamless class raster — rendered z10 coverage 96.0%, z11 100% (verified
// 2026-10-27).
const INITIAL_VIEW_STATE = {
    longitude: 11.58,
    latitude: 48.14,
    zoom: 10,
    pitch: 0,
    bearing: 0
};

// In-bounds probe tile for the systemic-error gate. MUST be fully inside the
// stac_bbox [11.2, 47.9, 11.9, 48.4] or the gate misfires (a genuinely
// out-of-bounds tile 500s/404s, the probe fails too, and the app cannot tell
// "server is down" from "you panned off the edge" -> it shows the tile-error
// modal on every off-edge zoom).
// z10/544/355 -> tile bbox lon 11.25..11.60, lat 47.99..48.22 — fully
// inside, and it is the app's initial view centre, so it is always rendered
// anyway. (Derived with standard WebMercator math from the centre, not
// guessed.)
const PROBE_TILE = '10/544/355.png';

const IoLulc = () => (
    <TileserverTileMap
        sourceId={SOURCE_ID}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={14} // COG native tiling zoom (10 m class raster)
        probeTile={PROBE_TILE}
        inspectTiles // STAC demo: outline the hovered tile + custom right-click menu
        enableCrawl // drag a bbox -> get the fetch-tiles.mjs command for it
    />
);

export default IoLulc;

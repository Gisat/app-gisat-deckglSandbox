import TileserverTileMap from './shared/TileserverTileMap';

// Tileserver-RS alternative to the TiTiler "WorldCereal Active Cropland"
// demo: the SAME COG (ESA WorldCereal 2021 tc-maize-main V1.0.0, single-band
// uint8, EPSG:3857, native zoom 14), rendered by tileserver-rs instead of
// TiTiler. The categorical colormap lives server-side in
// deploy/tileserver/config.toml ([sources.colormap], map_type = "discrete"):
//   0 = not active (gray #cfcfcf), 100 = active cropland (green #1a9641),
//   254 = "No crop" (transparent), 255 = nodata (transparent)
// — identical to deploy/titiler/colormaps/worldcereal_active.json, so both
// demos render pixel-for-pixel the same classes.
//
// Why a plain `cog` source (not STAC): the public WorldCereal STAC API is
// dead — stac.worldcereal.org is NXDOMAIN (authoritative, 2026-10-13) and
// hub.esa-worldcereal.org is a web SPA. The sibling Sentinel-2 demo carries
// the STAC + mosaic demonstration.
const SOURCE_ID = 'worldcereal';

// Same initial camera as the TiTiler WorldCereal demo (Africa/Europe/Middle
// East coverage; lon -20…+73, lat -35.5…+45.7).
const INITIAL_VIEW_STATE = {
    longitude: 26.5,
    latitude: 5.9,
    zoom: 4,
    pitch: 0,
    bearing: 0
};

// In-bounds probe tile (lon 26.5, lat 5.9 at z4) for the systemic-error gate.
const PROBE_TILE = '4/9/7.png';

const WorldCerealTS = () => (
    <TileserverTileMap
        sourceId={SOURCE_ID}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={14} // COG native tiling zoom (TILING_SCHEME_ZOOM_LEVEL)
        probeTile={PROBE_TILE}
    />
);

export default WorldCerealTS;

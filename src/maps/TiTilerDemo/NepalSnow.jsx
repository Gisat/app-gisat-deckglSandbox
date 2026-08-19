import TiTilerTileMap from './TiTilerTileMap';
import { SNOW_COLORMAP } from './colormaps';

// Nepal Wet Snow 2017-2021 (single-band int16 COG, EPSG:3857)
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif';

// PNG can't carry int16 -> rescale to bytes + server-side colormap (matches
// the task's colorScale ['#fde725','#5dc962','#20908d','#3a528b','#440154'],
// colorScaleValueRange [0,300]).
// `bidx=1` pins a single band: without it TiTiler renders all bands and
// colormap fails with "Source data must be 1 band" (same fix as Uganda).
const queryParams = [
    'bidx=1',
    'rescale=0,300',
    `colormap=${encodeURIComponent(SNOW_COLORMAP)}`
].join('&');

// Nepal Wet Snow COG actual bounds (from /cog/info, EPSG:3857):
// lon 84.38–85.79, lat 27.06–28.55 — Kathmandu/Langtang region, not all of Nepal
const INITIAL_VIEW_STATE = {
    longitude: 85.08,
    latitude: 27.8,
    zoom: 10,
    pitch: 0,
    bearing: 0
};

const NepalSnow = () => (
    <TiTilerTileMap
        cogUrl={COG_URL}
        queryParams={queryParams}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={16}
    />
);

export default NepalSnow;

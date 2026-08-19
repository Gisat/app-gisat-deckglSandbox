import TiTilerTileMap from './TiTilerTileMap';
import { UGANDA_COLORMAP } from './colormaps';

// Uganda Land Use / Land Cover (multiband COG) — band 15 via TiTiler `bands=`
// (1-indexed, same convention as geolib useChannel).
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/cog_UG_hanpp_luc_multiband.tif';

// Task defaults: noDataValue 0, Channel 15, colorScaleValueRange [0,100],
// colorScale ['#eff3ff','#bdd7e7','#6baed6','#3182bd','#08519c'].
// TiTiler 2.x band selection is `bidx` (band indexes); the old 1.x `bands=` is ignored.
// `nodata=0` is omitted: in 2.x, nodata + colormap triggers multi-band render
// ("Source data must be 1 band").
const queryParams = [
    'bidx=15',
    'rescale=0,100',
    `colormap=${encodeURIComponent(UGANDA_COLORMAP)}`
].join('&');

// Uganda COG actual bounds (from /cog/info): lon 33.75–35.16, lat 0–1.4N — small NE-Uganda strip
const INITIAL_VIEW_STATE = {
    longitude: 34.45,
    latitude: 0.7,
    zoom: 9,
    pitch: 0,
    bearing: 0
};

const UgandaLUC = () => (
    <TiTilerTileMap
        cogUrl={COG_URL}
        queryParams={queryParams}
        initialViewState={INITIAL_VIEW_STATE}
        maxZoom={16}
    />
);

export default UgandaLUC;

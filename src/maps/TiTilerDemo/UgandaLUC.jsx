import { useState } from 'react';
import TiTilerTileMap from './TiTilerTileMap';
import { UGANDA_COLORMAP } from './colormaps';
import './UgandaLUC.css';

// Uganda Land Use / Land Cover (multiband COG) — band slider demo.
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_bitmap/cog_UG_hanpp_luc_multiband.tif';

// Bands 1–14 are entirely zero (no data) — verified via /cog/statistics
// (valid_percent = 0 for b1..b14) and visually (solid-color tiles). The
// data-bearing bands are 15–24; band 15 is the task default ("Channel 15").
const BAND_MIN = 15;
const BAND_MAX = 24;

// Per-band display stretch (percentile_2–percentile_98 from
// /cog/statistics?url=...&nodata=0, rounded to 0.1). Band 15 keeps the
// task-specified 0–100 range (proven rendering); the rest use their real
// percentile range so every band gets full colormap contrast. Raw min/max
// would be worse: they include outliers (e.g. b18 min = −59).
const BAND_RESCALE = {
    15: '0,100',
    16: '28.5,63.4',
    17: '14.6,65.4',
    18: '-14.1,55.5',
    19: '18.1,62.6',
    20: '20.4,60.0',
    21: '-5.5,56.8',
    22: '7.3,66.2',
    23: '-13.1,55.0',
    24: '13.2,60.5'
};

// Uganda COG actual bounds (from /cog/info): lon 33.75–35.16, lat 0–1.4N — small NE-Uganda strip
const INITIAL_VIEW_STATE = {
    longitude: 34.45,
    latitude: 0.7,
    zoom: 9,
    pitch: 0,
    bearing: 0
};

const UgandaLUC = () => {
    const [band, setBand] = useState(15);

    // Band selection is a URL parameter (`bidx`, 1-indexed) — TiTiler
    // re-renders the tiles for the requested band on the fly. Changing
    // queryParams changes the TileLayer data URL; deck.gl reloads the tiles.
    const queryParams = [
        `bidx=${band}`,
        `rescale=${BAND_RESCALE[band]}`,
        `colormap=${encodeURIComponent(UGANDA_COLORMAP)}`
    ].join('&');

    return (
        <div className="uganda-luc-container">
            <TiTilerTileMap
                cogUrl={COG_URL}
                queryParams={queryParams}
                initialViewState={INITIAL_VIEW_STATE}
                maxZoom={16}
            />
            <div className="uganda-luc-control">
                <div className="uganda-luc-header">
                    <span className="uganda-luc-title">Uganda LUC — band</span>
                    <span className="uganda-luc-badge">Band {band} / {BAND_MAX}</span>
                </div>
                <input
                    type="range"
                    min={BAND_MIN}
                    max={BAND_MAX}
                    step={1}
                    value={band}
                    onChange={e => setBand(Number(e.target.value))}
                    className="uganda-luc-slider"
                />
                <div className="uganda-luc-hint">
                    Bands 1–14 contain no data · band 15 is the task default · rescale is per-band (p2–p98)
                </div>
            </div>
        </div>
    );
};

export default UgandaLUC;

// utils/getTileUrls.js

const GRID_SIZE = 0.10;
// 🛑 BASE URL: Must match the directory where the V2 partitions were uploaded.
const BASE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_tiled_detail_v2';

// 🛑 HASHED FILENAME: Must match the output of the final successful generation script.
const ACTUAL_TILE_FILE_NAME = 'data_0.parquet';

/**
 * Calculates the required partition keys (part_x, part_y) for the given BBOX
 * and returns the list of URLs for DuckDB Wasm to fetch via registerFileBuffer.
 */
export function getTileUrls(bounds) {
    const [minLon, minLat, maxLon, maxLat] = bounds;

    // Calculate integer tile indices
    const minX = Math.floor(minLon / GRID_SIZE);
    const maxX = Math.floor(maxLon / GRID_SIZE);
    const minY = Math.floor(minLat / GRID_SIZE);
    const maxY = Math.floor(maxLat / GRID_SIZE);

    const tiles = [];

    for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
            // CRITICAL FIX: The Python script output folder names with floating point '.0'
            const partXKey = `X${x}.0`;
            const partYKey = `Y${y}.0`;

            // 🛑 Construct the full, direct file path
            // Example: .../egms_tiled_detail_v2/part_x=X139.0/part_y=Y499.0/data_0.parquet
            const url = `${BASE_URL}/part_x=${partXKey}/part_y=${partYKey}/${ACTUAL_TILE_FILE_NAME}`;

            // We use the full URL as the internal DuckDB filename (filename),
            // which avoids the previous "too small" error.
            const filename = url;

            tiles.push({ url, filename });
        }
    }
    return tiles;
}

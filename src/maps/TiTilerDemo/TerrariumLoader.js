import UPNG from 'upng-js';
import { buildTerrainMeshFromHeights } from './terrainMeshCore';

// Pure-JS Terrarium heightmap -> TerrainLayer mesh loader.
//
// WHY this loader exists (deck.gl issue #10400):
//   TerrainLayer normally decodes its elevation PNG inside a loaders.gl web
//   worker, which on the browser decodes the tile via createImageBitmap and
//   then extracts pixels with a canvas drawImage + getImageData round-trip.
//   On wide-gamut / color-managed displays (macOS defaults to a wide color
//   profile) that path shifts R/G/B channel values by ±1. The Terrarium Red
//   scaler is 256, so a single ±1 shift in the Red channel becomes a ±256 m
//   vertical spike — the scattered "needles" seen all over the mesh. The raw
//   PNG bytes are clean (verified: independent decode shows no out-of-range
//   pixels); the corruption is the browser's color-managed image pipeline.
//
//   loaders.gl also forces `image: {type: 'data'}` internally, but on the
//   browser that still routes through createImageBitmap (getDefaultImageType()
//   returns 'imagebitmap'), so no TerrainLayer prop can dodge it.
//
// The fix: decode the PNG with UPNG (pure JavaScript, no browser image APIs),
// apply the Terrarium elevationDecoder to get per-pixel heights in metres, and
// build the martini mesh on the main thread. Mesh construction is shared with
// Float32Loader via terrainMeshCore (both end at a row-major Float32Array of
// metre heights). The channel bytes reach the decoder unmodified, at full
// 24-bit Terrarium precision, with zero needles.
//
// This loader is passed to TerrainLayer via its `loaders` prop, replacing the
// default TerrainWorkerLoader. Downside: mesh tesselation runs on the main
// thread instead of a web worker (fine for a demo).

const DEFAULT_TERRAIN_OPTIONS = {
    tesselator: 'auto',       // 'martini' | 'delatin' | 'auto'
    bounds: undefined,        // [minX, minY, maxX, maxY]; defaults to pixel space
    meshMaxError: 10,
    elevationDecoder: { rScaler: 1, gScaler: 0, bScaler: 0, offset: 0 },
    skirtHeight: undefined,
};

// Decode RGBA bytes -> row-major Float32Array of per-pixel heights in metres,
// applying the supplied linear elevationDecoder (height = R*r + G*g + B*b +
// offset). This is loaders.gl getTerrain's decode step, kept here so the PNG
// loader can map bytes to metres before handing the grid to the shared mesh
// builder. Missing / masked pixels (transparent, a=0) resolve via the decoder
// too (a 0-RGBA byte would decode to `offset`), matching loaders.gl behaviour.
function decodeTerrainBytes(data, width, height, elevationDecoder) {
    const { rScaler, bScaler, gScaler, offset } = elevationDecoder;
    const heights = new Float32Array(width * height);
    for (let i = 0, y = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
            const k = i * 4;
            const r = data[k + 0];
            const g = data[k + 1];
            const b = data[k + 2];
            heights[i] = r * rScaler + g * gScaler + b * bScaler + offset;
        }
    }
    return heights;
}

function buildTerrainMeshFromImage(terrainImage, terrainOptions) {
    const opts = { ...DEFAULT_TERRAIN_OPTIONS, ...terrainOptions };
    const { width, height } = terrainImage;
    const { data } = terrainImage;
    const heights = decodeTerrainBytes(data, width, height, opts.elevationDecoder);
    const meshOptions = { meshMaxError: opts.meshMaxError, bounds: opts.bounds };
    return buildTerrainMeshFromHeights(heights, width, height, meshOptions);
}

// TerrainLoader-compatible loader object. Returned mesh is identical in shape
// to @loaders.gl/terrain's TerrainLoader output, so TerrainLayer renders it.
export const TerrariumLoader = {
    id: 'terrarium-png',
    name: 'Terrarium PNG (pure JS)',
    module: 'terrarium',
    version: '0.0.1',
    extensions: ['png', 'pngraw', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    mimeTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'],
    worker: false, // must run on the main thread — no worker, no browser image decode
    options: {
        terrain: DEFAULT_TERRAIN_OPTIONS,
    },
    parse: async (arrayBuffer, options) => {
        // Pure-JS PNG decode (UPNG) -> RGBA bytes. UPNG.toRGBA8 returns an
        // ArrayBuffer per frame, so wrap it in a Uint8Array for byte indexing.
        const png = UPNG.decode(arrayBuffer);
        const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]); // single-frame RGBA8
        const imageData = {
            width: png.width,
            height: png.height,
            data: rgba,
        };
        const terrainOptions = { ...DEFAULT_TERRAIN_OPTIONS, ...(options && options.terrain) };
        return buildTerrainMeshFromImage(imageData, terrainOptions);
    },
};

export default TerrariumLoader;

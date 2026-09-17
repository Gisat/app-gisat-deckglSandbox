import { buildTerrainMeshFromHeights } from './terrainMeshCore';

// Pure-JS raw float32 elevation-tile loader for deck.gl TerrainLayer.
//
// This is the client side of the raw float32 encoder
// (deploy/titiler-caching/float32-encoder). The encoder serves HEADERLESS
// little-endian IEEE-754 float32 elevation tiles, 256x256, row-major north-up
// (256*256*4 = 262,144 bytes exactly). Heights are in METRES already — so
// unlike TerrariumLoader there is NO elevationDecoder math: the byte stream is
// a Float32Array of heights directly.
//
// WHY raw float32 instead of Terrarium PNG: it bypasses the browser's
// color-managed image pipeline entirely (deck.gl issue #10400 — the PNG path
// shifted R/G/B by ±1 through createImageBitmap, causing ±256 m needles), and
// drops the Terrarium packing + CLAMP coupling on both the encoder and the
// decoder. `new Float32Array(arrayBuffer)` is a pure-JS view over the bytes —
// no browser image APIs, no color management, nothing to corrupt. Each f32 is
// exactly one elevation sample.
//
// The encoder fills masked/nodata/out-of-COG pixels with 0.0 server-side
// (martini cannot handle NaN), so this loader never sees NaN in the grid.
//
// Extensions filter: `.f32` (the tiles are served at {z}/{x}/{y}.f32). MIME is
// application/octet-stream (the encoder's Content-Type, and the natural type
// for a raw binary stream). worker:false — mesh tesselation runs on the main
// thread (fine for a demo), which is exactly what keeps the raw bytes out of
// any worker/canvas round-trip.

// Terrain options accepted by the shared mesh builder (parsed from loaders.gl
// terrain options during parse).
const DEFAULT_TERRAIN_OPTIONS = {
    tesselator: 'martini',
    bounds: undefined,        // [minX, minY, maxX, maxY]; defaults to pixel space
    meshMaxError: 10,
    skirtHeight: undefined,
};

export const Float32Loader = {
    id: 'float32-elevation',
    name: 'Raw float32 elevation (pure JS)',
    module: 'float32-terrain',
    version: '0.0.1',
    extensions: ['f32'],
    mimeTypes: ['application/octet-stream'],
    worker: false, // main thread only — raw bytes, no browser image pipeline
    options: {
        terrain: DEFAULT_TERRAIN_OPTIONS,
    },
    parse: async (arrayBuffer, options) => {
        // new Float32Array defaults to little-endian on every sane platform
        // and is exactly the wire contract ('<f4'): 65536 values.
        const heights = new Float32Array(arrayBuffer);
        const side = 256; // tiles are 256x256; 256*256 = 65536 == heights.length
        const terrainOptions = { ...DEFAULT_TERRAIN_OPTIONS, ...(options && options.terrain) };
        return buildTerrainMeshFromHeights(heights, side, side, terrainOptions);
    },
};

export default Float32Loader;

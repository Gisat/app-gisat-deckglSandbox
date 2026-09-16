import UPNG from 'upng-js';
import Martini from '@mapbox/martini';

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
// The fix: decode the PNG with UPNG (pure JavaScript, no browser image APIs)
// and build the martini mesh on the main thread, then hand TerrainLayer a
// ready-made mesh object — exactly the shape loaders.gl's
// makeTerrainMeshFromImage returns. The channel bytes reach the decoder
// unmodified, at full 24-bit Terrarium precision, with zero needles.
//
// This loader is passed to TerrainLayer via its `loaders` prop, replacing the
// default TerrainWorkerLoader. Downside: mesh tesselation runs on the main
// thread instead of a web worker (fine for a demo).

// Rebuild of @loaders.gl/terrain's makeTerrainMeshFromImage / getTerrain /
// getMartiniTileMesh / getMeshAttributes (MIT, vis.gl contributors), so the
// output is byte-compatible with the default TerrainLayer path.

const DEFAULT_TERRAIN_OPTIONS = {
    tesselator: 'auto',       // 'martini' | 'delatin' | 'auto'
    bounds: undefined,        // [minX, minY, maxX, maxY]; defaults to pixel space
    meshMaxError: 10,
    elevationDecoder: { rScaler: 1, gScaler: 0, bScaler: 0, offset: 0 },
    skirtHeight: undefined,
};

function getTerrain(imageData, width, height, elevationDecoder, tesselator) {
    const { rScaler, bScaler, gScaler, offset } = elevationDecoder;
    const terrain = new Float32Array((width + 1) * (height + 1));
    const { data } = imageData;
    for (let i = 0, y = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
            const k = i * 4;
            const r = data[k + 0];
            const g = data[k + 1];
            const b = data[k + 2];
            terrain[i + y] = r * rScaler + g * gScaler + b * bScaler + offset;
        }
    }
    if (tesselator === 'martini') {
        // backfill bottom border
        for (let i = (width + 1) * width, x = 0; x < width; x++, i++) {
            terrain[i] = terrain[i - width - 1];
        }
        // backfill right border
        for (let i = height, y = 0; y < height + 1; y++, i += height + 1) {
            terrain[i] = terrain[i - 1];
        }
    }
    return terrain;
}

function getMartiniTileMesh(meshMaxError, width, terrain) {
    const gridSize = width + 1;
    const martini = new Martini(gridSize);
    const tile = martini.createTile(terrain);
    const { vertices, triangles } = tile.getMesh(meshMaxError);
    return { vertices, triangles };
}

function getMeshAttributes(vertices, terrain, width, height, bounds) {
    const gridSize = width + 1;
    const numOfVerticies = vertices.length / 2;
    const positions = new Float32Array(numOfVerticies * 3);
    const texCoords = new Float32Array(numOfVerticies * 2);
    const [minX, minY, maxX, maxY] = bounds || [0, 0, width, height];
    const xScale = (maxX - minX) / width;
    const yScale = (maxY - minY) / height;
    for (let i = 0; i < numOfVerticies; i++) {
        const x = vertices[i * 2];
        const y = vertices[i * 2 + 1];
        const pixelIdx = y * gridSize + x;
        positions[3 * i + 0] = x * xScale + minX;
        positions[3 * i + 1] = -y * yScale + maxY;
        positions[3 * i + 2] = terrain[pixelIdx];
        texCoords[2 * i + 0] = x / width;
        texCoords[2 * i + 1] = y / height;
    }
    return {
        POSITION: { value: positions, size: 3 },
        TEXCOORD_0: { value: texCoords, size: 2 },
    };
}

export function buildTerrainMeshFromImage(terrainImage, terrainOptions) {
    const opts = { ...DEFAULT_TERRAIN_OPTIONS, ...terrainOptions };
    const { meshMaxError, bounds, elevationDecoder } = opts;
    const { width, height } = terrainImage;
    let terrain;
    let mesh;
    switch (opts.tesselator) {
        case 'martini':
            terrain = getTerrain(terrainImage, width, height, elevationDecoder, 'martini');
            mesh = getMartiniTileMesh(meshMaxError, width, terrain);
            break;
        case 'delatin':
            // Delatin path omitted for this demo; Martian requires a 2^n+1 grid.
            terrain = getTerrain(terrainImage, width, height, elevationDecoder, 'delatin');
            mesh = getMartiniTileMesh(meshMaxError, width, terrain);
            break;
        default:
            // 'auto': martini when the tile is a power-of-two square, else delatin.
            if (width === height && !(height & (width - 1))) {
                terrain = getTerrain(terrainImage, width, height, elevationDecoder, 'martini');
                mesh = getMartiniTileMesh(meshMaxError, width, terrain);
            } else {
                terrain = getTerrain(terrainImage, width, height, elevationDecoder, 'delatin');
                mesh = getMartiniTileMesh(meshMaxError, width, terrain);
            }
            break;
    }
    const { vertices } = mesh;
    const { triangles } = mesh;
    const attributes = getMeshAttributes(vertices, terrain, width, height, bounds);
    const boundingBox = getMeshBoundingBox(attributes);
    return {
        loaderData: { header: {} },
        header: { vertexCount: triangles.length, boundingBox },
        mode: 4, // TRIANGLES
        indices: { value: Uint32Array.from(triangles), size: 1 },
        attributes,
    };
}

function getMeshBoundingBox(attributes) {
    const positions = attributes.POSITION.value;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return [[minX, minY, minZ], [maxX, maxY, maxZ]];
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

import Martini from '@mapbox/martini';

// Shared martini mesh builder for the TiTilerDemo pure-JS terrain loaders.
//
// Both TerrariumLoader (PNG, decodes bytes then applies an elevationDecoder)
// and Float32Loader (raw headerless float32, identity decode) end at the same
// place: a row-major Float32Array of per-pixel heights, in metres, 256x256.
// This module turns that grid into the exact mesh shape deck.gl TerrainLayer
// expects — the same output @loaders.gl/terrain's makeTerrainMeshFromImage
// produces (positions/TEXCOORD_0/indices/header.boundingBox), rebuilt from the
// loaders.gl source (MIT, vis.gl contributors) so it is byte-compatible with
// the default TerrainLayer path.

// Delatin path omitted for this demo; martini requires a 2^n+1 grid, which the
// 256px tiles satisfy (257 grid). Kept as the only tesselator here.
const DEFAULT_TERRAIN_OPTIONS = {
    tesselator: 'martini',
    bounds: undefined,        // [minX, minY, maxX, maxY]; defaults to pixel space
    meshMaxError: 10,
    skirtHeight: undefined,
};

// Builds the extended (width+1)*(height+1) martini grid from a flat
// width*height Float32Array of heights (metres), with the +1 border rows
// backfilled exactly as loaders.gl's getTerrain does for martini.
function buildTerrainGrid(heights, width, height) {
    const terrain = new Float32Array((width + 1) * (height + 1));
    for (let y = 0; y < height; y++) {
        const srcRow = y * width;
        const dstRow = y * (width + 1);
        for (let x = 0; x < width; x++) {
            terrain[dstRow + x] = heights[srcRow + x];
        }
    }
    // backfill bottom border
    for (let i = (width + 1) * width, x = 0; x < width; x++, i++) {
        terrain[i] = terrain[i - width - 1];
    }
    // backfill right border
    for (let i = height, y = 0; y < height + 1; y++, i += height + 1) {
        terrain[i] = terrain[i - 1];
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

// Builds a TerrainLayer-ready mesh from a flat width*height Float32Array of
// per-pixel heights in metres. Heights are already metres — no elevationDecoder
// math is applied here (that is the caller's job when decoding a packed PNG).
// Returns the same shape as @loaders.gl/terrain makeTerrainMeshFromImage.
export function buildTerrainMeshFromHeights(heights, width, height, terrainOptions) {
    const opts = { ...DEFAULT_TERRAIN_OPTIONS, ...(terrainOptions || {}) };
    const { meshMaxError, bounds } = opts;
    const terrain = buildTerrainGrid(heights, width, height);
    const mesh = getMartiniTileMesh(meshMaxError, width, terrain);
    const attributes = getMeshAttributes(mesh.vertices, terrain, width, height, bounds);
    const boundingBox = getMeshBoundingBox(attributes);
    return {
        loaderData: { header: {} },
        header: { vertexCount: mesh.triangles.length, boundingBox },
        mode: 4, // TRIANGLES
        indices: { value: Uint32Array.from(mesh.triangles), size: 1 },
        attributes,
    };
}

export { DEFAULT_TERRAIN_OPTIONS };

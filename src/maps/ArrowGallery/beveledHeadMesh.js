const EPSILON = 1e-12;
const EAR_EPSILON = 1e-9;
const CONTAINMENT_EPSILON = 1e-7;
const WELD_PRECISION = 1e6;

const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

const isClockwise = (poly) => {
    let area = 0;
    for (let i = 0; i < poly.length; i += 1) {
        const p1 = poly[i];
        const p2 = poly[(i + 1) % poly.length];
        area += (p2[0] - p1[0]) * (p2[1] + p1[1]);
    }
    return area > 0;
};

const pointInTriangle = (p, a, b, c) => {
    const sign = (p1, p2, p3) =>
        (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = sign(p, a, b);
    const d2 = sign(p, b, c);
    const d3 = sign(p, c, a);
    const hasNeg = d1 < -CONTAINMENT_EPSILON || d2 < -CONTAINMENT_EPSILON || d3 < -CONTAINMENT_EPSILON;
    const hasPos = d1 > CONTAINMENT_EPSILON || d2 > CONTAINMENT_EPSILON || d3 > CONTAINMENT_EPSILON;
    return !(hasNeg && hasPos);
};

const triangulatePolygon = (poly) => {
    const n = poly.length;
    if (n < 3) return [];

    const indices = Array.from({ length: n }, (_, index) => index);
    if (isClockwise(poly)) indices.reverse();

    const triangles = [];
    while (indices.length > 3) {
        let earFound = false;
        const m = indices.length;
        for (let i = 0; i < m; i += 1) {
            const prev = indices[(i - 1 + m) % m];
            const curr = indices[i];
            const next = indices[(i + 1) % m];
            const a = poly[prev];
            const b = poly[curr];
            const c = poly[next];

            if (cross2(a, b, c) <= EAR_EPSILON) continue;

            let isEar = true;
            for (let k = 0; k < m; k += 1) {
                const other = indices[k];
                if (other === prev || other === curr || other === next) continue;
                if (pointInTriangle(poly[other], a, b, c)) {
                    isEar = false;
                    break;
                }
            }

            if (isEar) {
                triangles.push([prev, curr, next]);
                indices.splice(i, 1);
                earFound = true;
                break;
            }
        }
        if (!earFound) break;
    }

    if (indices.length === 3) triangles.push([indices[0], indices[1], indices[2]]);
    return triangles;
};

const computeInwardNormals = (poly) => {
    const n = poly.length;
    const normals = [];
    for (let i = 0; i < n; i += 1) {
        const prev = poly[(i - 1 + n) % n];
        const curr = poly[i];
        const next = poly[(i + 1) % n];

        const v1 = [curr[0] - prev[0], curr[1] - prev[1]];
        const v2 = [next[0] - curr[0], next[1] - curr[1]];
        const len1 = Math.hypot(v1[0], v1[1]);
        const len2 = Math.hypot(v2[0], v2[1]);
        if (len1 < EAR_EPSILON || len2 < EAR_EPSILON) {
            normals.push([0, 0]);
            continue;
        }

        const u1 = [v1[0] / len1, v1[1] / len1];
        const u2 = [v2[0] / len2, v2[1] / len2];
        const n1 = [-u1[1], u1[0]];
        const n2 = [-u2[1], u2[0]];
        const nx = n1[0] + n2[0];
        const nz = n1[1] + n2[1];
        const len = Math.hypot(nx, nz);

        if (len < 1e-6) {
            normals.push(n1);
        } else {
            const dot = (n1[0] * nx + n1[1] * nz) / len;
            const scale = 1 / Math.max(0.1, dot);
            normals.push([(scale * nx) / len, (scale * nz) / len]);
        }
    }
    return normals;
};

const toward = (a, b, distance) => {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const length = Math.hypot(vx, vy);
    if (length < EAR_EPSILON) return a;
    const d = Math.min(distance, length * 0.45);
    return [a[0] + (vx / length) * d, a[1] + (vy / length) * d];
};

const taperSocket = (poly, taper) => {
    const before = toward(poly[0], poly[poly.length - 1], taper);
    const after = toward(poly[1], poly[2], taper);
    return {
        polygon: [before, poly[0], poly[1], after, ...poly.slice(2)],
        weights: [1, 0, 0, 1, ...new Array(poly.length - 2).fill(1)]
    };
};

const clean = (value) => (Math.abs(value) < EPSILON ? 0 : value);

const weldKey = (vertex) =>
    vertex.map((value) => {
        const rounded = Math.round(value * WELD_PRECISION) / WELD_PRECISION;
        return rounded === 0 ? 0 : rounded;
    }).join(',');

const dropDegenerateFaces = (vertices, faces) => {
    const kept = faces.filter(([a, b, c]) => {
        const p0 = vertices[a];
        const p1 = vertices[b];
        const p2 = vertices[c];
        const ab = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const ac = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const cx = ab[1] * ac[2] - ab[2] * ac[1];
        const cy = ab[2] * ac[0] - ab[0] * ac[2];
        const cz = ab[0] * ac[1] - ab[1] * ac[0];
        return Math.sqrt(cx * cx + cy * cy + cz * cz) > EPSILON;
    });

    const used = [...new Set(kept.flat())].sort((a, b) => a - b);
    const remap = new Map(used.map((oldIndex, newIndex) => [oldIndex, newIndex]));
    const welded = used.map((index) => vertices[index]);
    const weldedFaces = kept.map((face) => face.map((index) => remap.get(index)));

    const keyToIndex = new Map();
    const weldRemap = new Map();
    const finalVertices = [];
    welded.forEach((vertex, index) => {
        const key = weldKey(vertex);
        if (!keyToIndex.has(key)) {
            keyToIndex.set(key, finalVertices.length);
            finalVertices.push(vertex);
        }
        weldRemap.set(index, keyToIndex.get(key));
    });

    const finalFaces = weldedFaces.map((face) => face.map((index) => weldRemap.get(index)));
    const usedFinal = [...new Set(finalFaces.flat())].sort((a, b) => a - b);
    const compact = new Map(usedFinal.map((oldIndex, newIndex) => [oldIndex, newIndex]));

    return {
        vertices: usedFinal.map((index) => finalVertices[index]).map(([x, y, z]) => [clean(x), clean(y), clean(z)]),
        faces: finalFaces.map((face) => face.map((index) => compact.get(index)))
    };
};

export const buildBeveledHeadMesh = (profile, { thickness, bevelSize, bevelSteps = 3, socketTaper }) => {
    const planPolygon = profile.map(([x, y]) => [x, -y]);
    const tapered = taperSocket(planPolygon, socketTaper);

    let polygon = tapered.polygon;
    let weights = tapered.weights;
    if (isClockwise(polygon)) {
        polygon = [...polygon].reverse();
        weights = [...weights].reverse();
    }

    const normals = computeInwardNormals(polygon);
    const count = polygon.length;
    const half = thickness / 2;

    const topRings = [];
    const bottomRings = [];
    for (let k = 0; k <= bevelSteps; k += 1) {
        const angle = (Math.PI / 2) * (k / bevelSteps);
        const radial = 1 - Math.cos(angle);
        const vertical = Math.sin(angle);

        topRings.push(
            polygon.map(([x, z], index) => {
                const [nx, nz] = normals[index];
                const weight = weights[index];
                return [
                    x + bevelSize * weight * radial * nx,
                    half - bevelSize * weight + bevelSize * weight * vertical,
                    z + bevelSize * weight * radial * nz
                ];
            })
        );
        bottomRings.push(
            polygon.map(([x, z], index) => {
                const [nx, nz] = normals[index];
                const weight = weights[index];
                return [
                    x + bevelSize * weight * radial * nx,
                    -((half - bevelSize * weight) + bevelSize * weight * vertical),
                    z + bevelSize * weight * radial * nz
                ];
            })
        );
    }

    const vertices = [];
    const faces = [];

    const bottomCapStart = vertices.length;
    vertices.push(...bottomRings[bevelSteps]);

    const bottomRingStarts = [];
    for (let k = bevelSteps - 1; k >= 0; k -= 1) {
        bottomRingStarts.push(vertices.length);
        vertices.push(...bottomRings[k]);
    }

    const topRingStarts = [];
    for (let k = 0; k < bevelSteps; k += 1) {
        topRingStarts.push(vertices.length);
        vertices.push(...topRings[k]);
    }

    const topCapStart = vertices.length;
    vertices.push(...topRings[bevelSteps]);

    let previous = bottomCapStart;
    for (const start of bottomRingStarts) {
        for (let i = 0; i < count; i += 1) {
            const j = (i + 1) % count;
            faces.push([previous + i, previous + j, start + j]);
            faces.push([previous + i, start + j, start + i]);
        }
        previous = start;
    }

    const wallBottom = bottomRingStarts[bottomRingStarts.length - 1];
    const wallTop = topRingStarts[0];
    for (let i = 0; i < count; i += 1) {
        const j = (i + 1) % count;
        faces.push([wallBottom + i, wallBottom + j, wallTop + j]);
        faces.push([wallBottom + i, wallTop + j, wallTop + i]);
    }

    previous = wallTop;
    for (let ring = 1; ring < topRingStarts.length; ring += 1) {
        const start = topRingStarts[ring];
        for (let i = 0; i < count; i += 1) {
            const j = (i + 1) % count;
            faces.push([previous + i, previous + j, start + j]);
            faces.push([previous + i, start + j, start + i]);
        }
        previous = start;
    }

    for (let i = 0; i < count; i += 1) {
        const j = (i + 1) % count;
        faces.push([previous + i, previous + j, topCapStart + j]);
        faces.push([previous + i, topCapStart + j, topCapStart + i]);
    }

    const insetPolygon = topRings[bevelSteps].map(([x, , z]) => [x, z]);
    const capTriangles = triangulatePolygon(insetPolygon);
    for (const [a, b, c] of capTriangles) {
        faces.push([bottomCapStart + a, bottomCapStart + c, bottomCapStart + b]);
    }
    for (const [a, b, c] of capTriangles) {
        faces.push([topCapStart + a, topCapStart + b, topCapStart + c]);
    }

    const { vertices: finalVertices, faces: finalFaces } = dropDegenerateFaces(vertices, faces);

    return {
        attributes: {
            positions: { value: new Float32Array(finalVertices.flat()), size: 3 }
        },
        indices: { value: new Uint32Array(finalFaces.flat()), size: 1 }
    };
};

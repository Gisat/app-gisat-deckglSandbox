/**
 * Arrow LOD stream 2D — pure “time-snake” geometry.
 *
 * No React, no deck.gl. The map host turns the returned mesh into one
 * `SimpleMeshLayer` instance and the tubes into slice dots / base markers.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **Time is the Z axis and is linear in real days.** First acquisition sits
 *    on the ground, last at the top, regardless of sample count.
 * 2. **Smoothing happens before resampling, on each point's own sorted dates.**
 *    Parquet `LIST()` order is not guaranteed, so every series is sorted first;
 *    resampling goes onto one global uniform time grid afterwards.
 * 3. **The lateral offset is relative to the point's first finite value.** The
 *    colour and tooltip keep using the absolute displacement, so the tube stays
 *    anchored on its base marker while the legend still applies.
 */

import { smoothSeries, interpolateSeries } from '../PolakyHradecV3/bandGeometry';
import { colorScale } from '../../layers/displacementScale';

export const SMOOTH_OPTIONS = [0, 7, 21, 45, 90];
export const SAMPLE_COUNT = 160;
export const RADIAL_SEGMENTS = 16;
export const MAX_TUBES = 200;
export const ANIMATION_DURATION_MS = 8000;

// Metres in one degree of latitude. Longitude follows cos(lat).
export const METRES_PER_DEG_LAT = 111320;

export function metresPerDegLon(latDeg) {
    return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseDateMs(value) {
    if (typeof value !== 'string' || value.length < 10) return NaN;
    const ms = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Direction of the horizontal LOS vector, in local metric axes
 * `[east, north]`. Falls back to `track_angle` (compass degrees), then north.
 *
 * @param {Record<string, any>} properties
 * @returns {[number, number]} Unit vector.
 */
export function featureDirection(properties) {
    const east = Number(properties?.los_east);
    const north = Number(properties?.los_north);
    const length = Math.hypot(east, north);
    if (Number.isFinite(length) && length > 1e-6) {
        return [east / length, north / length];
    }

    const trackAngle = Number(properties?.track_angle);
    if (Number.isFinite(trackAngle)) {
        const rad = (trackAngle * Math.PI) / 180;
        return [Math.sin(rad), Math.cos(rad)];
    }

    return [0, 1];
}

/**
 * `temporal_coherence` clamped to [0, 1]; null when missing/non-finite.
 *
 * @param {Record<string, any>} properties
 * @returns {number|null}
 */
export function featureCoherence(properties) {
    const value = Number(properties?.temporal_coherence);
    if (!Number.isFinite(value)) return null;
    return clamp(value, 0, 1);
}

/** One feature's dates and displacements, sorted by `(datesMs, value)`. */
function featureSeries(feature) {
    const properties = feature?.properties ?? {};
    const dates = Array.isArray(properties.dates) ? properties.dates : [];
    const values = Array.isArray(properties.displacements) ? properties.displacements : [];
    const count = Math.min(dates.length, values.length);

    const pairs = [];
    for (let i = 0; i < count; i++) {
        const dateMs = parseDateMs(dates[i]);
        const value = Number(values[i]);
        if (!Number.isFinite(dateMs) || !Number.isFinite(value)) continue;
        pairs.push({ dateMs, value });
    }

    pairs.sort((a, b) => a.dateMs - b.dateMs || a.value - b.value);

    return {
        dates: pairs.map(pair => pair.dateMs),
        values: pairs.map(pair => pair.value),
    };
}

/** Even spatial sample; parquet Hilbert order makes an even slice approximate. */
function evenSampleIndices(count, maxCount) {
    if (count <= maxCount) {
        return Array.from({ length: count }, (_, index) => index);
    }
    if (maxCount <= 1) return [0];

    const indices = [];
    for (let i = 0; i < maxCount; i++) {
        const index = Math.round((i * (count - 1)) / (maxCount - 1));
        if (indices[indices.length - 1] !== index) indices.push(index);
    }
    return indices;
}

/** One uniform global time grid, rounded to whole milliseconds. */
function buildSampleGrid(startMs, endMs, samples) {
    const count = Math.max(2, samples);
    const spanMs = Math.max(1, endMs - startMs);
    const grid = new Array(count);
    for (let i = 0; i < count; i++) {
        grid[i] = Math.round(startMs + (spanMs * i) / (count - 1));
    }
    return grid;
}

/** First finite entry, or null. */
function firstFinite(values) {
    for (const value of values ?? []) {
        if (Number.isFinite(value)) return value;
    }
    return null;
}

/** Last finite entry, or null. */
function lastFinite(values) {
    for (let i = (values?.length ?? 0) - 1; i >= 0; i--) {
        if (Number.isFinite(values[i])) return values[i];
    }
    return null;
}

/**
 * Selection summary used for the adaptive default scales and camera fit.
 *
 * @param {Array<any>} features GeoJSON features from `/api/select`.
 * @returns {{
 *   bounds: [number, number, number, number]|null,
 *   spanM: number,
 *   maxAbsDisplacementMm: number,
 *   meanLosBearingDeg: number|null,
 *   suggestedTimeHeightM: number,
 *   suggestedLeanMPerMm: number,
 *   suggestedRadiusM: number,
 *   timeRange: { startMs: number, endMs: number }|null,
 * }}
 */
export function computeSelectionStats(features) {
    const list = Array.isArray(features) ? features : [];

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    let maxAbsDisplacementMm = 0;
    let startMs = Infinity;
    let endMs = -Infinity;
    let losEastSum = 0;
    let losNorthSum = 0;
    let losCount = 0;
    let trackEastSum = 0;
    let trackNorthSum = 0;
    let trackCount = 0;

    for (const feature of list) {
        const coords = feature?.geometry?.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
            const lon = Number(coords[0]);
            const lat = Number(coords[1]);
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                minLon = Math.min(minLon, lon);
                minLat = Math.min(minLat, lat);
                maxLon = Math.max(maxLon, lon);
                maxLat = Math.max(maxLat, lat);
            }
        }

        const properties = feature?.properties ?? {};
        const displacements = Array.isArray(properties.displacements)
            ? properties.displacements
            : [];
        for (const raw of displacements) {
            const value = Number(raw);
            if (Number.isFinite(value)) {
                maxAbsDisplacementMm = Math.max(maxAbsDisplacementMm, Math.abs(value));
            }
        }

        const dates = Array.isArray(properties.dates) ? properties.dates : [];
        for (const raw of dates) {
            const dateMs = parseDateMs(raw);
            if (!Number.isFinite(dateMs)) continue;
            startMs = Math.min(startMs, dateMs);
            endMs = Math.max(endMs, dateMs);
        }

        const east = Number(properties.los_east);
        const north = Number(properties.los_north);
        const losLength = Math.hypot(east, north);
        if (Number.isFinite(losLength) && losLength > 1e-6) {
            losEastSum += east / losLength;
            losNorthSum += north / losLength;
            losCount += 1;
        } else {
            const trackAngle = Number(properties.track_angle);
            if (Number.isFinite(trackAngle)) {
                const rad = (trackAngle * Math.PI) / 180;
                trackEastSum += Math.sin(rad);
                trackNorthSum += Math.cos(rad);
                trackCount += 1;
            }
        }
    }

    const hasBounds = Number.isFinite(minLon) && Number.isFinite(minLat)
        && Number.isFinite(maxLon) && Number.isFinite(maxLat);
    const bounds = hasBounds ? [minLon, minLat, maxLon, maxLat] : null;

    const spanM = hasBounds
        ? Math.max(
            Math.hypot(
                (maxLon - minLon) * metresPerDegLon((minLat + maxLat) / 2),
                (maxLat - minLat) * METRES_PER_DEG_LAT,
            ),
            20,
        )
        : 20;

    let bearingDeg = null;
    if (losCount > 0) {
        bearingDeg = (Math.atan2(losEastSum, losNorthSum) * 180) / Math.PI;
    } else if (trackCount > 0) {
        bearingDeg = (Math.atan2(trackEastSum, trackNorthSum) * 180) / Math.PI;
    }
    if (Number.isFinite(bearingDeg)) {
        bearingDeg = ((bearingDeg % 360) + 360) % 360;
    } else {
        bearingDeg = null;
    }

    const timeRange = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
        ? { startMs, endMs }
        : null;

    const safeMaxAbsMm = maxAbsDisplacementMm > 0 ? maxAbsDisplacementMm : 1;
    const suggestedTimeHeightM = clamp(0.8 * spanM, 80, 1200);
    // Keep the lateral exaggeration and the tube radius below the vertical
    // sample spacing, so adjacent cross-sections can never fold over each other.
    const suggestedLeanMPerMm = clamp(
        (0.15 * suggestedTimeHeightM) / safeMaxAbsMm,
        0.2,
        1.5,
    );
    const suggestedRadiusM = clamp(
        Math.min(
            0.012 * spanM,
            0.45 * (suggestedTimeHeightM / SAMPLE_COUNT),
        ),
        0.4,
        15,
    );

    return {
        bounds,
        spanM,
        maxAbsDisplacementMm,
        meanLosBearingDeg: bearingDeg,
        suggestedTimeHeightM,
        suggestedLeanMPerMm,
        suggestedRadiusM,
        timeRange,
    };
}

/**
 * One smoothed, resampled series per selected point, split into contiguous
 * finite runs (one tube per run).
 *
 * @param {Array<any>} features
 * @param {{
 *   smoothDays?: number, samples?: number, maxTubes?: number,
 *   timeRange?: { startMs: number, endMs: number }|null,
 * }} options
 * @returns {{
 *   tubes: Array<{
 *     pointId: any, lon: number, lat: number,
 *     gridMs: number[], values: number[],
 *     baselineMm: number, dir: [number, number],
 *     coherence: number|null, lastValueMm: number|null,
 *     sampleCount: number, runStart: number,
 *   }>,
 *   totalFeatures: number, usedFeatures: number,
 *   timeRange: { startMs: number, endMs: number }|null,
 * }}
 */
export function buildSnakeSeries(features, options = {}) {
    const list = Array.isArray(features) ? features : [];
    const smoothDays = Number.isFinite(options.smoothDays) ? options.smoothDays : 0;
    const samples = Math.max(2, options.samples || SAMPLE_COUNT);
    const maxTubes = Math.max(1, options.maxTubes || MAX_TUBES);

    const empty = {
        tubes: [],
        totalFeatures: list.length,
        usedFeatures: 0,
        timeRange: null,
    };
    if (list.length === 0) return empty;

    const sampledIndices = evenSampleIndices(list.length, maxTubes);
    const sampled = sampledIndices.map(index => list[index]);

    // Global selection range. Prefer the value already computed by
    // `computeSelectionStats` so the full feature list is not parsed twice.
    let timeRange = null;
    if (options.timeRange
        && Number.isFinite(options.timeRange.startMs)
        && Number.isFinite(options.timeRange.endMs)
        && options.timeRange.endMs >= options.timeRange.startMs) {
        timeRange = {
            startMs: options.timeRange.startMs,
            endMs: options.timeRange.endMs,
        };
    } else {
        let startMs = Infinity;
        let endMs = -Infinity;
        for (const feature of list) {
            const dates = Array.isArray(feature?.properties?.dates)
                ? feature.properties.dates
                : [];
            for (const raw of dates) {
                const dateMs = parseDateMs(raw);
                if (!Number.isFinite(dateMs)) continue;
                startMs = Math.min(startMs, dateMs);
                endMs = Math.max(endMs, dateMs);
            }
        }
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            timeRange = { startMs, endMs };
        }
    }

    if (!timeRange) {
        return { ...empty, usedFeatures: sampled.length };
    }

    const { startMs, endMs } = timeRange;
    const grid = buildSampleGrid(startMs, endMs, samples);

    const tubes = [];
    for (const feature of sampled) {
        const coords = feature?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

        const { dates, values } = featureSeries(feature);
        if (dates.length === 0) continue;

        // Resample the raw series onto the global uniform grid first, then run
        // three cascaded boxcars there. Three passes approximate a Gaussian
        // and leave continuous tangents, unlike one boxcar whose derivative
        // corners showed up as kinks/twists in the tube frame.
        const rawValues = values.map(value => (Number.isFinite(value) ? value : null));
        let resampled = interpolateSeries(grid, dates, rawValues);
        if (smoothDays > 0) {
            const passDays = Math.max(1, smoothDays / 2);
            for (let pass = 0; pass < 3; pass++) {
                resampled = smoothSeries(resampled, grid, passDays);
            }
        }

        const baselineMm = firstFinite(resampled);
        if (baselineMm === null) continue;

        const properties = feature?.properties ?? {};
        const pointId = properties.point_id ?? feature?.id ?? null;
        const dir = featureDirection(properties);
        const coherence = featureCoherence(properties);
        const lastValueMm = lastFinite(resampled);

        // Contiguous finite runs; a gap never carries the previous value.
        let runStart = -1;
        for (let i = 0; i <= resampled.length; i++) {
            const finite = i < resampled.length && Number.isFinite(resampled[i]);
            if (finite && runStart < 0) runStart = i;
            if (!finite && runStart >= 0) {
                if (i - runStart >= 2) {
                    tubes.push({
                        pointId,
                        lon,
                        lat,
                        gridMs: grid.slice(runStart, i),
                        values: resampled.slice(runStart, i),
                        baselineMm,
                        dir,
                        coherence,
                        lastValueMm,
                        sampleCount: grid.length,
                        runStart,
                    });
                }
                runStart = -1;
            }
        }
    }

    // A parquet without the optional coherence column returns 0 for every
    // point (backend `None -> 0`). Treat an all-zero selection as "no
    // reliability data" so it falls back to a fixed radius, while a single
    // genuine 0 still means "thin".
    const hasReliability = tubes.some(
        tube => Number.isFinite(tube.coherence) && tube.coherence > 0,
    );
    if (!hasReliability) {
        for (const tube of tubes) tube.coherence = null;
    }

    return {
        tubes,
        totalFeatures: list.length,
        usedFeatures: sampled.length,
        timeRange,
    };
}

function cross(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function normalize3(v) {
    const length = Math.hypot(v[0], v[1], v[2]);
    if (length < 1e-12) return [0, 0, 1];
    return [v[0] / length, v[1] / length, v[2] / length];
}

function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Smooth central-difference tangents, with one-sided differences at the ends.
 *
 * @param {number[][]} points Path points in local metres.
 * @returns {number[][]} Unit tangents.
 */
function pathTangents(points) {
    const count = points.length;
    const tangents = new Array(count);

    for (let i = 0; i < count; i++) {
        const previous = points[Math.max(0, i - 1)];
        const next = points[Math.min(count - 1, i + 1)];
        const dx = next[0] - previous[0];
        const dy = next[1] - previous[1];
        const dz = next[2] - previous[2];
        const length = Math.hypot(dx, dy, dz);

        if (length < 1e-12) {
            tangents[i] = i > 0 ? tangents[i - 1] : [0, 0, 1];
        } else {
            tangents[i] = [dx / length, dy / length, dz / length];
        }
    }

    return tangents;
}

/** Reference axis least aligned with `tangent`, for a stable initial frame. */
function stableReference(tangent) {
    return Math.abs(tangent[0]) <= Math.abs(tangent[1])
        ? [1, 0, 0]
        : [0, 1, 0];
}

/** Project `vector` onto the plane perpendicular to `axis` and normalise it. */
function perpendicularComponent(vector, axis) {
    const projection = dot3(vector, axis);
    const projected = [
        vector[0] - projection * axis[0],
        vector[1] - projection * axis[1],
        vector[2] - projection * axis[2],
    ];
    if (Math.hypot(projected[0], projected[1], projected[2]) < 1e-9) {
        // Fully parallel: derive a fresh perpendicular deterministically.
        const fallbackAxis = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        return normalize3(cross(axis, fallbackAxis));
    }
    return normalize3(projected);
}

/**
 * Parallel-transport (Bishop) frame along a polyline.
 *
 * A per-ring `cross(tangent, up)` frame flips 180° when the horizontal
 * velocity reverses, tearing holes in the tube. Parallel transport keeps the
 * normal continuous: each normal is rotated from the previous tangent to the
 * current one, then re-orthonormalised.
 *
 * @param {number[][]} tangents Unit tangents.
 * @returns {{ normals: number[][], binormals: number[][] }}
 */
function parallelTransportFrames(tangents) {
    const count = tangents.length;
    const normals = new Array(count);
    const binormals = new Array(count);
    if (count === 0) return { normals, binormals };

    const t0 = tangents[0];
    normals[0] = perpendicularComponent(stableReference(t0), t0);
    binormals[0] = normalize3(cross(t0, normals[0]));

    for (let i = 1; i < count; i++) {
        const previousTangent = tangents[i - 1];
        const tangent = tangents[i];
        const axisRaw = cross(previousTangent, tangent);
        const axisLength = Math.hypot(axisRaw[0], axisRaw[1], axisRaw[2]);
        let normal = normals[i - 1];

        if (axisLength > 1e-9) {
            // Rodrigues rotation of the previous normal around the axis
            // turning T[i-1] into T[i].
            const axis = [
                axisRaw[0] / axisLength,
                axisRaw[1] / axisLength,
                axisRaw[2] / axisLength,
            ];
            const angle = Math.acos(clamp(dot3(previousTangent, tangent), -1, 1));
            const cosAngle = Math.cos(angle);
            const sinAngle = Math.sin(angle);
            const axisCrossNormal = cross(axis, normal);
            const axisDotNormal = dot3(axis, normal);

            normal = [
                normal[0] * cosAngle + axisCrossNormal[0] * sinAngle
                    + axis[0] * axisDotNormal * (1 - cosAngle),
                normal[1] * cosAngle + axisCrossNormal[1] * sinAngle
                    + axis[1] * axisDotNormal * (1 - cosAngle),
                normal[2] * cosAngle + axisCrossNormal[2] * sinAngle
                    + axis[2] * axisDotNormal * (1 - cosAngle),
            ];
        }

        normals[i] = perpendicularComponent(normal, tangent);
        binormals[i] = normalize3(cross(tangent, normals[i]));
    }

    return { normals, binormals };
}

/**
 * One combined tube mesh for every tube (one instance renders all of them).
 *
 * @param {Array<any>} tubes From `buildSnakeSeries`.
 * @param {{
 *   timeRange: { startMs: number, endMs: number },
 *   timeHeightM: number, leanMPerMm: number,
 *   widthByCoherence?: boolean, radiusBaseM?: number,
 *   flipLean?: boolean,
 * }} options
 * @returns {{ origin: [number, number]|null, mesh: object|null }}
 */
export function buildSnakeMesh(tubes, options) {
    const list = Array.isArray(tubes) ? tubes : [];
    const timeRange = options?.timeRange;
    const timeHeightM = Number.isFinite(options?.timeHeightM) ? options.timeHeightM : 0;
    const leanMPerMm = Number.isFinite(options?.leanMPerMm) ? options.leanMPerMm : 1;
    const widthByCoherence = Boolean(options?.widthByCoherence);
    const radiusBaseM = Number.isFinite(options?.radiusBaseM) ? options.radiusBaseM : 4;
    const flip = options?.flipLean ? -1 : 1;

    if (list.length === 0 || !timeRange) {
        return { origin: null, mesh: null };
    }

    // Origin is the mean of the distinct sampled points.
    const uniquePoints = new Map();
    for (const tube of list) {
        const key = String(tube.pointId ?? `${tube.lon},${tube.lat}`);
        if (!uniquePoints.has(key)) uniquePoints.set(key, tube);
    }
    let originLon = 0;
    let originLat = 0;
    for (const tube of uniquePoints.values()) {
        originLon += tube.lon;
        originLat += tube.lat;
    }
    const originCount = Math.max(1, uniquePoints.size);
    originLon /= originCount;
    originLat /= originCount;

    const mPerDegLon = metresPerDegLon(originLat);
    const spanMs = Math.max(1, timeRange.endMs - timeRange.startMs);
    const ringSegments = RADIAL_SEGMENTS;

    // Two-pass sizing: count vertices/indices first so the buffers can be
    // allocated once instead of growing large JS arrays and copying them.
    const renderable = [];
    let totalVertices = 0;
    let totalIndices = 0;
    for (const tube of list) {
        const values = Array.isArray(tube.values) ? tube.values : [];
        const gridMs = Array.isArray(tube.gridMs) ? tube.gridMs : [];
        const count = Math.min(values.length, gridMs.length);
        if (count < 2) continue;
        renderable.push({ tube, count });
        totalVertices += count * ringSegments;
        totalIndices += (count - 1) * ringSegments * 6;
    }

    if (totalVertices === 0) {
        return { origin: [originLon, originLat], mesh: null };
    }

    const positions = new Float32Array(totalVertices * 3);
    const colors = new Float32Array(totalVertices * 3);
    const normals = new Float32Array(totalVertices * 3);
    const indices = new Uint32Array(totalIndices);
    let vertexOffset = 0;
    let indexOffset = 0;

    for (const { tube, count } of renderable) {
        const values = tube.values;
        const gridMs = tube.gridMs;

        const dirEast = (Array.isArray(tube.dir) ? tube.dir[0] : 0) * flip;
        const dirNorth = (Array.isArray(tube.dir) ? tube.dir[1] : 1) * flip;
        const radius = widthByCoherence && Number.isFinite(tube.coherence)
            ? radiusBaseM * (0.4 + 0.6 * tube.coherence)
            : radiusBaseM;

        // Local path: metric XY offsets from the origin, real time on Z.
        const path = new Array(count);
        const sampleColors = new Array(count);
        for (let i = 0; i < count; i++) {
            const valueMm = values[i];
            const u = clamp((gridMs[i] - timeRange.startMs) / spanMs, 0, 1);
            const z = u * timeHeightM;
            const lateral = (valueMm - tube.baselineMm) * leanMPerMm;
            const x = (tube.lon - originLon) * mPerDegLon + lateral * dirEast;
            const y = (tube.lat - originLat) * METRES_PER_DEG_LAT + lateral * dirNorth;
            path[i] = [x, y, z];
            // Colour by the absolute (non-rebased) signed displacement, so the
            // tube matches the 2D point colours and the legend exactly.
            sampleColors[i] = colorScale(valueMm);
        }

        const baseVertex = vertexOffset;
        const tangents = pathTangents(path);
        const { normals: ringNormals, binormals } = parallelTransportFrames(tangents);

        for (let i = 0; i < count; i++) {
            const point = path[i];
            const rgb = sampleColors[i];
            const n1 = ringNormals[i];
            const n2 = binormals[i];

            for (let j = 0; j < ringSegments; j++) {
                const angle = (j / ringSegments) * Math.PI * 2;
                const cos = Math.cos(angle);
                const sin = Math.sin(angle);
                const nx = n1[0] * cos + n2[0] * sin;
                const ny = n1[1] * cos + n2[1] * sin;
                const nz = n1[2] * cos + n2[2] * sin;
                const offset = vertexOffset * 3;

                positions[offset] = point[0] + nx * radius;
                positions[offset + 1] = point[1] + ny * radius;
                positions[offset + 2] = point[2] + nz * radius;
                normals[offset] = nx;
                normals[offset + 1] = ny;
                normals[offset + 2] = nz;
                colors[offset] = rgb[0] / 255;
                colors[offset + 1] = rgb[1] / 255;
                colors[offset + 2] = rgb[2] / 255;
                vertexOffset += 1;
            }
        }

        for (let i = 0; i < count - 1; i++) {
            for (let j = 0; j < ringSegments; j++) {
                const nextJ = (j + 1) % ringSegments;
                const a = baseVertex + i * ringSegments + j;
                const b = baseVertex + i * ringSegments + nextJ;
                const c = baseVertex + (i + 1) * ringSegments + j;
                const d = baseVertex + (i + 1) * ringSegments + nextJ;
                indices[indexOffset] = a;
                indices[indexOffset + 1] = b;
                indices[indexOffset + 2] = c;
                indices[indexOffset + 3] = b;
                indices[indexOffset + 4] = d;
                indices[indexOffset + 5] = c;
                indexOffset += 6;
            }
        }
    }

    return {
        origin: [originLon, originLat],
        mesh: {
            attributes: {
                positions: { value: positions, size: 3 },
                colors: { value: colors, size: 3 },
                normals: { value: normals, size: 3 },
            },
            indices,
        },
    };
}

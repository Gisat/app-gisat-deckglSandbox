/**
 * Arrow LOD stream 2D — pure time-slice geometry for the time-snake view.
 *
 * No React, no deck.gl. The map host turns these into LineLayer / TextLayer /
 * ScatterplotLayer / PolygonLayer data.
 */

import { colorScale } from '../../layers/displacementScale';
import {
    METRES_PER_DEG_LAT,
    metresPerDegLon,
} from './snakeGeometry';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function formatUtcDate(epochMs) {
    return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Vertical time axis placed on the screen-right-most corner of the selection.
 *
 * The corner is chosen by projecting each bounds corner onto the camera's
 * screen-right direction in local metres, so the axis sits in front of the
 * tubes instead of behind them. It is built on entry/refit only; manual camera
 * rotation does not move it.
 *
 * @param {[number, number, number, number]|null} bounds `[minLon, minLat, maxLon, maxLat]`
 * @param {{ startMs: number, endMs: number }} timeRange
 * @param {number} timeHeightM
 * @param {{ ticks?: number, marginM?: number, bearingDeg?: number }} options
 * @returns {{
 *   origin: [number, number],
 *   stem: number[][],
 *   ticks: Array<{
 *     u: number, z: number, dateMs: number, label: string,
 *     tip: [number, number, number], hit: [number, number, number],
 *   }>,
 * }|null}
 */
export function buildTimeAxis(bounds, timeRange, timeHeightM, options = {}) {
    if (!Array.isArray(bounds) || !timeRange) return null;

    const [minLon, minLat, maxLon, maxLat] = bounds;
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return null;

    const height = Number.isFinite(timeHeightM) ? timeHeightM : 0;
    const marginM = Number.isFinite(options.marginM) ? options.marginM : 4;
    const bearingDeg = Number.isFinite(options.bearingDeg) ? options.bearingDeg : 0;
    const tickCount = Math.max(2, options.ticks ?? 10);

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;
    const rightRad = ((bearingDeg + 90) * Math.PI) / 180;
    // Compass heading -> local metric vector. 0° is north and 90° is east, so
    // east = sin(heading) and north = cos(heading). Using cos/sin here would
    // rotate the whole axis 90° off the screen-right edge.
    const rightEast = Math.sin(rightRad);
    const rightNorth = Math.cos(rightRad);
    const mPerDegLon = metresPerDegLon(centerLat);

    const corners = [
        [minLon, minLat],
        [maxLon, minLat],
        [maxLon, maxLat],
        [minLon, maxLat],
    ];

    let best = corners[0];
    let bestProjection = -Infinity;
    for (const corner of corners) {
        const projection = (corner[0] - centerLon) * mPerDegLon * rightEast
            + (corner[1] - centerLat) * METRES_PER_DEG_LAT * rightNorth;
        if (projection > bestProjection) {
            bestProjection = projection;
            best = corner;
        }
    }

    const originLon = best[0] + (marginM * rightEast) / mPerDegLon;
    const originLat = best[1] + (marginM * rightNorth) / METRES_PER_DEG_LAT;

    const spanMs = Math.max(1, timeRange.endMs - timeRange.startMs);
    const tickLengthM = Math.max(3, Math.min(12, marginM));
    const ticks = [];
    for (let i = 0; i < tickCount; i++) {
        const u = i / (tickCount - 1);
        const dateMs = Math.round(timeRange.startMs + u * spanMs);
        const z = u * height;
        ticks.push({
            u,
            z,
            dateMs,
            label: formatUtcDate(dateMs),
            hit: [originLon, originLat, z],
            tip: [
                originLon + (tickLengthM * rightEast) / mPerDegLon,
                originLat + (tickLengthM * rightNorth) / METRES_PER_DEG_LAT,
                z,
            ],
        });
    }

    return {
        origin: [originLon, originLat],
        stem: [
            [originLon, originLat, 0],
            [originLon, originLat, height],
        ],
        ticks,
    };
}

/**
 * Selection outline lifted to the current slice height.
 *
 * @param {any} drawnGeometry Normalized GeoJSON geometry.
 * @param {number} sliceU 0..1
 * @param {number} timeHeightM
 * @returns {number[][]|null} Closed ring of `[lon, lat, z]`, or null when the
 *   selection is not a Polygon.
 */
export function buildSliceRing(drawnGeometry, sliceU, timeHeightM) {
    if (drawnGeometry?.type !== 'Polygon') return null;
    const ring = drawnGeometry?.coordinates?.[0];
    if (!Array.isArray(ring) || ring.length < 3) return null;

    const z = clamp(Number.isFinite(sliceU) ? sliceU : 0, 0, 1)
        * (Number.isFinite(timeHeightM) ? timeHeightM : 0);

    const out = [];
    for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const lon = Number(point[0]);
        const lat = Number(point[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        out.push([lon, lat, z]);
    }
    return out.length >= 3 ? out : null;
}

/**
 * One intersection dot per tube at the resampled sample nearest `sliceU`.
 *
 * The global grid is uniform, so the index is `round(sliceU * (N - 1))`
 * regardless of the tube's contiguous run.
 *
 * @param {Array<any>} tubes From `buildSnakeSeries`.
 * @param {number} sliceU 0..1
 * @param {number} timeHeightM
 * @param {number} leanMPerMm
 * @param {boolean} flipLean
 * @returns {Array<{
 *   pointId: any, position: [number, number, number],
 *   valueMm: number, color: [number, number, number, number],
 * }>}
 */
export function buildSlicePoints(tubes, sliceU, timeHeightM, leanMPerMm, flipLean) {
    const list = Array.isArray(tubes) ? tubes : [];
    const u = clamp(Number.isFinite(sliceU) ? sliceU : 0, 0, 1);
    const height = Number.isFinite(timeHeightM) ? timeHeightM : 0;
    const lean = Number.isFinite(leanMPerMm) ? leanMPerMm : 1;
    const flip = flipLean ? -1 : 1;
    const z = u * height;

    const points = [];
    for (const tube of list) {
        if (!Array.isArray(tube?.values)) continue;
        const sampleCount = Number.isFinite(tube.sampleCount) ? tube.sampleCount : 0;
        const runStart = Number.isFinite(tube.runStart) ? tube.runStart : 0;
        if (sampleCount < 2) continue;

        const globalIndex = Math.round(u * (sampleCount - 1));
        const localIndex = globalIndex - runStart;
        if (localIndex < 0 || localIndex >= tube.values.length) continue;

        const valueMm = tube.values[localIndex];
        if (!Number.isFinite(valueMm)) continue;

        const lateral = (valueMm - tube.baselineMm) * lean;
        const dirEast = Array.isArray(tube.dir) ? tube.dir[0] : 0;
        const dirNorth = Array.isArray(tube.dir) ? tube.dir[1] : 1;
        const lon = tube.lon + (lateral * dirEast * flip) / metresPerDegLon(tube.lat);
        const lat = tube.lat + (lateral * dirNorth * flip) / METRES_PER_DEG_LAT;
        const rgb = colorScale(valueMm);

        points.push({
            pointId: tube.pointId,
            position: [lon, lat, z],
            valueMm,
            color: [rgb[0], rgb[1], rgb[2], 255],
        });
    }
    return points;
}

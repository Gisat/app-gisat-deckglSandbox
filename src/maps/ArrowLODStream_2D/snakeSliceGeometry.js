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
    projectDisplacement,
} from './snakeGeometry';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

// Calendar-axis granularities. The Time-height setting requests one of these.
const LABEL_GRANULARITIES = ['year', 'quarter'];

/**
 * Calendar-aligned label boundaries for the time axis.
 *
 * Rounds to real year / quarter starts instead of arbitrary acquisition dates,
 * so the axis reads as whole calendar periods. The partial period that contains
 * the range start is anchored at the range start (so the first period is still
 * labelled); periods that begin after the range end are dropped.
 *
 * @param {number} startMs
 * @param {number} endMs
 * @param {'year'|'quarter'} granularity
 * @returns {Array<{ ms: number, text: string }>}
 */
function buildCalendarLabels(startMs, endMs, granularity) {
    const startYear = new Date(startMs).getUTCFullYear();
    const endYear = new Date(endMs).getUTCFullYear();
    const months = granularity === 'quarter' ? [0, 3, 6, 9] : [0];

    const periods = [];
    for (let year = startYear; year <= endYear; year++) {
        for (const month of months) {
            const boundaryMs = Date.UTC(year, month, 1);
            if (boundaryMs > endMs) continue;
            periods.push({ boundaryMs, year, month });
        }
    }

    // Anchor the partial period containing `startMs` at the range start.
    let first = 0;
    for (let i = 0; i < periods.length; i++) {
        if (periods[i].boundaryMs <= startMs) first = i;
        else break;
    }

    const labels = [];
    for (let i = first; i < periods.length; i++) {
        const { boundaryMs, year, month } = periods[i];
        const ms = i === first ? Math.max(startMs, boundaryMs) : boundaryMs;
        // Hierarchical axis: January carries the year, quarter starts carry
        // the quarter.
        const text = month === 0
            ? String(year)
            : `${year} ${pad2(month + 1)}-${pad2(month + 3)}`;
        labels.push({ ms, text });
    }
    return labels;
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
 * @param {{
 *   labelGranularity?: 'year'|'quarter',
 *   marginM?: number, bearingDeg?: number,
 * }} options
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

    const startMs = timeRange.startMs;
    const endMs = timeRange.endMs;
    const spanMs = Math.max(1, endMs - startMs);
    const tickLengthM = Math.max(3, Math.min(12, marginM));

    // The requested granularity comes from the time-height setting and is
    // honoured exactly: 0.5× years only, 1× and 2× years + quarters.
    // The time-height control is the user's lever for label density, so no
    // automatic coarsening is applied.
    const granularity = LABEL_GRANULARITIES.includes(options.labelGranularity)
        ? options.labelGranularity
        : 'quarter';
    const labels = buildCalendarLabels(startMs, endMs, granularity);

    const ticks = labels.map(({ ms, text }) => {
        const u = clamp((ms - startMs) / spanMs, 0, 1);
        const z = u * height;
        return {
            u,
            z,
            dateMs: ms,
            label: text,
            hit: [originLon, originLat, z],
            tip: [
                originLon + (tickLengthM * rightEast) / mPerDegLon,
                originLat + (tickLengthM * rightNorth) / METRES_PER_DEG_LAT,
                z,
            ],
        };
    });

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
 * @param {'los'|'vertical'} [projectionMode] Displacement projection used for
 *   the lateral offset and colour (default `'los'`).
 * @returns {Array<{
 *   pointId: any, position: [number, number, number],
 *   valueMm: number, color: [number, number, number, number],
 * }>}
 */
export function buildSlicePoints(
    tubes,
    sliceU,
    timeHeightM,
    leanMPerMm,
    flipLean,
    projectionMode = 'los',
) {
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

        // Project both the value and its baseline so the lateral offset stays
        // relative to the same point's first acquisition under either mode.
        const projectedValue = projectDisplacement(valueMm, tube.losUp, projectionMode);
        const projectedBaseline = projectDisplacement(
            tube.baselineMm,
            tube.losUp,
            projectionMode,
        );
        const lateral = (projectedValue - projectedBaseline) * lean;
        const dirEast = Array.isArray(tube.dir) ? tube.dir[0] : 0;
        const dirNorth = Array.isArray(tube.dir) ? tube.dir[1] : 1;
        const lon = tube.lon + (lateral * dirEast * flip) / metresPerDegLon(tube.lat);
        const lat = tube.lat + (lateral * dirNorth * flip) / METRES_PER_DEG_LAT;
        const rgb = colorScale(projectedValue);

        points.push({
            pointId: tube.pointId,
            position: [lon, lat, z],
            valueMm,
            color: [rgb[0], rgb[1], rgb[2], 255],
        });
    }
    return points;
}

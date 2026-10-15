import { haversine } from '../PointSelection/geometryUtils';

/**
 * Note on Geographical Math:
 * The vector operations below (sub, dot, length) treat longitude and latitude
 * as if they are on a flat 2D Cartesian grid. This is a distortion, as
 * degrees of longitude converge towards the poles.
 *
 * For the purpose of this application (inspecting a single dam), the
 * geographic area is small enough that this distortion is negligible and
 * this approach is acceptable. For larger-scale applications, a projection
 * to a metric coordinate system (e.g., UTM) would be required before
 * performing such calculations.
 */

// Helper for vector operations
const vec = {
    sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
    dot: (a, b) => a[0] * b[0] + a[1] * b[1],
    length: (a) => Math.sqrt(a[0] * a[0] + a[1] * a[1]),
};

/**
 * Perpendicular projection of a point onto a multi-segment line.
 *
 * For every segment the perpendicular foot is computed in the planar degree
 * space used elsewhere in this module (see the file header). The segment whose
 * foot lies closest to the point wins; its foot becomes the reflected position,
 * its along-line distance (metres) becomes `distance`, and the perpendicular
 * gap (metres) becomes `offset`. `within` reports whether the winning foot
 * landed *inside* the segment (`0 <= t <= 1`, using the unclamped `t`), so the
 * line has flat ends — points beyond either end are excluded rather than being
 * snapped to the endpoint.
 *
 * @param {number[]} pointCoords - The [lon, lat] of the point to project.
 * @param {number[][]} lineCoords - The vertices of the line.
 * @returns {{ distance:number, offset:number, foot:number[], within:boolean }}
 *   `distance` and `offset` are in metres; `foot` is the [lon, lat] of the
 *   perpendicular foot (the point itself when the line has no usable segment).
 */
export function projectPointToLine(pointCoords, lineCoords) {
    let minOffsetSq = Infinity;
    let candidate = null;
    let accumulatedLength = 0;

    for (let i = 0; i < lineCoords.length - 1; i++) {
        const start = lineCoords[i];
        const end = lineCoords[i+1];
        const segmentVector = vec.sub(end, start);
        const segmentLength = vec.length(segmentVector);

        // A degenerate vertex adds no length, so it can be skipped without
        // shifting the along-line distances of later segments.
        if (segmentLength === 0) continue;

        const pointVector = vec.sub(pointCoords, start);
        // Unclamped parameter for the `within` test; the foot uses it clamped.
        const t = vec.dot(pointVector, segmentVector) / (segmentLength * segmentLength);
        const clampedT = Math.max(0, Math.min(1, t));

        const foot = [
            start[0] + clampedT * segmentVector[0],
            start[1] + clampedT * segmentVector[1],
        ];
        const offset = haversine(pointCoords, foot) * 1000;
        const distance = accumulatedLength + (haversine(start, foot) * 1000);

        if (offset * offset < minOffsetSq) {
            minOffsetSq = offset * offset;
            candidate = { distance, offset, foot, within: t >= 0 && t <= 1 };
        }

        accumulatedLength += haversine(start, end) * 1000;
    }

    if (!candidate) {
        return { distance: 0, offset: Infinity, foot: pointCoords, within: false };
    }

    return candidate;
}

/**
 * For a given point, calculates its projected distance along a multi-segment line.
 * This is the scalar projection.
 *
 * @param {number[]} pointCoords - The [lon, lat] of the point to project.
 * @param {number[][]} lineCoords - The vertices of the line.
 * @returns {number} The projected distance from the start of the line in meters.
 */
export function projectPointOntoLine(pointCoords, lineCoords) {
    return projectPointToLine(pointCoords, lineCoords).distance;
}

/**
 * Sweep a set of features across a drawn line and keep those whose perpendicular
 * foot falls inside the line and within `bufferMeters` of it. This replaces the
 * former turf-buffer + point-in-polygon selection for line mode: the corridor
 * has flat ends (feet past either end are dropped) and each kept feature is
 * reflected onto the line via its `foot`.
 *
 * @param {object[]} features - Raw GeoJSON features (with `geometry.coordinates`).
 * @param {number[][]} lineCoords - The [lon, lat] vertices of the drawn line.
 * @param {number} bufferMeters - Maximum perpendicular offset to keep, in metres.
 * @returns {Array<{ feature:object, distance:number, offset:number, foot:number[] }>}
 */
export function sampleLineSelection(features, lineCoords, bufferMeters) {
    if (!Array.isArray(features) || !lineCoords || lineCoords.length < 2) {
        return [];
    }

    const selected = [];
    for (const feature of features) {
        const pointCoords = feature?.geometry?.coordinates;
        if (!Array.isArray(pointCoords) || pointCoords.length < 2) continue;

        const { distance, offset, foot, within } = projectPointToLine(pointCoords, lineCoords);
        if (within && offset <= bufferMeters) {
            selected.push({ feature, distance, offset, foot });
        }
    }
    return selected;
}


/**
 * Transforms selected features into multi-metric line profile data.
 * @param {object} selectedFeatures - GeoJSON FeatureCollection of selected points.
 * @param {number[][]} lineCoords - Array of [lon, lat] points defining the line.
 * @param {string[]} metricFields - Array of property field names to extract (e.g., ['VEL_RE_UP', 'VEL_LA_UP']).
 * @returns {object[]} Array of metric series formatted for Nivo: `{ id: 'metricName', data: [{x, y}] }[]`.
 */
export function calculateProfileData(selectedFeatures, lineCoords, metricFields = ['mean_velocity']) {
    if (!selectedFeatures || !selectedFeatures.features || !lineCoords || lineCoords.length < 2) {
        return null;
    }

    // Build chart data for each metric
    const metricsData = {};

    selectedFeatures.features.forEach(feature => {
        const pointCoords = feature.geometry.coordinates;
        const distance = projectPointOntoLine(pointCoords, lineCoords);
        
        // Extract all requested metrics
        metricFields.forEach(field => {
            if (!metricsData[field]) {
                metricsData[field] = [];
            }
            
            const value = feature.properties[field] ?? null;
            metricsData[field].push({
                x: distance,
                y: value,
                point_id: feature.properties.point_id ?? feature.id,
            });
        });
    });

    // Sort each metric's data by distance, convert to Nivo format, and drop series with no real values
    return Object.entries(metricsData)
        .map(([fieldName, data]) => ({
            id: fieldName,
            data: data.sort((a, b) => a.x - b.x)
        }))
        .filter(series => series.data.some(point => point.y !== null));
}

/** @param {unknown} v */
function toNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/**
 * Build a single ordered list of line-profile samples from the selected points.
 *
 * Each sample carries its position along the drawn line, its perpendicular
 * offset and every numeric property on the feature (keyed verbatim, e.g. `H`,
 * `VEL_REL`), so the 3D chart can switch its Y/Z axes client-side without
 * another data pass. `lon`/`lat` are the point's **perpendicular foot** on the
 * line (the reflected position), not the point's own coordinates, so the Plan
 * basis lands the samples on the drawn line. Samples are sorted by distance
 * along the line. This replaces the former multi-series `buildProfileSeries`;
 * `calculateProfileData` (the Nivo 2D chart) is untouched.
 *
 * @param {object} selectedFeatures - GeoJSON FeatureCollection of selected points.
 * @param {number[][]} lineCoords - Array of [lon, lat] points defining the line.
 * @returns {Array<{ id: string|number|null, distance:number, offset:number,
 *   lon:number, lat:number, [key: string]: number|string|null }>}
 */
export function buildProfileSamples(selectedFeatures, lineCoords) {
    if (!selectedFeatures || !selectedFeatures.features || !lineCoords || lineCoords.length < 2) {
        return [];
    }

    const samples = [];

    selectedFeatures.features.forEach((feature) => {
        const pointCoords = feature.geometry?.coordinates;
        if (!Array.isArray(pointCoords) || pointCoords.length < 2) return;

        const props = feature.properties || {};
        const { distance, offset, foot } = projectPointToLine(pointCoords, lineCoords);

        /** @type {Record<string, number|string|null>} */
        const sample = {
            id: props.point_id ?? feature.id ?? null,
            distance,
            offset,
            lon: foot[0],
            lat: foot[1],
        };

        for (const [key, value] of Object.entries(props)) {
            const num = toNumber(value);
            if (num != null) sample[key] = num;
        }

        samples.push(sample);
    });

    return samples.sort((a, b) => a.distance - b.distance);
}

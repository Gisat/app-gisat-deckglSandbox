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
 * For a given point, calculates its projected distance along a multi-segment line.
 * This is the scalar projection.
 *
 * @param {number[]} pointCoords - The [lon, lat] of the point to project.
 * @param {number[][]} lineCoords - The vertices of the line.
 * @returns {number} The projected distance from the start of the line in meters.
 */
export function projectPointOntoLine(pointCoords, lineCoords) {
    let minDistanceSq = Infinity;
    let projectedDistance = 0;
    let accumulatedLength = 0;

    for (let i = 0; i < lineCoords.length - 1; i++) {
        const start = lineCoords[i];
        const end = lineCoords[i+1];
        const segmentVector = vec.sub(end, start);
        const segmentLength = vec.length(segmentVector);
        
        if (segmentLength === 0) continue;

        const pointVector = vec.sub(pointCoords, start);
        let t = vec.dot(pointVector, segmentVector) / (segmentLength * segmentLength);
        t = Math.max(0, Math.min(1, t)); // Clamp to segment

        const projectedPoint = [start[0] + t * segmentVector[0], start[1] + t * segmentVector[1]];
        
        const distToProjected = haversine(pointCoords, projectedPoint) * 1000;
        
        if (distToProjected * distToProjected < minDistanceSq) {
            minDistanceSq = distToProjected * distToProjected;
            projectedDistance = accumulatedLength + (haversine(start, projectedPoint) * 1000);
        }

        accumulatedLength += haversine(start, end) * 1000;
    }

    return projectedDistance;
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
 * Build ordered 3D line-profile series from the selected points.
 *
 * Each returned series carries its ordered samples along the drawn line, ready
 * for the 3D chart renderers (distance / lon / lat / elevation + value & std).
 * Samples without a finite value are dropped; series left with no samples are
 * omitted entirely. This is the multi-series analogue of `calculateProfileData`
 * (which stays untouched for the Nivo 2D chart).
 *
 * @param {object} selectedFeatures - GeoJSON FeatureCollection of selected points.
 * @param {number[][]} lineCoords - Array of [lon, lat] points defining the line.
 * @param {Array<{key:string,stdKey?:string,label:string,color:string,unit?:string}>} seriesDefs
 * @returns {Array<{key:string,label:string,color:string,unit:string,samples:Array<{
 *   id: string|number|null, distance:number, lon:number, lat:number,
 *   height:number|null, value:number, std:number|null }>}>}
 */
export function buildProfileSeries(selectedFeatures, lineCoords, seriesDefs = []) {
    if (!selectedFeatures || !selectedFeatures.features || !lineCoords || lineCoords.length < 2) {
        return [];
    }

    const samplesByKey = new Map(seriesDefs.map((def) => [def.key, []]));

    selectedFeatures.features.forEach((feature) => {
        const pointCoords = feature.geometry?.coordinates;
        if (!Array.isArray(pointCoords) || pointCoords.length < 2) return;

        const props = feature.properties || {};
        const distance = projectPointOntoLine(pointCoords, lineCoords);
        const id = props.point_id ?? feature.id ?? null;
        const height = toNumber(props.H);

        seriesDefs.forEach((def) => {
            const value = toNumber(props[def.key]);
            if (value == null) return;
            samplesByKey.get(def.key).push({
                id,
                distance,
                lon: pointCoords[0],
                lat: pointCoords[1],
                height,
                value,
                std: def.stdKey ? toNumber(props[def.stdKey]) : null,
            });
        });
    });

    return seriesDefs
        .map((def) => ({
            key: def.key,
            label: def.label,
            color: def.color,
            unit: def.unit || '',
            samples: (samplesByKey.get(def.key) || []).sort((a, b) => a.distance - b.distance),
        }))
        .filter((series) => series.samples.length > 0);
}

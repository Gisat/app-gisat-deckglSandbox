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
 * @returns {{distance: number, segmentIndex: number}} The projected distance from the start of the line in meters.
 */
function projectPointOntoLine(pointCoords, lineCoords) {
    let minDistanceSq = Infinity;
    let projectedDistance = 0;
    let closestSegmentIndex = 0;
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
            closestSegmentIndex = i;
        }

        accumulatedLength += haversine(start, end) * 1000;
    }

    return { distance: projectedDistance, segmentIndex: closestSegmentIndex };
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
        const { distance } = projectPointOntoLine(pointCoords, lineCoords);
        
        // Extract all requested metrics
        metricFields.forEach(field => {
            if (!metricsData[field]) {
                metricsData[field] = [];
            }
            
            const value = feature.properties[field] || 0;
            metricsData[field].push({
                x: distance,
                y: value,
                point_id: feature.properties.point_id ?? feature.id,
            });
        });
    });

    // Sort each metric's data by distance and convert to Nivo format
    return Object.entries(metricsData).map(([fieldName, data]) => ({
        id: fieldName,
        data: data.sort((a, b) => a.x - b.x)
    }));
}

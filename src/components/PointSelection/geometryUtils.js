import buffer from '@turf/buffer';
import circle from '@turf/circle';

/**
 * Normalize drawn geometry to a GeoJSON Polygon
 * - Polygon: close if open
 * - Circle: convert center+radius to polygon ring
 * - Line: convert to buffer corridor (requires bufferMeters param)
 */
export function normalizeGeometry(mode, coords, bufferMeters = 100) {
    if (mode === 'polygon') {
        // Close polygon if not already closed
        if (coords.length > 0) {
            const first = coords[0];
            const last = coords[coords.length - 1];
            const isClosed = first[0] === last[0] && first[1] === last[1];
            return {
                type: 'Polygon',
                coordinates: [isClosed ? coords : [...coords, [...first]]]
            };
        }
        return null;
    }

    if (mode === 'circle') {
        // coords[0] = center [lon, lat], coords[1] = edge point [lon, lat]
        if (coords.length < 2) return null;
        const center = coords[0];
        const edge = coords[1];
        
        // Calculate radius in kilometers
        const radiusKm = haversine(center, edge);
        
        // Use turf.circle to generate polygon
        const circlePolygon = circle(center, radiusKm, { units: 'kilometers' });
        return circlePolygon.geometry;
    }

    if (mode === 'line') {
        // coords = [lon, lat], [lon, lat], ...
        if (coords.length < 2) return null;
        
        // Create a LineString
        const lineString = {
            type: 'LineString',
            coordinates: coords
        };
        
        // Buffer the line to create a corridor polygon
        // bufferMeters should be in meters, turf expects km
        const bufferKm = bufferMeters / 1000;
        const buffered = buffer(lineString, bufferKm, { units: 'kilometers' });
        return buffered.geometry;
    }

    return null;
}

/**
 * Calculate distance between two points using Haversine formula (in km)
 */
function haversine(point1, point2) {
    const [lon1, lat1] = point1;
    const [lon2, lat2] = point2;
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
            Math.cos((lat2 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Check if a point [lon, lat] is inside a polygon
 * Uses ray casting algorithm
 */
export function pointInPolygon(point, polygon) {
    if (polygon.type !== 'Polygon' || !polygon.coordinates || polygon.coordinates.length === 0) {
        return false;
    }

    const [lon, lat] = point;
    const ring = polygon.coordinates[0]; // Outer ring
    let inside = false;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [lon1, lat1] = ring[i];
        const [lon2, lat2] = ring[j];

        // Ray casting: check if horizontal ray from point intersects edge
        if (
            ((lat1 > lat) !== (lat2 > lat)) &&  // Point is between edge's latitude range
            (lon < (lon2 - lon1) * (lat - lat1) / (lat2 - lat1) + lon1)  // Point is left of edge intersection
        ) {
            inside = !inside;
        }
    }

    return inside;
}

/**
 * Filter visible Arrow table rows by polygon geometry AND viewport bounds
 * Returns an array of point IDs that are selected
 */
export function filterPointsByGeometryInBounds(tableData, geometry, bounds) {
    const selectedIds = [];
    const [minLon, minLat, maxLon, maxLat] = bounds;

    for (let i = 0; i < tableData.numRows; i++) {
        try {
            const pos = tableData.getPosition(i);
            const { lon, lat } = pos;
            
            // First check: is point within viewport bounds?
            if (lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat) {
                // Second check: is point within drawn geometry?
                if (pointInPolygon([lon, lat], geometry)) {
                    const pointId = tableData.getPointId(i);
                    if (pointId !== null && pointId !== undefined && pointId !== '') {
                        selectedIds.push(pointId);
                    }
                }
            }
        } catch (e) {
            console.error(`Error processing row ${i}:`, e);
            break;
        }
    }
    
    return selectedIds;
}


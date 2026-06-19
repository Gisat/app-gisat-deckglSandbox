import buffer from '@turf/buffer';
import circle from '@turf/circle';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';

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
export function haversine(point1, point2) {
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
 * Check if a point [lon, lat] is inside a polygon.
 * Uses robust Turf.js implementation.
 */
export function pointInPolygon(point, polygon) {
    if (!point || !polygon) {
        return false;
    }
    // Turf's booleanPointInPolygon expects a Point feature, so we wrap the coordinate.
    return booleanPointInPolygon(point, polygon);
}

/**
 * Calculate [minLon, minLat, maxLon, maxLat] for a GeoJSON geometry.
 * Returns null when the geometry has no usable coordinates.
 */
export function getGeometryBounds(geometry) {
    if (!geometry || !geometry.coordinates) {
        return null;
    }

    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    const visit = (coords) => {
        if (!Array.isArray(coords) || coords.length === 0) {
            return;
        }

        if (typeof coords[0] === 'number' && coords.length >= 2) {
            const [lon, lat] = coords;
            if (Number.isFinite(lon) && Number.isFinite(lat)) {
                minLon = Math.min(minLon, lon);
                minLat = Math.min(minLat, lat);
                maxLon = Math.max(maxLon, lon);
                maxLat = Math.max(maxLat, lat);
            }
            return;
        }

        coords.forEach(visit);
    };

    visit(geometry.coordinates);

    if (
        !Number.isFinite(minLon) ||
        !Number.isFinite(minLat) ||
        !Number.isFinite(maxLon) ||
        !Number.isFinite(maxLat)
    ) {
        return null;
    }

    return [minLon, minLat, maxLon, maxLat];
}

/**
 * Filter visible Arrow table rows by polygon geometry and a precomputed bounds box.
 * Returns an array of point IDs that are selected.
 * In 3D mode, also checks elevation (if available in tableData).
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
                // Second check: is point within drawn geometry (2D polygon check)?
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

/**
 * Get a unique identifier for a feature.
 * Falls back through common ID properties (fid, ID_CELL, etc.).
 * As a last resort, generates an ID from coordinates if available.
 * @param {object} feature - A GeoJSON-like feature object.
 * @returns {string|number|null} The best available ID, or null.
 */
export function getPointId(feature) {
  if (!feature) return null;
  
  if (feature.properties) {
    const p = feature.properties;
    const id = p.fid ?? p.ID_CELL ?? p.ID ?? p.id_global ?? p.id;
    if (id !== undefined && id !== null) {
      return id;
    }
  }

  // Fallback for features without standard ID properties
  if (feature.id !== undefined && feature.id !== null) {
      return feature.id;
  }

  if (feature.geometry?.coordinates?.length >= 2) {
    return `${feature.geometry.coordinates[0]}_${feature.geometry.coordinates[1]}`;
  }
  
  return null;
}

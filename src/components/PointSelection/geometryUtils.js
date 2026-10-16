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

// Metres in one degree of latitude (used to keep the corridor width physical).
const METERS_PER_DEG_LAT = 111320;

/**
 * Build a flat-ended (butt-cap) corridor polygon around a drawn line.
 *
 * Unlike `@turf/buffer`, which rounds the caps, this matches the line-selection
 * semantics (`sampleLineSelection`): the corridor stops squarely at the first and
 * last vertex, so points beyond either end never fall inside it. Each vertex is
 * offset by `bufferMeters` along a metric-space normal (longitude degrees are
 * scaled by the local latitude so the width stays physically constant).
 *
 * @param {number[][]} lineCoords - [lon, lat] vertices of the drawn line.
 * @param {number} bufferMeters - Half-width of the corridor in metres.
 * @returns {object|null} A GeoJSON Polygon geometry, or null when degenerate.
 */
export function buildLineCorridor(lineCoords, bufferMeters = 100) {
    if (!Array.isArray(lineCoords) || lineCoords.length < 2) return null;

    // Drop consecutive duplicate vertices so the normals stay well-defined.
    const pts = [];
    for (const c of lineCoords) {
        if (!Array.isArray(c) || c.length < 2) continue;
        const last = pts[pts.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) pts.push([c[0], c[1]]);
    }
    if (pts.length < 2) return null;

    // Unit tangent (in metric space, at the given latitude) from a -> b.
    const metricUnit = (a, b, lat) => {
        const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
        const dx = (b[0] - a[0]) * mPerDegLon;
        const dy = (b[1] - a[1]) * METERS_PER_DEG_LAT;
        const len = Math.hypot(dx, dy);
        return len === 0 ? null : [dx / len, dy / len];
    };

    const left = [];
    const right = [];
    for (let i = 0; i < pts.length; i++) {
        const lat = pts[i][1];
        // Average the adjacent segment tangents so interior joins stay centred.
        const tPrev = i > 0 ? metricUnit(pts[i - 1], pts[i], lat) : null;
        const tNext = i < pts.length - 1 ? metricUnit(pts[i], pts[i + 1], lat) : null;

        let tx = 0;
        let ty = 0;
        for (const t of [tPrev, tNext]) {
            if (t) {
                tx += t[0];
                ty += t[1];
            }
        }
        const tLen = Math.hypot(tx, ty);
        if (tLen === 0) {
            // 180° turn back on itself: fall back to a neighbouring tangent.
            const fallback = tPrev || tNext;
            if (!fallback) return null;
            [tx, ty] = fallback;
        } else {
            tx /= tLen;
            ty /= tLen;
        }

        // Left normal (tangent rotated +90°) scaled from metres back to degrees.
        const mPerDegLon = METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
        const dLon = (-ty * bufferMeters) / mPerDegLon;
        const dLat = (tx * bufferMeters) / METERS_PER_DEG_LAT;

        left.push([pts[i][0] + dLon, pts[i][1] + dLat]);
        right.push([pts[i][0] - dLon, pts[i][1] - dLat]);
    }

    // Flat ends: the left side runs forward, the right side runs back, joined
    // squarely across the first and last vertices.
    const ring = [...left, ...right.reverse()];
    ring.push([ring[0][0], ring[0][1]]);

    return { type: 'Polygon', coordinates: [ring] };
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

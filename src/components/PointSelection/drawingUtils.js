import { WebMercatorViewport } from '@deck.gl/core';
import { extractTerrainCoordinate } from '@gisatcz/deckgl-geolib';

/**
 * Global reference to DeckGL instance - set by Map3D component
 * Used to pick objects from the rendered scene to find actual 3D coordinates
 */
let deckGLInstance = null;

/**
 * Set the DeckGL reference (called by Map3D component)
 */
export function setDeckGLInstance(deckGL) {
    deckGLInstance = deckGL;
}

/**
 * Convert screen coordinates to geographic coordinates.
 * When terrain is visible (pitch > 0) and deckGL instance available, uses 3D terrain picking.
 * Otherwise uses viewport unprojection.
 * 
 * @param {Object} viewState - Deck.GL view state
 * @param {number} x - Screen X coordinate (click position)
 * @param {number} y - Screen Y coordinate (click position)
 * @param {number} canvasWidth - Canvas width
 * @param {number} canvasHeight - Canvas height
 * @returns {Object} { geo: [lon, lat], screenPos: [x, y], elevation } 
 */
export function screenToGeo(viewState, x, y, canvasWidth, canvasHeight) {
    const viewport = new WebMercatorViewport({
        ...viewState,
        width: canvasWidth,
        height: canvasHeight
    });
    
    // For flat views, use simple viewport unprojection
    if (viewState.pitch <= 0) {
        const coord = viewport.unproject([x, y], { targetZ: 0 });
        return { geo: coord, screenPos: [x, y], elevation: null };
    }
    
    // For 3D terrain views, try to pick the terrain layer using 3D ray-casting
    if (!deckGLInstance) {
        const fallback = viewport.unproject([x, y], { targetZ: 0 });
        return { geo: fallback, screenPos: [x, y], elevation: null };
    }
    
    try {
        // Try terrain layer picking with explicit layer ID first
        let pick = deckGLInstance.pickObject({
            x,
            y,
            layerIds: ['terrain-layer']
        });
        
        // If that didn't work, try all layers
        if (!pick?.coordinate) {
            pick = deckGLInstance.pickObject({
                x,
                y,
                radius: 1
            });
        }
        
        if (pick?.coordinate) {
            // Use extractTerrainCoordinate to parse the result
            const terrainCoord = extractTerrainCoordinate(pick);
            
            if (terrainCoord) {
                return {
                    geo: [terrainCoord.longitude, terrainCoord.latitude],
                    screenPos: [x, y],
                    elevation: terrainCoord.elevation
                };
            }
            
            // If extractTerrainCoordinate failed, try direct access as fallback
            if (Array.isArray(pick.coordinate) && pick.coordinate.length >= 3) {
                return {
                    geo: [pick.coordinate[0], pick.coordinate[1]],
                    screenPos: [x, y],
                    elevation: pick.coordinate[2]
                };
            }
        }
        
    } catch (err) {
        // Silently fall back on error
    }
    
    // Fallback: Use viewport unprojection at z=0
    const fallbackCoord = viewport.unproject([x, y], { targetZ: 0 });
    return { geo: fallbackCoord, screenPos: [x, y], elevation: null };
}

/**
 * Convert geographic coordinates to screen coordinates
 * @param {Object} viewState - Deck.GL view state
 * @param {[number, number]} coord - [lon, lat]
 * @param {number} canvasWidth - Canvas width
 * @param {number} canvasHeight - Canvas height
 * @returns {[number, number]} [x, y] screen coordinates
 */
export function geoToScreen(viewState, [lon, lat], canvasWidth, canvasHeight) {
    const viewport = new WebMercatorViewport({
        ...viewState,
        width: canvasWidth,
        height: canvasHeight
    });
    return viewport.project([lon, lat]);
}

/**
 * Redraw canvas with current drawing state
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Array} coords - Array of [lon, lat] coordinates
 * @param {string} mode - Drawing mode: 'polygon', 'circle', or 'line'
 * @param {Object} viewState - Deck.GL view state
 * @param {number|null} cursorX - Optional cursor X for preview
 * @param {number|null} cursorY - Optional cursor Y for preview
 */
export function redrawCanvas(canvas, coords, mode, viewState, cursorX = null, cursorY = null) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (coords.length === 0) return;

    ctx.strokeStyle = '#0066cc';
    ctx.lineWidth = 2;
    ctx.fillStyle = 'rgba(0, 102, 204, 0.1)';

    // Convert all coordinates to screen positions
    // For 3D views with terrain, we must use the stored screen positions, not reproject
    const screenCoords = coords.map(c => {
        // If this is a stored coordinate object with screenPos, use it
        if (c.screenPos !== undefined) {
            return c.screenPos;
        }
        // Otherwise convert using standard geo-to-screen (works for flat views)
        return geoToScreen(viewState, c, canvas.width, canvas.height);
    });

    if (mode === 'circle' && coords.length >= 1) {
        const [cx, cy] = screenCoords[0];
        if (coords.length === 1 && cursorX !== null && cursorY !== null) {
            // Draw preview circle
            const radius = Math.sqrt(
                Math.pow(cursorX - cx, 2) + Math.pow(cursorY - cy, 2)
            );
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        } else if (coords.length === 2) {
            const [ex, ey] = screenCoords[1];
            const radius = Math.sqrt(Math.pow(ex - cx, 2) + Math.pow(ey - cy, 2));
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    } else {
        // Polygon or Line: draw path
        ctx.beginPath();
        ctx.moveTo(screenCoords[0][0], screenCoords[0][1]);
        for (let i = 1; i < screenCoords.length; i++) {
            ctx.lineTo(screenCoords[i][0], screenCoords[i][1]);
        }
        if (cursorX !== null && cursorY !== null && mode !== 'circle') {
            ctx.lineTo(cursorX, cursorY);
        }
        if (mode === 'polygon' && coords.length >= 2) {
            ctx.lineTo(screenCoords[0][0], screenCoords[0][1]);
        }
        ctx.fill();
        ctx.stroke();

        // Draw vertices as circles
        ctx.fillStyle = '#0066cc';
        for (const [x, y] of screenCoords) {
            ctx.beginPath();
            ctx.arc(x, y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }
}

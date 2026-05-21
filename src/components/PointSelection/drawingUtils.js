import { WebMercatorViewport } from '@deck.gl/core';

/**
 * Convert screen coordinates to geographic coordinates
 * @param {Object} viewState - Deck.GL view state
 * @param {number} x - Screen X coordinate
 * @param {number} y - Screen Y coordinate
 * @param {number} canvasWidth - Canvas width
 * @param {number} canvasHeight - Canvas height
 * @returns {[number, number]} [lon, lat]
 */
export function screenToGeo(viewState, x, y, canvasWidth, canvasHeight) {
    const viewport = new WebMercatorViewport({
        ...viewState,
        width: canvasWidth,
        height: canvasHeight
    });
    return viewport.unproject([x, y]);
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

    const screenCoords = coords.map(c => geoToScreen(viewState, c, canvas.width, canvas.height));

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

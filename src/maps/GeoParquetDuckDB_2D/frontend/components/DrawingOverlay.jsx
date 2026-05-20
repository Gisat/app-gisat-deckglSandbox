import React, { useRef, useEffect } from 'react';
import { WebMercatorViewport } from '@deck.gl/core';

export function DrawingOverlay({
    viewState,
    selectionMode,
    isDrawing,
    onGeometryComplete,
    bufferDistance
}) {
    const canvasRef = useRef(null);
    const drawingStateRef = useRef({ coords: [], isActive: false });

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Set canvas size to match container
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        if (!isDrawing) {
            // Clear canvas when not drawing
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawingStateRef.current = { coords: [], isActive: false };
            return;
        }

        const handleMouseMove = e => {
            if (!drawingStateRef.current.isActive) return;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            redrawCanvas(canvas, x, y);
        };

        const handleClick = e => {
            if (!drawingStateRef.current.isActive) return;

            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const coord = screenToGeo(viewState, x, y, canvas.width, canvas.height);
            const state = drawingStateRef.current;

            if (selectionMode === 'circle') {
                // Circle: first click = center, second click = edge
                if (state.coords.length < 2) {
                    state.coords.push(coord);
                    if (state.coords.length === 2) {
                        // Complete circle
                        onGeometryComplete('circle', state.coords);
                        state.coords = [];
                        state.isActive = false;
                    }
                }
            } else if (selectionMode === 'polygon') {
                // Polygon: accumulate clicks, double-click to close
                state.coords.push(coord);
                redrawCanvas(canvas);
            } else if (selectionMode === 'line') {
                // Line: accumulate clicks, double-click to complete
                state.coords.push(coord);
                redrawCanvas(canvas);
            }
        };

        const handleDoubleClick = e => {
            if (!drawingStateRef.current.isActive || drawingStateRef.current.coords.length < 2) return;

            const state = drawingStateRef.current;
            onGeometryComplete(selectionMode, state.coords, bufferDistance);
            state.coords = [];
            state.isActive = false;
            redrawCanvas(canvas);
        };

        // Only activate drawing on first interaction
        if (!drawingStateRef.current.isActive) {
            drawingStateRef.current.isActive = true;
        }

        canvas.addEventListener('mousemove', handleMouseMove);
        canvas.addEventListener('click', handleClick);
        canvas.addEventListener('dblclick', handleDoubleClick);

        return () => {
            canvas.removeEventListener('mousemove', handleMouseMove);
            canvas.removeEventListener('click', handleClick);
            canvas.removeEventListener('dblclick', handleDoubleClick);
        };
    }, [isDrawing, selectionMode, viewState, bufferDistance, onGeometryComplete]);

    const redrawCanvas = (canvas, cursorX = null, cursorY = null) => {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const state = drawingStateRef.current;
        const coords = state.coords;

        // Draw existing vertices and lines
        ctx.strokeStyle = '#0066cc';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(0, 102, 204, 0.1)';

        if (coords.length > 0) {
            const screenCoords = coords.map(c => geoToScreen(viewState, c, canvas.width, canvas.height));

            if (selectionMode === 'circle' && coords.length >= 1) {
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
                if (cursorX !== null && cursorY !== null && selectionMode !== 'circle') {
                    ctx.lineTo(cursorX, cursorY);
                }
                if (selectionMode === 'polygon' && coords.length >= 2) {
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
    };

    const geoToScreen = (viewState, [lon, lat], canvasWidth, canvasHeight) => {
        const viewport = new WebMercatorViewport({
            ...viewState,
            width: canvasWidth,
            height: canvasHeight
        });
        return viewport.project([lon, lat]);
    };

    const screenToGeo = (viewState, x, y, canvasWidth, canvasHeight) => {
        const viewport = new WebMercatorViewport({
            ...viewState,
            width: canvasWidth,
            height: canvasHeight
        });
        return viewport.unproject([x, y]);
    };

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                cursor: isDrawing ? 'crosshair' : 'default',
                pointerEvents: isDrawing ? 'auto' : 'none'
            }}
        />
    );
}

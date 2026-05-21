import React, { useRef, useEffect } from 'react';
import { screenToGeo, geoToScreen, redrawCanvas } from './drawingUtils';

/**
 * DrawingOverlay - Reusable component for drawing selection geometries on canvas
 * Supports polygon, circle, and line modes
 * 
 * @param {Object} props
 * @param {Object} props.viewState - Deck.GL view state
 * @param {string} props.selectionMode - 'polygon', 'circle', or 'line'
 * @param {boolean} props.isDrawing - Whether drawing is active
 * @param {Function} props.onGeometryComplete - Called with (mode, coords, bufferDistance?)
 * @param {number} props.bufferDistance - Buffer distance for line mode
 */
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

            const state = drawingStateRef.current;
            redrawCanvas(canvas, state.coords, selectionMode, viewState, x, y);
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
                redrawCanvas(canvas, state.coords, selectionMode, viewState);
            } else if (selectionMode === 'line') {
                // Line: accumulate clicks, double-click to complete
                state.coords.push(coord);
                redrawCanvas(canvas, state.coords, selectionMode, viewState);
            }
        };

        const handleDoubleClick = e => {
            if (!drawingStateRef.current.isActive || drawingStateRef.current.coords.length < 2) return;

            const state = drawingStateRef.current;
            onGeometryComplete(selectionMode, state.coords, bufferDistance);
            state.coords = [];
            state.isActive = false;
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
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

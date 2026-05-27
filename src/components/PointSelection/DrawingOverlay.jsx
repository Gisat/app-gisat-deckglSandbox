import { useRef, useEffect, useState } from 'react';
import { screenToGeo, redrawCanvas } from './drawingUtils';

/**
 * DrawingOverlay - Canvas overlay for drawing selection geometries
 * Works identically for both 2D and 3D modes
 */
export function DrawingOverlay({
    viewState,
    selectionMode,
    isDrawing,
    onGeometryComplete,
    bufferDistance,
    is3D = false
}) {
    const canvasRef = useRef(null);
    const lastCursorRef = useRef({ x: null, y: null });
    const [localCoords, setLocalCoords] = useState([]);

    // Refs to hold latest values so event handlers don't need to be reattached on every render
    const localCoordsRef = useRef([]);
    const onGeometryCompleteRef = useRef(onGeometryComplete);
    const selectionModeRef = useRef(selectionMode);
    const bufferDistanceRef = useRef(bufferDistance);
    const is3DRef = useRef(is3D);

    // Keep refs in sync with props/state
    useEffect(() => { onGeometryCompleteRef.current = onGeometryComplete; }, [onGeometryComplete]);
    useEffect(() => { selectionModeRef.current = selectionMode; }, [selectionMode]);
    useEffect(() => { bufferDistanceRef.current = bufferDistance; }, [bufferDistance]);
    useEffect(() => { is3DRef.current = is3D; }, [is3D]);

    // Keep localCoordsRef in sync whenever state changes
    useEffect(() => { localCoordsRef.current = localCoords; }, [localCoords]);

    // Helper: add a coordinate and handle circle auto-complete
    const addCoord = (coord) => {
        setLocalCoords(prev => {
            const newCoords = [...prev, coord];
            localCoordsRef.current = newCoords;

            if (selectionModeRef.current === 'circle' && newCoords.length === 2) {
                const geoCoords = newCoords.map(c => c.geo || c);
                // Defer parent updates to avoid render-phase setState warnings
                Promise.resolve().then(() => onGeometryCompleteRef.current?.('circle', geoCoords, bufferDistanceRef.current));
                localCoordsRef.current = [];
                return [];
            }

            return newCoords;
        });
    };

    // Helper function to finalize drawing (deferred)
    const finalizeDraw = (coords) => {
        if (!coords || coords.length < 2) return;
        // Defer to avoid updating parent during render
        Promise.resolve().then(() => onGeometryCompleteRef.current?.(selectionModeRef.current, coords, bufferDistanceRef.current));
        setLocalCoords([]);
        localCoordsRef.current = [];
    };

    // Redraw whenever drawing state or coordinates change
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        if (!isDrawing || !localCoords.length) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        redrawCanvas(canvas, localCoords, selectionMode, viewState, lastCursorRef.current.x, lastCursorRef.current.y);
    }, [isDrawing, localCoords, selectionMode, viewState]);

    // Interaction handlers: attach only when drawing starts/stops to avoid frequent reattachment
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !isDrawing) return;

        const handleMouseMove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            lastCursorRef.current = { x, y };
            if (localCoordsRef.current.length > 0) {
                redrawCanvas(canvas, localCoordsRef.current, selectionModeRef.current, viewState, x, y);
            }
        };

        const handleClick = (e) => {
            e.stopPropagation();
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const coord = screenToGeo(viewState, x, y, canvas.width, canvas.height);

            if (is3DRef.current) {
                addCoord(coord);
            } else {
                // 2D: coord.geo is [lon, lat]
                addCoord(coord.geo);
            }
        };

        const handleDoubleClick = (e) => {
            e.stopPropagation();
            if (localCoordsRef.current.length >= 2) {
                finalizeDraw(localCoordsRef.current);
            }
        };

        if (!is3DRef.current) {
            canvas.addEventListener('mousemove', handleMouseMove);
            canvas.addEventListener('click', handleClick);
            canvas.addEventListener('dblclick', handleDoubleClick);
        } else {
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('dblclick', handleDoubleClick);
        }

        return () => {
            if (!is3DRef.current) {
                canvas.removeEventListener('mousemove', handleMouseMove);
                canvas.removeEventListener('click', handleClick);
                canvas.removeEventListener('dblclick', handleDoubleClick);
            } else {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('dblclick', handleDoubleClick);
            }
        };
    }, [isDrawing, viewState]);

    // Clear local coords when drawing stops
    useEffect(() => {
        if (!isDrawing) {
            setLocalCoords([]);
            localCoordsRef.current = [];
        }
    }, [isDrawing]);

    // Listen for finalize event (from finish button)
    useEffect(() => {
        if (!isDrawing) return;
        const handleFinalize = () => finalizeDraw(localCoordsRef.current);
        window.addEventListener('finalizeDrawing', handleFinalize);
        return () => window.removeEventListener('finalizeDrawing', handleFinalize);
    }, [isDrawing]);

    // In 3D mode: listen for DeckGL onClick coordinates from Map3D
    useEffect(() => {
        if (!is3D || !isDrawing) return;

        const handleMap3DClick = (event) => {
            const { geo, screenPos, elevation } = event.detail || {};
            addCoord({ geo, screenPos, elevation });
        };

        window.addEventListener('map3dDrawingClick', handleMap3DClick);
        return () => window.removeEventListener('map3dDrawingClick', handleMap3DClick);
    }, [is3D, isDrawing]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                cursor: (isDrawing && !is3D) ? 'crosshair' : 'inherit',
                pointerEvents: (isDrawing && !is3D) ? 'auto' : 'none'
            }}
        />
    );
}

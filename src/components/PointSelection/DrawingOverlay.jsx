import { useRef, useEffect, useState } from 'react';
import { screenToGeo, redrawCanvas } from './drawingUtils';

/**
 * DrawingOverlay - Canvas overlay for drawing selection geometries
 * Works identically for both 2D and 3D modes
 * 
 * @param {Object} props
 * @param {Object} props.viewState - Deck.GL view state
 * @param {string} props.selectionMode - 'polygon', 'circle', or 'line'
 * @param {boolean} props.isDrawing - Whether drawing is active
 * @param {Function} props.onGeometryComplete - Called with (mode, coords, bufferDist) when drawing completes
 * @param {number} props.bufferDistance - Buffer distance for line mode
 * @param {boolean} props.is3D - Whether we're in 3D mode (uses terrain picking instead of flat projection)
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
    const [localCoords, setLocalCoords] = useState([]); // For 2D mode: local coordinate state
    const lastClickTimeRef = useRef(0);  // For tracking double-click in 3D

    // In both 2D and 3D, use localCoords for drawing
    // The difference is only in what data format we store (coordinates only vs with elevation)
    const displayCoords = localCoords;

    // Helper function to finalize drawing
    const finalizeDraw = (coords) => {
        if (coords.length >= 2) {
            onGeometryComplete?.(selectionMode, coords, bufferDistance);
            setLocalCoords([]);
        }
    };

    // Redraw whenever drawing state changes
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Set canvas size to match container
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        if (!isDrawing || !displayCoords.length) {
            // Clear canvas when not drawing or no coords
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }

        // Redraw with current coordinates and cursor preview
        redrawCanvas(canvas, displayCoords, selectionMode, viewState, lastCursorRef.current.x, lastCursorRef.current.y);
    }, [isDrawing, displayCoords, selectionMode, viewState]);

    // Handle interactions
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !isDrawing) {
            return;
        }

        const handleMouseMove = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            
            lastCursorRef.current = { x, y };
            
            // Trigger redraw with cursor preview
            if (displayCoords.length > 0) {
                redrawCanvas(canvas, displayCoords, selectionMode, viewState, x, y);
            }
        };

        const handleClick = (e) => {
            // Stop DeckGL from processing this click
            e.stopPropagation();
            
            // Both 2D and 3D use canvas click handling
            // The difference: screenToGeo intelligently uses terrain picking in 3D
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const coord = screenToGeo(viewState, x, y, canvas.width, canvas.height);

            if (is3D) {
                // 3D mode: accumulate {geo, screenPos, elevation} objects
                setLocalCoords(prev => {
                    const newCoords = [...prev, coord];

                    if (selectionMode === 'circle' && newCoords.length === 2) {
                        // Circle complete after 2 clicks
                        // Extract just geo for normalizeGeometry
                        const geoCoords = newCoords.map(c => c.geo);
                        onGeometryComplete?.('circle', geoCoords, bufferDistance);
                        return [];
                    }
                    
                    return newCoords;
                });
            } else {
                // 2D mode: accumulate plain [lon, lat] arrays
                setLocalCoords(prev => {
                    const newCoords = [...prev, coord.geo];

                    if (selectionMode === 'circle' && newCoords.length === 2) {
                        // Circle complete after 2 clicks
                        onGeometryComplete?.('circle', newCoords, bufferDistance);
                        return [];
                    }
                    
                    return newCoords;
                });
            }
        };

        const handleDoubleClick = (e) => {
            // Prevent DeckGL zoom
            e.stopPropagation();
            
            // Both 2D and 3D: double-click to finish drawing
            if (displayCoords.length >= 2) {
                onGeometryComplete?.(selectionMode, displayCoords, bufferDistance);
                setLocalCoords([]);
            }
        };

        // In 2D: attach to canvas
        // In 3D: attach to document since canvas has pointerEvents:none
        if (!is3D) {
            canvas.addEventListener('mousemove', handleMouseMove);
            canvas.addEventListener('click', handleClick);
            canvas.addEventListener('dblclick', handleDoubleClick);
        } else {
            // In 3D: listen to document for mousemove and double-click
            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('dblclick', handleDoubleClick);
        }

        return () => {
            if (!is3D) {
                canvas.removeEventListener('mousemove', handleMouseMove);
                canvas.removeEventListener('click', handleClick);
                canvas.removeEventListener('dblclick', handleDoubleClick);
            } else {
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('dblclick', handleDoubleClick);
            }
        };
    }, [isDrawing, displayCoords, selectionMode, viewState, onGeometryComplete, bufferDistance, is3D]);

    // Clear local coords when drawing stops
    useEffect(() => {
        if (!isDrawing) {
            setLocalCoords([]);
        }
    }, [isDrawing]);

    // Listen for finalize event (from finish button)
    useEffect(() => {
        if (!isDrawing) return;

        const handleFinalize = () => {
            finalizeDraw(localCoords);
        };

        window.addEventListener('finalizeDrawing', handleFinalize);
        return () => window.removeEventListener('finalizeDrawing', handleFinalize);
    }, [isDrawing, localCoords]);

    // In 3D mode: listen for DeckGL onClick coordinates from Map3D
    useEffect(() => {
        if (!is3D || !isDrawing) {
            return;
        }

        const handleMap3DClick = (event) => {
            const { geo, screenPos, elevation } = event.detail;
            
            setLocalCoords(prev => {
                const coord = { geo, screenPos, elevation };
                const newCoords = [...prev, coord];

                if (selectionMode === 'circle' && newCoords.length === 2) {
                    // Circle complete after 2 clicks
                    const geoCoords = newCoords.map(c => c.geo);
                    onGeometryComplete?.(selectionMode, geoCoords, bufferDistance);
                    return [];
                }
                
                return newCoords;
            });
        };

        window.addEventListener('map3dDrawingClick', handleMap3DClick);
        
        return () => {
            window.removeEventListener('map3dDrawingClick', handleMap3DClick);
        };
    }, [is3D, isDrawing, selectionMode, bufferDistance, onGeometryComplete]);

    return (
        <canvas
            ref={canvasRef}
            style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: '100%',
                // In 2D: canvas captures clicks, show cursor
                // In 3D: canvas has pointerEvents:none, inherit cursor from parent
                cursor: (isDrawing && !is3D) ? 'crosshair' : 'inherit',
                // In 2D: canvas needs to capture clicks
                // In 3D: canvas must have pointerEvents:none so clicks reach DeckGL onClick handler
                pointerEvents: (isDrawing && !is3D) ? 'auto' : 'none'
            }}
        />
    );
}

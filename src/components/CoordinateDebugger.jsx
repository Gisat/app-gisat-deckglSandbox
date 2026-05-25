import React, { useState } from 'react';

/**
 * Debug overlay component to display raw terrain coordinates while hovering
 * Helps diagnose coordinate shift issues
 */
export function CoordinateDebugger() {
    const [hoveredCoords, setHoveredCoords] = useState(null);
    const [clickedCoords, setClickedCoords] = useState(null);

    // Listen for debug log events (we'll emit these from Map3D)
    React.useEffect(() => {
        const handleCoordinateUpdate = (e) => {
            if (e.detail?.type === 'hover') {
                setHoveredCoords(e.detail);
            } else if (e.detail?.type === 'click') {
                setClickedCoords(e.detail);
            }
        };

        window.addEventListener('coordinateDebug', handleCoordinateUpdate);
        return () => window.removeEventListener('coordinateDebug', handleCoordinateUpdate);
    }, []);

    return (
        <div
            style={{
                position: 'absolute',
                bottom: 20,
                left: 20,
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
                color: '#0f0',
                fontFamily: 'monospace',
                fontSize: '12px',
                padding: '10px',
                borderRadius: '4px',
                maxWidth: '300px',
                zIndex: 100
            }}
        >
            <div style={{ marginBottom: '10px', fontWeight: 'bold' }}>🎯 Coordinate Debugger</div>

            {hoveredCoords && (
                <div style={{ marginBottom: '10px' }}>
                    <div style={{ color: '#aaf' }}>HOVERED:</div>
                    <div>Lat: {hoveredCoords.latitude?.toFixed(6) || 'N/A'}</div>
                    <div>Lon: {hoveredCoords.longitude?.toFixed(6) || 'N/A'}</div>
                    <div>Elev: {hoveredCoords.elevation?.toFixed(2) || 'N/A'}m</div>
                    {hoveredCoords.screen && (
                        <>
                            <div>Screen: ({hoveredCoords.screen[0]}, {hoveredCoords.screen[1]})</div>
                        </>
                    )}
                </div>
            )}

            {clickedCoords && (
                <div>
                    <div style={{ color: '#afa' }}>CLICKED:</div>
                    <div>Lat: {clickedCoords.latitude?.toFixed(6) || 'N/A'}</div>
                    <div>Lon: {clickedCoords.longitude?.toFixed(6) || 'N/A'}</div>
                    <div>Elev: {clickedCoords.elevation?.toFixed(2) || 'N/A'}m</div>
                    {clickedCoords.screen && (
                        <>
                            <div>Screen: ({clickedCoords.screen[0]}, {clickedCoords.screen[1]})</div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

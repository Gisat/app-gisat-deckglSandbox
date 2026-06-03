import React from 'react';

export const HUD = ({ viewState, currentTierDisplay, totalPoints, fetchStatus, isLoading, cacheSize, cacheLimit }) => {
    return (
        <div style={{
            position: 'absolute', top: 10, left: 10,
            backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '10px 15px',
            borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            fontFamily: 'monospace', fontSize: '12px', zIndex: 10,
            pointerEvents: 'none' // Click through
        }}>
            <div><b>Zoom:</b> {viewState.zoom?.toFixed(2)}</div>
            <div><b>Tier:</b> {currentTierDisplay}</div>
            <div><b>Points:</b> {totalPoints.toLocaleString()}</div>
            <div><b>Status:</b> {isLoading ? '⚡ ' : '✅ '}{fetchStatus}</div>
            <div><b>Cache Size:</b> {cacheSize} / {cacheLimit}</div>
        </div>
    );
};

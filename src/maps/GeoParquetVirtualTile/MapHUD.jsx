import React from 'react';
import './VirtualTilesMap.css';

export default function MapHUD({
    zoom,
    fullVectorsLoaded,
    targetTier,
    tileBuffer,
    dataStatus,
    loadedTier,
    loadingStage,
    visiblePointCount
}) {
    return (
        <div className="vtm-hud">
            <div>Zoom Level: <span className="text-blue">{zoom.toFixed(1)}</span></div>

            <div className="vtm-hud-divider">
                <strong>Mode: </strong>
                <span style={{ color: fullVectorsLoaded ? '#4caf50' : '#ffb74d' }}>
                    {fullVectorsLoaded ? 'FULL VECTORS (Animation)' : 'STATIC (Lightweight)'}
                </span>
            </div>

            <div className="vtm-hud-row">
                <strong>Target Tier: {targetTier}</strong>
                <span className="text-orange"> (Buffer: {tileBuffer})</span>
            </div>

            <div className={`vtm-status-text ${dataStatus.includes('Cache') ? 'text-green' : (dataStatus.includes('Fetching') ? 'text-orange' : 'text-gray')}`} style={{ marginTop: '8px' }}>
                Status: <strong>{dataStatus}</strong>
            </div>

            <div style={{ color: loadedTier >= 0 ? '#81c784' : (loadingStage === 'tier0' ? '#ffb74d' : '#555') }}>
                • Tier 0 (5%) {loadingStage === 'tier0' && '⏳'} {loadedTier >= 0 && '✅'}
            </div>

            <div style={{
                color: targetTier >= 1 ? (loadedTier >= 1 ? '#81c784' : '#ffb74d') : '#555',
                opacity: targetTier >= 1 ? 1 : 0.5
            }}>
                • Tier 1 (+30%) {loadingStage === 'tier1' && '⏳'} {loadingStage === 'pause1' && '⏸'} {loadedTier >= 1 && '✅'}
            </div>

            <div style={{
                color: targetTier >= 2 ? (loadedTier >= 2 ? '#81c784' : '#ffb74d') : '#555',
                opacity: targetTier >= 2 ? 1 : 0.5
            }}>
                • Tier 2 (+65%) {loadingStage === 'tier2' && '⏳'} {loadingStage === 'pause2' && '⏸'} {loadedTier >= 2 && '✅'}
            </div>

            <div style={{ marginTop: '8px' }}>
                Points: <span className="text-white">{visiblePointCount}</span>
            </div>
        </div>
    );
}

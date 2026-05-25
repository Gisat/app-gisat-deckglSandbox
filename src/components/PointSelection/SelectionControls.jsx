import React from 'react';

/**
 * SelectionControls - Reusable UI controls for point selection
 * Handles mode selection, buffer distance, and action buttons
 * 
 * @param {Object} props
 * @param {string} props.selectionMode - Current mode: 'polygon', 'circle', 'line'
 * @param {Function} props.onModeChange - Called with new mode
 * @param {Function} props.onDraw - Called to start drawing
 * @param {Function} props.onFinish - Called to finish drawing
 * @param {Function} props.onClear - Called to clear selection
 * @param {boolean} props.isDrawing - Whether drawing is active
 * @param {number} props.selectedCount - Number of selected points
 * @param {number} props.backendFeatureCount - Number of features from backend
 * @param {boolean} props.isLoadingBackend - Whether backend query is in progress
 * @param {number} props.bufferDistance - Current buffer distance (for line mode)
 * @param {Function} props.onBufferChange - Called with new buffer distance
 */
export function SelectionControls({
    selectionMode,
    onModeChange,
    onDraw,
    onFinish,
    onClear,
    isDrawing,
    selectedCount,
    backendFeatureCount = 0,
    isLoadingBackend = false,
    bufferDistance = 100,
    onBufferChange
}) {
    const modes = ['polygon', 'circle', 'line'];

    return (
        <div
            style={{
                position: 'absolute',
                top: '130px',
                left: '10px',
                background: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                zIndex: 1000,
                fontFamily: 'system-ui, sans-serif',
                fontSize: '12px',
                minWidth: '220px'
            }}
        >
            <div style={{ marginBottom: '12px', fontWeight: 'bold' }}>Point Selection</div>

            {/* Mode Selector */}
            <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '11px', fontWeight: '500' }}>
                    Drawing Mode:
                </label>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {modes.map(mode => (
                        <button
                            key={mode}
                            onClick={() => onModeChange(mode)}
                            style={{
                                padding: '6px 10px',
                                border: selectionMode === mode ? '2px solid #0066cc' : '1px solid #ccc',
                                borderRadius: '4px',
                                background: selectionMode === mode ? '#e6f0ff' : '#fff',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: selectionMode === mode ? '600' : '400',
                                flex: '1',
                                minWidth: '60px'
                            }}
                        >
                            {mode.charAt(0).toUpperCase() + mode.slice(1)}
                        </button>
                    ))}
                </div>
            </div>

            {/* Line Buffer Distance (only for line mode) */}
            {selectionMode === 'line' && (
                <div style={{ marginBottom: '12px' }}>
                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: '500' }}>
                        Buffer Distance: {bufferDistance}m
                    </label>
                    <input
                        type="range"
                        min="10"
                        max="500"
                        step="10"
                        value={bufferDistance}
                        onChange={e => onBufferChange(Number(e.target.value))}
                        style={{ width: '100%', fontSize: '12px' }}
                    />
                </div>
            )}

            {/* Action Buttons */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                {isDrawing ? (
                    <button
                        onClick={onFinish}
                        style={{
                            flex: 1,
                            padding: '8px 12px',
                            background: '#28a745',
                            color: '#fff',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: '600'
                        }}
                    >
                        Finish
                    </button>
                ) : (
                    <button
                        onClick={onDraw}
                        style={{
                            flex: 1,
                            padding: '8px 12px',
                            background: '#f0f0f0',
                            color: '#000',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: '600'
                        }}
                    >
                        Draw
                    </button>
                )}
                <button
                    onClick={onClear}
                    style={{
                        flex: 1,
                        padding: '8px 12px',
                        background: '#f0f0f0',
                        border: '1px solid #ddd',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: '600'
                    }}
                >
                    Clear
                </button>
            </div>

            {/* Selected Count - Frontend */}
            {selectedCount > 0 && (
                <div
                    style={{
                        padding: '8px',
                        background: '#e6f0ff',
                        borderRadius: '4px',
                        textAlign: 'center',
                        fontSize: '11px',
                        color: '#0066cc',
                        fontWeight: '600',
                        marginBottom: '8px'
                    }}
                >
                    {selectedCount} tile point{selectedCount !== 1 ? 's' : ''} selected
                    {isLoadingBackend && ' • ⚡ Fetching...'}
                    {backendFeatureCount > 0 && !isLoadingBackend && ` • ✅ ${backendFeatureCount}`}
                </div>
            )}
        </div>
    );
}

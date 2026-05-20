import React from 'react';

export function SelectionControls({
    selectionMode,
    onModeChange,
    onDraw,
    onClear,
    isDrawing,
    selectedCount,
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
                <button
                    onClick={onDraw}
                    disabled={isDrawing}
                    style={{
                        flex: 1,
                        padding: '8px 12px',
                        background: isDrawing ? '#0066cc' : '#f0f0f0',
                        color: isDrawing ? '#fff' : '#000',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: isDrawing ? 'not-allowed' : 'pointer',
                        fontSize: '11px',
                        fontWeight: '600'
                    }}
                >
                    {isDrawing ? 'Drawing...' : 'Draw'}
                </button>
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

            {/* Selected Count */}
            {selectedCount > 0 && (
                <div
                    style={{
                        padding: '8px',
                        background: '#e6f0ff',
                        borderRadius: '4px',
                        textAlign: 'center',
                        fontSize: '11px',
                        color: '#0066cc',
                        fontWeight: '600'
                    }}
                >
                    {selectedCount} point{selectedCount !== 1 ? 's' : ''} selected
                </div>
            )}
        </div>
    );
}

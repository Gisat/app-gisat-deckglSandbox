
/**
 * SelectionControls - Reusable UI controls for point selection
 * Handles mode selection, buffer distance, and clear button
 * 
 * @param {Object} props
 * @param {string} props.selectionMode - Current mode: 'polygon', 'circle', 'line'
 * @param {Function} props.onModeChange - Called with new mode (automatically starts drawing)
 * @param {Function} props.onClear - Called to clear selection
 * @param {boolean} props.isDrawing - Whether drawing is active
 * @param {number} props.selectedCount - Number of selected points
 * @param {number} props.backendFeatureCount - Number of features from backend
 * @param {boolean} props.isLoadingBackend - Whether backend query is in progress
 * @param {number} props.bufferDistance - Current buffer distance (for line mode)
 * @param {Function} props.onBufferChange - Called with new buffer distance
 * @param {string} props.top - Top position (default: '130px')
 * @param {string} props.left - Left position (default: '10px')
 */
export function SelectionControls({
    selectionMode,
    onModeChange,
    onClear,
    selectedCount,
    backendFeatureCount = 0,
    isLoadingBackend = false,
    bufferDistance = 100,
    onBufferChange,
    top = '130px',
    left = '10px'
}) {
    const modes = ['polygon', 'circle', 'line'];

    return (
        <div
            style={{
                position: 'absolute',
                top,
                left,
                background: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                zIndex: 1000,
                fontFamily: 'system-ui, sans-serif',
                fontSize: '13px',
                minWidth: '220px'
            }}
        >
            {/* Mode Selector */}
            <div style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', marginBottom: '8px', fontSize: '13px', fontWeight: 'bold' }}>
                    Point Selection - Drawing Mode:
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
                    <label style={{ display: 'block', marginBottom: '6px', fontSize: '11px', fontWeight: '500' }}>
                        Buffer Distance: {bufferDistance}m
                    </label>
                    <input
                        type="range"
                        min="10"
                        max="500"
                        step="10"
                        value={bufferDistance}
                        onChange={e => onBufferChange(Number(e.target.value))}
                        style={{ width: '100%', fontSize: '11px' }}
                    />
                </div>
            )}

            {/* Selected Count with Clear Button */}
            {selectedCount > 0 && (
                <div
                    style={{
                        padding: '8px',
                        background: '#e6f0ff',
                        borderRadius: '4px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: '11px',
                        color: '#0066cc',
                        fontWeight: '600',
                        marginBottom: '8px'
                    }}
                >
                    <div>
                        {selectedCount} tile point{selectedCount !== 1 ? 's' : ''} selected
                        {isLoadingBackend && ' • ⚡ Fetching...'}
                        {backendFeatureCount > 0 && !isLoadingBackend && ` • ✅ ${backendFeatureCount}`}
                    </div>
                    <button
                        onClick={onClear}
                        style={{
                            padding: '4px 8px',
                            background: '#f0f0f0',
                            border: '1px solid #ddd',
                            borderRadius: '3px',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: '600',
                            whiteSpace: 'nowrap',
                            marginLeft: '8px'
                        }}
                    >
                        Clear
                    </button>
                </div>
            )}
        </div>
    );
}

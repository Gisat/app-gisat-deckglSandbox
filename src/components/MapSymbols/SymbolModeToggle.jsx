/**
 * SymbolModeToggle - small card that switches the streamed LOD points between
 * displacement circles and arrows.
 *
 * Rendered by `SelectionAnalysisPanel` below the selection card, which owns the
 * absolute positioning and stacking.
 *
 * @param {Object} props
 * @param {string} props.symbolMode - Current symbol mode: 'circle' or 'arrow'.
 * @param {Function} props.onSymbolModeChange - Called with the selected mode.
 */
const SYMBOL_MODES = [
    { id: 'circle', label: 'Circles' },
    { id: 'arrow', label: 'Arrows' }
];

export function SymbolModeToggle({ symbolMode, onSymbolModeChange }) {
    return (
        <div
            style={{
                background: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                padding: '8px 10px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '12px',
                color: '#333',
                minWidth: '150px'
            }}
        >
            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 'bold' }}>
                Map symbols:
            </label>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {SYMBOL_MODES.map(({ id, label }) => (
                    <button
                        key={id}
                        onClick={() => onSymbolModeChange(id)}
                        style={{
                            padding: '4px 8px',
                            border: symbolMode === id ? '2px solid #0066cc' : '1px solid #ccc',
                            borderRadius: '4px',
                            background: symbolMode === id ? '#e6f0ff' : '#fff',
                            color: '#333',
                            cursor: 'pointer',
                            fontSize: '11px',
                            fontWeight: symbolMode === id ? '600' : '400',
                            flex: '1',
                            minWidth: '52px'
                        }}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </div>
    );
}

const MODES = [
  { key: 'circle', label: 'Circle' },
  { key: 'polygon', label: 'Polygon' },
];

const HINTS = {
  circle: 'Click the centre, then the edge.',
  polygon: 'Click vertices, double-click to finish.',
};

/**
 * Circle / polygon point-selection toolbar for the Poláky map.
 *
 * @param {{
 *   selectionMode: 'circle'|'polygon'|null,
 *   isDrawing: boolean,
 *   selectedCount: number,
 *   onModeChange: (mode: 'circle'|'polygon') => void,
 *   onClear: () => void,
 * }} props
 */
export default function SelectionToolbar({
  selectionMode,
  isDrawing,
  selectedCount,
  onModeChange,
  onClear,
}) {
  return (
    <div style={{
      position: 'absolute',
      top: 10,
      left: 10,
      zIndex: 1000,
      minWidth: '220px',
      padding: '12px',
      background: 'rgba(255, 255, 255, 0.95)',
      borderRadius: '8px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
      color: '#333',
    }}>
      <div style={{ marginBottom: '8px', fontSize: '13px', fontWeight: 'bold' }}>
        Point selection
      </div>
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        {MODES.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => onModeChange(key)}
            style={{
              flex: 1,
              padding: '6px 10px',
              border: selectionMode === key ? '2px solid #0066cc' : '1px solid #ccc',
              borderRadius: '4px',
              background: selectionMode === key ? '#e6f0ff' : '#fff',
              color: '#333',
              cursor: 'pointer',
              fontSize: '11px',
              fontWeight: selectionMode === key ? 600 : 400,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {isDrawing && selectionMode && (
        <div style={{ marginBottom: '8px', fontSize: '11px', color: '#0066cc' }}>
          {HINTS[selectionMode]}
        </div>
      )}

      {selectedCount > 0 && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 8px',
          background: '#e6f0ff',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: 600,
          color: '#0066cc',
        }}>
          <span>{selectedCount} points</span>
          <button
            type="button"
            onClick={onClear}
            style={{
              padding: '2px 8px',
              border: '1px solid #0066cc',
              borderRadius: '4px',
              background: '#fff',
              color: '#0066cc',
              cursor: 'pointer',
              fontSize: '11px',
            }}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

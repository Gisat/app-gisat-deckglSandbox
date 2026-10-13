import { axisTitle, formatValue } from './attributes';

/**
 * Presentational hover tooltip shared by the deck.gl and three.js renderers.
 * Plotly uses its own hovertemplate instead.
 *
 * @param {{ point: import('./transformPoints').FeatureSpacePoint, axes: import('./attributes').PresetAxes }} props
 */
export function PointTooltip({ point, axes }) {
  if (!point) return null;
  return (
    <div
      style={{
        pointerEvents: 'none',
        background: 'rgba(255, 255, 255, 0.97)',
        border: '1px solid #ddd',
        borderRadius: '6px',
        padding: '8px 10px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#333',
        lineHeight: 1.5,
        minWidth: '160px',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '4px' }}>{point.id ?? 'unknown id'}</div>
      <div style={{ color: '#666', marginBottom: '6px' }}>
        id_orig: {point.idOrig ?? '\u2014'}
      </div>
      {['x', 'y', 'z'].map((axis) => (
        <div key={axis} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: '#666' }}>{axisTitle(axes[axis])}</span>
          <span>{formatValue(axes[axis], point[axes[axis]])}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginTop: '4px', borderTop: '1px solid #eee', paddingTop: '4px' }}>
        <span style={{ color: '#666' }}>coherence</span>
        <span>{formatValue('coh', point.coh)}</span>
      </div>
    </div>
  );
}

export default PointTooltip;

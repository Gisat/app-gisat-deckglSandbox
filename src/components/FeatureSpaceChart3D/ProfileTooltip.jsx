import { formatTick } from './profileGeometry';

/**
 * Presentational hover tooltip for the 3D line-profile mode, shared by the
 * deck.gl and three.js renderers. Plotly uses its own hovertemplate.
 *
 * @param {{ sample: {
 *   id: string|number|null, seriesLabel: string, color: string, unit?: string,
 *   value: number|null, std: number|null, distance: number|null,
 *   height: number|null, lon?: number|null, lat?: number|null,
 * } | null }} props
 */
export function ProfileTooltip({ sample }) {
  if (!sample) return null;
  const unit = sample.unit ? ` ${sample.unit}` : '';
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
        minWidth: '150px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, marginBottom: '4px' }}>
        <span
          style={{
            display: 'inline-block',
            width: '9px',
            height: '9px',
            borderRadius: '50%',
            background: sample.color,
          }}
        />
        {sample.seriesLabel}
      </div>
      <div style={{ color: '#666', marginBottom: '6px' }}>id: {sample.id ?? '\u2014'}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ color: '#666' }}>value</span>
        <span>
          {formatTick(sample.value)}
          {unit}
          {sample.std != null ? ` \u00b1 ${formatTick(sample.std)}${unit}` : ''}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ color: '#666' }}>distance</span>
        <span>{formatTick(sample.distance)} m</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
        <span style={{ color: '#666' }}>elevation</span>
        <span>{formatTick(sample.height)} m</span>
      </div>
    </div>
  );
}

export default ProfileTooltip;

import { formatValue } from './attributes';
import { formatTick } from './profileGeometry';

/**
 * Presentational hover tooltip for the Timeline chart type.
 *
 * Timeline paths are picked as whole curves (no per-epoch marks), so the
 * tooltip summarises the hovered point: its ID, velocity, displacement range
 * and record period.
 *
 * @param {{ curve: any }} props
 */
export function TimelineTooltip({ curve }) {
  if (!curve) return null;

  const rows = [];
  if (Number.isFinite(curve.velAvg)) rows.push(['VEL_AVG', formatValue('VEL_AVG', curve.velAvg)]);
  if (Number.isFinite(curve.minD) && Number.isFinite(curve.maxD)) {
    rows.push(['settlement', `${formatTick(curve.minD)} \u2013 ${formatTick(curve.maxD)} mm`]);
  }
  if (Number.isFinite(curve.tMin) && Number.isFinite(curve.tMax)) {
    const from = new Date(curve.tMin).getUTCFullYear();
    const to = new Date(curve.tMax).getUTCFullYear();
    rows.push(['period', `${from} \u2013 ${to}`]);
  }

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
        <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: curve.color, flex: 'none' }} />
        <span>Point {curve.label}</span>
      </div>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px' }}>
          <span style={{ color: '#666' }}>{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

export default TimelineTooltip;

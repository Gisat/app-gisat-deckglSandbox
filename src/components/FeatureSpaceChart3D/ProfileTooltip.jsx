import { formatValue, getAttribute } from './attributes';
import { formatTick } from './profileGeometry';

/**
 * Presentational hover tooltip for the 3D line-profile mode, shared by the
 * deck.gl and three.js renderers. Plotly uses its own hovertemplate.
 *
 * @param {{ sample: any, curve: any, frame: any }} props
 */
export function ProfileTooltip({ sample, curve, frame }) {
  if (!sample || !frame || !curve) return null;

  const rows = [];
  let header;

  if (frame.view === 'trend') {
    header = curve.label;
    const unit = getAttribute(sample.windowKey ?? curve.key)?.unit ?? '';
    const unitText = unit ? ` ${unit}` : '';
    const std = curve.stdKey ? sample.sample?.[curve.stdKey] : null;

    if (!curve.stdKey) {
      // Stations: each vertex belongs to a different trend window.
      rows.push(['window', sample.windowLabel ?? '\u2014']);
    }
    rows.push([
      'displacement',
      `${formatTick(sample.raw.z)}${unitText}${std != null ? ` \u00b1 ${formatTick(std)}${unitText}` : ''}`,
    ]);
    rows.push(['distance', `${formatTick(sample.sample?.distance)} m`]);
    if (curve.stdKey) rows.push(['id', sample.id ?? '\u2014']);
  } else {
    header = sample.id ?? '\u2014';
    const zKey = frame.zKey;
    const zUnit = getAttribute(zKey).unit ? ` ${getAttribute(zKey).unit}` : '';
    const std = curve.stdKey ? sample.sample?.[curve.stdKey] : null;

    rows.push([getAttribute(frame.yKey).label, formatValue(frame.yKey, sample.raw.y)]);
    rows.push([
      getAttribute(zKey).label,
      `${formatTick(sample.raw.z)}${zUnit}${std != null ? ` \u00b1 ${formatTick(std)}${zUnit}` : ''}`,
    ]);
    rows.push(['distance', `${formatTick(sample.sample?.distance)} m`]);
    rows.push(['offset', `${formatTick(sample.sample?.offset)} m`]);
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
        {sample.color && (
          <span style={{ width: '9px', height: '9px', borderRadius: '2px', background: sample.color, flex: 'none' }} />
        )}
        <span>{header}</span>
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

export default ProfileTooltip;

import { useMemo } from 'react';
import { ResponsiveLine } from '@nivo/line';

const DATE_KEY_RE = /^d_\d{8}$/;

function toDate(key) {
  return new Date(Date.UTC(
    +key.slice(2, 6),
    +key.slice(6, 8) - 1,
    +key.slice(8, 10),
  ));
}

function formatDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return String(value);
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

function formatNumber(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

/**
 * Floating displacement timeline for a single Poláky point.
 *
 * Plots every `d_YYYYMMDD` property (displacement in mm) against its date in
 * UTC. Non-finite / null samples are skipped.
 *
 * @param {{ feature: any, onClose: () => void }} props
 */
export default function TimelineChart({ feature, onClose }) {
  const props = feature?.properties ?? {};

  const series = useMemo(() => {
    const samples = Object.entries(feature?.properties ?? {})
      .filter(([key, value]) => DATE_KEY_RE.test(key) && Number.isFinite(value))
      .map(([key, value]) => ({ x: toDate(key), y: value }))
      .sort((a, b) => a.x - b.x);
    return samples.length ? [{ id: 'displacement', data: samples }] : [];
  }, [feature]);

  const cardStyle = {
    position: 'absolute',
    right: '12px',
    bottom: '12px',
    width: '460px',
    maxWidth: 'calc(100% - 24px)',
    height: '320px',
    zIndex: 1200,
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    padding: '8px 10px 10px',
    background: 'rgba(255, 255, 255, 0.97)',
    border: '1px solid #ddd',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
    fontFamily: 'system-ui, sans-serif',
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
      <div style={{ fontSize: '13px', fontWeight: 700, color: '#333' }}>
        Point {props.ID ?? '–'}
      </div>
      <div style={{ fontSize: '11px', color: '#555' }}>
        VEL_AVG <b>{formatNumber(props.VEL_AVG, 2)}</b> mm/yr
      </div>
      <div style={{ fontSize: '11px', color: '#555' }}>
        H_dem <b>{formatNumber(props.H_dem, 1)}</b> m
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close timeline"
        style={{
          marginLeft: 'auto',
          width: '22px',
          height: '22px',
          lineHeight: '18px',
          padding: 0,
          fontSize: '16px',
          color: '#555',
          background: 'none',
          border: '1px solid #ccc',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );

  if (series.length === 0) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#999',
          fontSize: '12px',
        }}>
          No d_* timeline data for this point.
        </div>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      {header}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveLine
          data={series}
          margin={{ top: 10, right: 20, bottom: 46, left: 58 }}
          // Deliberately no `precision: 'day'`: nivo truncates with *local* time
          // setters, which shifts UTC-midnight samples by the UTC offset. The
          // `d_*` samples are already day-precise, so the default precision is exact.
          xScale={{ type: 'time', useUTC: true }}
          yScale={{ type: 'linear', min: 'auto', max: 'auto', stacked: false, reverse: false }}
          axisTop={null}
          axisRight={null}
          axisBottom={{
            legend: 'Time',
            legendOffset: 38,
            legendPosition: 'middle',
            tickSize: 4,
            tickPadding: 6,
            format: '%Y',
            tickValues: 'every 2 years',
          }}
          axisLeft={{
            legend: 'Displacement (mm)',
            legendOffset: -46,
            legendPosition: 'middle',
            tickSize: 4,
            tickPadding: 6,
          }}
          colors={['#1f77b4']}
          lineWidth={2}
          pointSize={2.5}
          pointColor={{ theme: 'background' }}
          pointBorderWidth={1.5}
          pointBorderColor={{ from: 'serieColor' }}
          enableArea={false}
          enableGridX={false}
          useMesh={true}
          enableCrosshair={true}
          animate={false}
          tooltip={({ point }) => (
            <div style={{
              padding: '4px 8px',
              background: 'rgba(255, 255, 255, 0.97)',
              border: '1px solid #ccc',
              borderRadius: '4px',
              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
              fontSize: '11px',
              color: '#333',
              fontFamily: 'system-ui, sans-serif',
            }}>
              <div>{formatDate(point.data.x)}</div>
              <div style={{ fontWeight: 700 }}>{Number(point.data.y).toFixed(2)} mm</div>
            </div>
          )}
          theme={{
            textColor: '#333',
            fontSize: 11,
            fontFamily: 'system-ui, sans-serif',
            axis: {
              domain: { line: { stroke: '#ccc' } },
              legend: { text: { fill: '#333', fontSize: 11 } },
              ticks: {
                line: { stroke: '#ccc' },
                text: { fill: '#555', fontSize: 10 },
              },
            },
            grid: { line: { stroke: '#eee' } },
            crosshair: { line: { stroke: '#999', strokeWidth: 1, strokeOpacity: 0.6 } },
          }}
        />
      </div>
    </div>
  );
}

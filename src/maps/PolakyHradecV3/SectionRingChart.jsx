import { useMemo } from 'react';
import { ResponsiveLine } from '@nivo/line';
import { buildSectionSeries, buildSectionSlice } from './bandGeometry';
import { sectionTitle } from './tracks';

// Stable empty input: the card stays mounted for one frame after the ring clears.
const EMPTY = [];

// Faint point lines vs. the section median, which matches the 3D cyan highlight.
const POINT_COLOR = 'rgba(90, 169, 255, 0.24)';
const MEDIAN_COLOR = '#42d4f4';

function formatSignedMm(value, digits = 2) {
  if (!Number.isFinite(value)) return '–';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function formatDateMs(ms) {
  if (!Number.isFinite(ms)) return '–';
  return new Date(ms).toISOString().slice(0, 10);
}

function swatch(color) {
  return {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: color,
    marginRight: '4px',
  };
}

/**
 * Section timeline card opened by clicking a 3D stack ring.
 *
 * Shows every scatterer of the clicked section as a faint curve, the exact
 * median series that drives the 3D ring centres, and a vertical slice at the
 * clicked ring's timestep with one dot per point plus the median marker. The
 * slice is re-anchored by the parent when the controls change, so the card
 * always matches the cyan ring on the map.
 *
 * @param {{
 *   ring: any, pylon: any, rawMode: boolean, bucketId: string,
 *   activeDates: number[], onClose: () => void,
 * }} props
 */
export default function SectionRingChart({
  ring,
  pylon,
  rawMode,
  bucketId,
  activeDates,
  onClose,
}) {
  const scatterers = pylon?.bands?.[ring?.trackId]?.[ring?.bandIndex] ?? EMPTY;

  // The curves are date-independent, so they are only rebuilt when the section
  // or the bucketing controls change; stepping through rings only re-runs the
  // cheap slice lookup below.
  const series = useMemo(() => buildSectionSeries({
    scatterers,
    rawMode,
    bucketId,
    activeDates,
  }), [scatterers, rawMode, bucketId, activeDates]);

  const { sliceDots } = useMemo(() => buildSectionSlice({
    pointSamples: series.pointSamples,
    targetDateMs: ring?.dateMs,
  }), [series, ring?.dateMs]);

  const chartData = useMemo(() => [
    ...series.pointSeries,
    { id: 'median', data: series.medianSeries },
  ], [series]);

  const cardStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    padding: '8px 10px 10px',
    background: 'rgba(32, 35, 41, 0.95)',
    border: '1px solid #484d55',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
    fontFamily: 'system-ui, sans-serif',
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#e8eaed' }}>
        {`Pylon ${pylon?.id ?? '–'} · ${sectionTitle(ring?.bandLabel)} (${scatterers.length} pts) · ${ring?.trackId ?? '–'}`}
      </div>
      <div style={{ fontSize: '11px', color: MEDIAN_COLOR }}>
        Median <b>{formatSignedMm(ring?.valueMm)}</b> mm
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close section timeline"
        style={{
          marginLeft: 'auto',
          width: '22px',
          height: '22px',
          lineHeight: '18px',
          padding: 0,
          fontSize: '16px',
          color: '#b3b8bf',
          background: 'none',
          border: '1px solid #4a4f57',
          borderRadius: '4px',
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );

  if (series.pointSeries.length === 0 && series.medianSeries.length === 0) {
    return (
      <div style={cardStyle}>
        {header}
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9aa0a8',
          fontSize: '12px',
        }}>
          No timeline data for this section.
        </div>
      </div>
    );
  }

  // nivo 0.99 has one global `lineWidth` for every series, so the bold median is
  // drawn here from the layer's own `lineGenerator`; the thin same-colour median
  // from the `lines` layer overdraws it harmlessly.
  function RingSliceHighlightLayer({ xScale, yScale, innerWidth, innerHeight, series, lineGenerator }) {
    const sliceX = xScale(new Date(ring?.dateMs));
    if (!Number.isFinite(sliceX) || sliceX < 0 || sliceX > innerWidth) return null;
    const medianComputed = series.find(s => s.id === 'median');
    return (
      <g>
        <rect
          x={sliceX - 7}
          y={0}
          width={14}
          height={innerHeight}
          fill="rgba(66, 212, 244, 0.14)"
          stroke="rgba(66, 212, 244, 0.55)"
          strokeWidth={1}
        />
        {medianComputed && (
          <path
            d={lineGenerator(medianComputed.data.map(d => d.position))}
            fill="none"
            stroke={MEDIAN_COLOR}
            strokeWidth={2.8}
          />
        )}
        {sliceDots.map(dot => (
          <circle
            key={dot.id}
            cx={sliceX}
            cy={yScale(dot.valueMm)}
            r={3.2}
            fill={MEDIAN_COLOR}
            stroke="#14171b"
            strokeWidth={1}
          />
        ))}
        <circle
          cx={sliceX}
          cy={yScale(ring?.valueMm)}
          r={5}
          fill="#ffffff"
          stroke={MEDIAN_COLOR}
          strokeWidth={2}
        />
      </g>
    );
  }

  return (
    <div style={cardStyle}>
      {header}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveLine
          data={chartData}
          margin={{ top: 10, right: 20, bottom: 46, left: 58 }}
          // Same UTC handling as TimelineChart: the samples are day-precise and
          // nivo's `day` precision truncates with local-time setters.
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
          colors={({ id }) => (id === 'median' ? MEDIAN_COLOR : POINT_COLOR)}
          layers={['grid', 'axes', RingSliceHighlightLayer, 'lines', 'crosshair', 'mesh']}
          enablePoints={false}
          enableGridX={false}
          useMesh={true}
          enableCrosshair={true}
          animate={false}
          tooltip={({ point }) => (
            <div style={{
              padding: '4px 8px',
              background: '#2a2d33',
              border: '1px solid #4a4f57',
              borderRadius: '4px',
              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.45)',
              fontSize: '11px',
              color: '#e8eaed',
              fontFamily: 'system-ui, sans-serif',
            }}>
              <div style={{ color: point.seriesColor }}>{point.seriesId}</div>
              <div>{formatDateMs(point.data.x instanceof Date ? point.data.x.getTime() : NaN)}</div>
              <div style={{ fontWeight: 700 }}>{Number(point.data.y).toFixed(2)} mm</div>
            </div>
          )}
          theme={{
            textColor: '#e8eaed',
            fontSize: 11,
            fontFamily: 'system-ui, sans-serif',
            axis: {
              domain: { line: { stroke: '#4a4f57' } },
              legend: { text: { fill: '#e8eaed', fontSize: 11 } },
              ticks: {
                line: { stroke: '#4a4f57' },
                text: { fill: '#b3b8bf', fontSize: 10 },
              },
            },
            grid: { line: { stroke: '#33373d' } },
            crosshair: { line: { stroke: '#c6ccd4', strokeWidth: 1, strokeOpacity: 0.6 } },
          }}
        />
      </div>
      <div style={{
        display: 'flex',
        gap: '10px',
        alignItems: 'center',
        marginTop: '2px',
        fontSize: '10px',
        color: '#b3b8bf',
      }}>
        <span><span style={swatch(POINT_COLOR)} />Points ({scatterers.length})</span>
        <span><span style={swatch(MEDIAN_COLOR)} />Section median</span>
        <span style={{ marginLeft: 'auto' }}>Slice {formatDateMs(ring?.dateMs)}</span>
      </div>
    </div>
  );
}

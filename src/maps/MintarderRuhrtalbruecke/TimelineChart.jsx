import { useEffect, useMemo, useState } from 'react';
import { ResponsiveLine } from '@nivo/line';
import { epochKeyToUtc, isTimelineKey, toNumber } from '../../components/FeatureSpaceChart3D';
import {
  DOT_COLORS,
  RELIABILITY_THRESHOLD_DEFAULT,
  RELIABILITY_THRESHOLD_MAX,
  RELIABILITY_THRESHOLD_MIN,
  RELIABILITY_THRESHOLD_STEP,
  dotColorForDate,
  loadTrackClassification,
} from './trackClassification';
import {
  DEFAULT_OFFSET_FACTOR,
  OFFSET_FACTOR_STEP,
  parseOffsetFactor,
} from './trackMetadata';

function formatDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return String(value);
  const month = String(value.getUTCMonth() + 1).padStart(2, '0');
  const day = String(value.getUTCDate()).padStart(2, '0');
  return `${value.getUTCFullYear()}-${month}-${day}`;
}

function formatNumber(value, digits) {
  if (value == null || value === '') return '–';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

const RAW_SERIES_ID = 'Displacement';
const OFFSET_COLOR = '#40E0D0';
const RAW_POINT_SIZE = 3.5;
const OFFSET_POINT_SIZE = 2.2;

/**
 * Per-datum dot symbol. Nivo's `pointSize` prop is a scalar, so the radius is
 * read from the original datum (`datum.pointSize`) and falls back to the
 * scalar `size` for anything that does not carry one.
 */
function VariablePointSymbol({ datum, size, color, borderWidth, borderColor }) {
  const radius = (datum?.pointSize ?? size) / 2;
  return (
    <circle
      r={radius}
      fill={color}
      stroke={borderColor}
      strokeWidth={borderWidth}
    />
  );
}

/**
 * Displacement timeline card for a single InSAR point.
 *
 * Plots every `d_YYYYMMDD` property (displacement in mm) against its date in
 * UTC. Non-finite / null samples are skipped. The card fills its positioned
 * parent, which owns the floating placement.
 *
 * Dots are coloured by the track's final-class CSV reliability for the sample
 * date: blue at or above the threshold, grey below, black when the CSV has no
 * interval covering that date (or no row for the point).
 *
 * Two optional turquoise series shift the raw displacement by `±wavelength ×
 * factor` (wavelength from the track metadata). They are hidden when the
 * wavelength is unavailable or the factor is zero / invalid.
 *
 * @param {{ feature: any, trackLabel?: string, onClose: () => void,
 *   classificationUrl?: string, reliabilityThreshold?: number,
 *   onReliabilityThresholdChange?: (value: number) => void,
 *   wavelength?: number|null, wavelengthError?: string|null,
 *   plusOffsetFactor?: string, onPlusOffsetFactorChange?: (value: string) => void,
 *   minusOffsetFactor?: string,
 *   onMinusOffsetFactorChange?: (value: string) => void }} props
 */
export default function TimelineChart({
  feature,
  trackLabel = '–',
  onClose,
  classificationUrl,
  reliabilityThreshold = RELIABILITY_THRESHOLD_DEFAULT,
  onReliabilityThresholdChange,
  wavelength = null,
  wavelengthError = null,
  plusOffsetFactor = String(DEFAULT_OFFSET_FACTOR),
  onPlusOffsetFactorChange,
  minusOffsetFactor = String(DEFAULT_OFFSET_FACTOR),
  onMinusOffsetFactorChange,
}) {
  const props = feature?.properties ?? {};

  const [classification, setClassification] = useState({
    url: null,
    status: 'idle',
    byId: null,
    error: null,
  });

  useEffect(() => {
    if (!classificationUrl) {
      setClassification({ url: null, status: 'missing', byId: null, error: null });
      return undefined;
    }

    let active = true;
    setClassification((previous) => (
      previous.url === classificationUrl && previous.status === 'ready'
        ? previous
        : { url: classificationUrl, status: 'loading', byId: null, error: null }
    ));

    loadTrackClassification(classificationUrl)
      .then((byId) => {
        if (!active) return;
        setClassification({
          url: classificationUrl,
          status: 'ready',
          byId,
          error: null,
        });
      })
      .catch((error) => {
        if (!active) return;
        setClassification({
          url: classificationUrl,
          status: 'error',
          byId: null,
          error,
        });
      });

    return () => { active = false; };
  }, [classificationUrl]);

  // The CSV is keyed by `ID` (text); the parquet ID may be a number, so both
  // sides are compared as strings. `arrowIndex` is a row index and must never
  // stand in for the CSV ID.
  const pointId = props.ID != null
    ? String(props.ID)
    : (feature?.id != null ? String(feature.id) : null);

  // The chart instance survives a track change, and the effect below resets the
  // CSV state after paint. Ignore a classification loaded for another URL so a
  // point on a newly selected track can never be coloured with the previous
  // track's intervals (IDs repeat across tracks).
  const activeUrl = classificationUrl ?? null;
  const classificationStatus = classification.url === activeUrl
    ? classification.status
    : 'loading';

  const classificationEntry = classificationStatus === 'ready' && pointId != null
    ? classification.byId?.get(pointId) ?? null
    : null;

  const rawSamples = useMemo(() => {
    // While the CSV is in flight keep the previous blue instead of flashing
    // black; the caption below says why. Any other unresolved state is black.
    const resolveColor = (date) => {
      if (classificationStatus === 'loading' || classificationStatus === 'idle') {
        return DOT_COLORS.reliable;
      }
      if (classificationStatus !== 'ready') return DOT_COLORS.missing;
      return dotColorForDate(classificationEntry, date.getTime(), reliabilityThreshold);
    };

    return Object.entries(feature?.properties ?? {})
      .filter(([key]) => isTimelineKey(key))
      .map(([key, value]) => ({
        x: new Date(epochKeyToUtc(key)),
        y: toNumber(value),
      }))
      .filter(({ x, y }) => y != null && !Number.isNaN(x.getTime()))
      .sort((a, b) => a.x - b.x)
      .map((datum) => ({
        ...datum,
        color: resolveColor(datum.x),
        pointSize: RAW_POINT_SIZE,
        seriesId: RAW_SERIES_ID,
      }));
  }, [feature, classificationStatus, classificationEntry, reliabilityThreshold]);

  const wavelengthValue = Number.isFinite(wavelength) ? wavelength : null;
  const plusFactor = parseOffsetFactor(plusOffsetFactor);
  const minusFactor = parseOffsetFactor(minusOffsetFactor);
  const plusOffset = wavelengthValue != null && plusFactor != null && plusFactor > 0
    ? wavelengthValue * plusFactor
    : null;
  const minusOffset = wavelengthValue != null && minusFactor != null && minusFactor > 0
    ? wavelengthValue * minusFactor
    : null;

  const series = useMemo(() => {
    if (rawSamples.length === 0) return [];
    const result = [{ id: RAW_SERIES_ID, data: rawSamples }];

    if (plusOffset != null) {
      const id = `+${plusFactor.toFixed(2)}λ`;
      result.push({
        id,
        data: rawSamples.map((point) => ({
          x: point.x,
          y: point.y + plusOffset,
          // Overwrite, never spread: the raw reliability colours must not leak
          // into the turquoise offset series.
          color: OFFSET_COLOR,
          pointSize: OFFSET_POINT_SIZE,
          seriesId: id,
        })),
      });
    }

    if (minusOffset != null) {
      const id = `−${minusFactor.toFixed(2)}λ`;
      result.push({
        id,
        data: rawSamples.map((point) => ({
          x: point.x,
          y: point.y - minusOffset,
          color: OFFSET_COLOR,
          pointSize: OFFSET_POINT_SIZE,
          seriesId: id,
        })),
      });
    }

    return result;
  }, [rawSamples, plusOffset, minusOffset, plusFactor, minusFactor]);

  let statusMessage = null;
  if (classificationStatus === 'loading' || classificationStatus === 'idle') {
    statusMessage = 'Loading final-class CSV…';
  } else if (classificationStatus === 'error') {
    statusMessage = 'Final-class CSV unavailable for this track.';
  } else if (classificationStatus === 'missing') {
    statusMessage = 'Final-class CSV not configured for this track.';
  } else if (classificationStatus === 'ready' && !classificationEntry) {
    statusMessage = `Point ${pointId ?? '–'} not in this track's final-class CSV.`;
  }

  const errorDetail = classificationStatus === 'error' && classification.error
    ? String(classification.error.message ?? classification.error)
    : null;

  const wavelengthMissing = wavelengthValue == null;

  const legendItems = [
    { color: DOT_COLORS.reliable, label: `rel ≥ ${reliabilityThreshold.toFixed(2)}` },
    { color: DOT_COLORS.unreliable, label: `rel < ${reliabilityThreshold.toFixed(2)}` },
    { color: DOT_COLORS.missing, label: 'no data' },
  ];
  if (plusOffset != null) {
    legendItems.push({
      color: OFFSET_COLOR,
      label: `+λ×${plusFactor.toFixed(2)} (+${plusOffset.toFixed(2)} mm)`,
    });
  }
  if (minusOffset != null) {
    legendItems.push({
      color: OFFSET_COLOR,
      label: `−λ×${minusFactor.toFixed(2)} (−${minusOffset.toFixed(2)} mm)`,
    });
  }

  const legend = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '2px',
      fontSize: '10px',
      color: '#555',
    }}>
      {legendItems.map((item) => (
        <span key={item.label} style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
          <span style={{
            width: '7px',
            height: '7px',
            borderRadius: '50%',
            background: item.color,
            border: item.color === DOT_COLORS.missing ? '1px solid #999' : 'none',
            boxSizing: 'border-box',
            display: 'inline-block',
          }} />
          {item.label}
        </span>
      ))}
    </div>
  );

  const numberInputStyle = {
    width: '52px',
    padding: '1px 4px',
    fontSize: '10px',
    color: '#333',
    border: '1px solid #ccc',
    borderRadius: '3px',
    boxSizing: 'border-box',
  };

  const settingsRow = (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      flexWrap: 'wrap',
      marginBottom: '3px',
      fontSize: '10px',
      color: '#555',
    }}>
      <label
        htmlFor="timeline-rel-threshold"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        <span>rel ≥ {reliabilityThreshold.toFixed(2)}</span>
        <input
          id="timeline-rel-threshold"
          type="range"
          min={RELIABILITY_THRESHOLD_MIN}
          max={RELIABILITY_THRESHOLD_MAX}
          step={RELIABILITY_THRESHOLD_STEP}
          value={reliabilityThreshold}
          onChange={(event) => onReliabilityThresholdChange?.(Number(event.target.value))}
          disabled={!onReliabilityThresholdChange}
          style={{ width: '72px', cursor: 'pointer', margin: 0 }}
        />
      </label>
      <label
        htmlFor="timeline-plus-factor"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        <span>+λ ×</span>
        <input
          id="timeline-plus-factor"
          type="number"
          min={0}
          step={OFFSET_FACTOR_STEP}
          value={plusOffsetFactor}
          onChange={(event) => onPlusOffsetFactorChange?.(event.target.value)}
          disabled={wavelengthMissing}
          style={numberInputStyle}
        />
      </label>
      <label
        htmlFor="timeline-minus-factor"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      >
        <span>−λ ×</span>
        <input
          id="timeline-minus-factor"
          type="number"
          min={0}
          step={OFFSET_FACTOR_STEP}
          value={minusOffsetFactor}
          onChange={(event) => onMinusOffsetFactorChange?.(event.target.value)}
          disabled={wavelengthMissing}
          style={numberInputStyle}
        />
      </label>
    </div>
  );

  const cardStyle = {
    position: 'relative',
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    boxSizing: 'border-box',
    padding: '8px 10px 10px',
    background: '#fff',
    border: '1px solid #ddd',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
    fontFamily: 'system-ui, sans-serif',
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#333' }}>
        Point {props.ID ?? '–'} · {trackLabel}
      </div>
      <div style={{ fontSize: '11px', color: '#555' }}>
        VEL_AVG <b>{formatNumber(props.VEL_AVG, 2)}</b> mm/yr
      </div>
      <div style={{ fontSize: '11px', color: '#555' }}>
        λ <b>{formatNumber(wavelengthValue, 3)}</b> mm
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
      {legend}
      {settingsRow}
      {statusMessage && (
        <div
          title={errorDetail ?? undefined}
          style={{ fontSize: '10px', color: '#8a5a00', marginBottom: '2px' }}
        >
          {statusMessage}
        </div>
      )}
      {wavelengthMissing && (
        <div
          title={wavelengthError ?? undefined}
          style={{ fontSize: '10px', color: '#8a5a00', marginBottom: '2px' }}
        >
          Wavelength unavailable for this track; offset series hidden.
        </div>
      )}
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
          colors={[DOT_COLORS.reliable]}
          // nivo 0.99 has no `enableLine`; omitting the `lines` layer removes the
          // connecting line while keeping the per-sample dots, mesh and crosshair.
          layers={['grid', 'markers', 'axes', 'areas', 'crosshair', 'points', 'slices', 'mesh', 'legends']}
          pointSize={RAW_POINT_SIZE}
          pointSymbol={VariablePointSymbol}
          enablePoints={true}
          // Runtime calls getPointColor once per point and reads the datum, so
          // the per-sample `color` set in the series memo wins.
          pointColor={(context) => context.point?.data?.color ?? DOT_COLORS.missing}
          pointBorderWidth={0}
          enableArea={false}
          enableGridX={false}
          useMesh={true}
          enableCrosshair={true}
          animate={false}
          tooltip={({ point }) => (
            <div style={{
              padding: '4px 8px',
              background: '#fff',
              border: '1px solid #ccc',
              borderRadius: '4px',
              boxShadow: '0 2px 6px rgba(0, 0, 0, 0.15)',
              fontSize: '11px',
              color: '#333',
              fontFamily: 'system-ui, sans-serif',
            }}>
              <div>{formatDate(point.data.x)}</div>
              <div>{point.seriesId ?? 'displacement'}</div>
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

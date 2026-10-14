import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import {
  ATTRIBUTES,
  AXIS_KEYS,
  COLOR_KEYS,
  DEFAULT_CUSTOM_AXES,
  DEFAULT_PRESET,
  PRESET_KEYS,
  PRESETS,
  SIZE_KEYS,
  formatValue,
  resolveAxes,
} from './attributes';
import { activeFieldsFor, transformPoints } from './transformPoints';
import { SIZE_PIXEL_RANGE, buildColorScale, getColorDomain, getSizeDomain } from './colorScale';

const PlotlyRenderer = lazy(() => import('./renderers/PlotlyRenderer'));
const DeckGLRenderer = lazy(() => import('./renderers/DeckGLRenderer'));
const ThreeRenderer = lazy(() => import('./renderers/ThreeRenderer'));

const RENDERERS = [
  { key: 'plotly', label: 'Plotly', note: 'no per-point size' },
  { key: 'deckgl', label: 'deck.gl', note: 'OrbitView' },
  { key: 'three', label: 'three.js', note: 'r3f + drei' },
];

const RENDERER_COMPONENTS = {
  plotly: PlotlyRenderer,
  deckgl: DeckGLRenderer,
  three: ThreeRenderer,
};

/** Series shown by default in the 3D line-profile mode. */
const DEFAULT_SERIES_KEYS = ['VEL_REL', 'VEL_LAST', 'LT_365'];

/**
 * 3D feature-space chart with two mutually exclusive modes:
 *  - `scatter`: the feature-space point cloud (default).
 *  - `profile`: a 3D line profile (multi-series lines + uncertainty ribbons).
 *
 * Portable module: consumes a GeoJSON FeatureCollection, a precomputed profile
 * series list and a hover callback only. It intentionally imports nothing from
 * src/maps/*.
 *
 * @param {Object} props
 * @param {any} props.featureCollection  GeoJSON FeatureCollection of selected points
 * @param {Array<any>} [props.profileSeries]  precomputed line-profile series (app-owned)
 * @param {boolean} [props.showProfile]  expose the 3D line-profile mode (only when a line is drawn)
 * @param {(id: string|null) => void} [props.onPointHover]  map-link hover callback
 * @param {'plotly'|'deckgl'|'three'} [props.defaultRenderer]
 * @param {string} [props.title]
 */
export function FeatureSpaceChart({
  featureCollection,
  profileSeries = [],
  showProfile = false,
  onPointHover,
  defaultRenderer = 'plotly',
  title = '3D feature space',
}) {
  const [renderer, setRenderer] = useState(defaultRenderer);
  const [presetKey, setPresetKey] = useState(DEFAULT_PRESET);
  const [customAxes, setCustomAxes] = useState(DEFAULT_CUSTOM_AXES);
  const [markerStyle, setMarkerStyle] = useState('sphere');

  const [mode, setMode] = useState('scatter');
  const [dimMode, setDimMode] = useState('along');
  const [seriesKeys, setSeriesKeys] = useState(DEFAULT_SERIES_KEYS);
  const [activeSeriesKey, setActiveSeriesKey] = useState(DEFAULT_SERIES_KEYS[0]);

  const axes = useMemo(() => resolveAxes(presetKey, customAxes), [presetKey, customAxes]);
  const activeFields = useMemo(() => activeFieldsFor(axes), [axes]);

  const { points, skipped, total } = useMemo(
    () => transformPoints(featureCollection, activeFields),
    [featureCollection, activeFields],
  );

  const colorDomain = useMemo(() => getColorDomain(axes.color, points), [axes.color, points]);
  const colorScale = useMemo(() => buildColorScale(axes.color, colorDomain), [axes.color, colorDomain]);
  const sizeDomain = useMemo(() => getSizeDomain(axes.size, points), [axes.size, points]);

  const checkedSeries = useMemo(
    () => profileSeries.filter((s) => seriesKeys.includes(s.key)),
    [profileSeries, seriesKeys],
  );

  const effectiveActiveKey = checkedSeries.some((s) => s.key === activeSeriesKey)
    ? activeSeriesKey
    : (checkedSeries[0]?.key ?? null);

  const rendererSeries = useMemo(
    () => (dimMode === 'geo' ? checkedSeries.filter((s) => s.key === effectiveActiveKey) : checkedSeries),
    [dimMode, checkedSeries, effectiveActiveKey],
  );

  // The profile mode only exists while the line tool is in use; otherwise the
  // panel falls back to scatter even if `mode` state was left on 'profile'.
  const activeMode = showProfile ? mode : 'scatter';

  const profile = useMemo(
    () =>
      activeMode === 'profile' && rendererSeries.length > 0
        ? { mode: dimMode, activeSeriesKey: effectiveActiveKey, series: rendererSeries }
        : null,
    [activeMode, dimMode, rendererSeries, effectiveActiveKey],
  );

  const profileSampleCount = useMemo(
    () => rendererSeries.reduce((acc, s) => acc + s.samples.length, 0),
    [rendererSeries],
  );

  const handleHover = useCallback(
    (id) => {
      if (onPointHover) onPointHover(id ?? null);
    },
    [onPointHover],
  );

  const setAxis = (slot, key) => {
    setPresetKey('custom');
    setCustomAxes((prev) => ({ ...prev, [slot]: key }));
  };

  const toggleSeries = (key) => {
    setSeriesKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const Renderer = RENDERER_COMPONENTS[renderer];

  // Plotly has no sphere marker, so its effective style is always billboards.
  const effectiveMarker = renderer === 'plotly' ? 'billboard' : markerStyle;

  const rendererProps = {
    points,
    axes,
    colorScale,
    colorDomain,
    sizeDomain,
    sizeRange: SIZE_PIXEL_RANGE,
    markerStyle,
    onHover: handleHover,
  };

  const headerBadge = activeMode === 'profile' ? `${profileSampleCount} samples` : `${points.length} pts`;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(45%, 720px)',
        minWidth: '380px',
        background: 'rgba(255, 255, 255, 0.97)',
        borderLeft: '1px solid #ddd',
        boxShadow: '-2px 0 12px rgba(0,0,0,0.12)',
        zIndex: 1100,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '12px',
        color: '#333',
        pointerEvents: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          borderBottom: '1px solid #eee',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ fontSize: '13px' }}>{title}</strong>
        <span
          style={{
            background: '#e6f0ff',
            color: '#0066cc',
            borderRadius: '10px',
            padding: '1px 8px',
            fontWeight: 600,
            fontSize: '11px',
          }}
        >
          {headerBadge}
        </span>
        {activeMode === 'scatter' && skipped > 0 && (
          <span
            title={`${skipped} of ${total} points skipped (missing value for an active axis/color/size field)`}
            style={{ color: '#b45309', fontSize: '11px' }}
          >
            {skipped} skipped
          </span>
        )}

        {showProfile && (
          <div style={{ display: 'flex', gap: '3px' }} title="Chart mode">
            <button onClick={() => setMode('scatter')} style={buttonStyle(activeMode === 'scatter')}>
              Scatter
            </button>
            <button onClick={() => setMode('profile')} style={buttonStyle(activeMode === 'profile')}>
              3D line profile
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }}>
          {RENDERERS.map((r) => (
            <button
              key={r.key}
              title={r.note}
              onClick={() => setRenderer(r.key)}
              style={buttonStyle(renderer === r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div
          style={{ display: 'flex', gap: '3px' }}
          title={
            renderer === 'plotly'
              ? 'Plotly can only draw billboard circles'
              : 'Marker shape'
          }
        >
          <button
            disabled={renderer === 'plotly'}
            onClick={() => setMarkerStyle('billboard')}
            style={buttonStyle(effectiveMarker === 'billboard', renderer === 'plotly')}
          >
            circles
          </button>
          <button
            disabled={renderer === 'plotly'}
            onClick={() => setMarkerStyle('sphere')}
            style={buttonStyle(effectiveMarker === 'sphere', renderer === 'plotly')}
          >
            spheres
          </button>
        </div>
        {activeMode === 'scatter' && (
          <select
            value={presetKey}
            onChange={(e) => setPresetKey(e.target.value)}
            style={selectStyle}
            title="Axis preset"
          >
            {PRESET_KEYS.map((key) => (
              <option key={key} value={key}>
                {key === 'custom' ? 'Custom' : PRESETS[key].label}
              </option>
            ))}
          </select>
        )}
      </div>

      {activeMode === 'profile' && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px',
            alignItems: 'center',
            padding: '8px 12px',
            borderBottom: '1px solid #eee',
            background: '#fafafa',
          }}
        >
          <span style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>Series</span>
          {profileSeries.map((s) => (
            <label key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={seriesKeys.includes(s.key)}
                onChange={() => toggleSeries(s.key)}
                style={{ cursor: 'pointer', width: '13px', height: '13px' }}
              />
              <span style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: s.color }} />
              <span style={{ fontSize: '11px' }}>{s.label}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }} title="Profile dimensions">
            <button onClick={() => setDimMode('along')} style={buttonStyle(dimMode === 'along')}>
              Along line
            </button>
            <button onClick={() => setDimMode('geo')} style={buttonStyle(dimMode === 'geo')}>
              Geo path
            </button>
          </div>
          {dimMode === 'geo' && checkedSeries.length > 0 && (
            <select
              value={effectiveActiveKey ?? ''}
              onChange={(e) => setActiveSeriesKey(e.target.value)}
              style={selectStyle}
              title="Active series (geo path)"
            >
              {checkedSeries.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {activeMode === 'scatter' && presetKey === 'custom' && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: '6px',
            padding: '8px 12px',
            borderBottom: '1px solid #eee',
            background: '#fafafa',
          }}
        >
          {[
            ['x', AXIS_KEYS],
            ['y', AXIS_KEYS],
            ['z', AXIS_KEYS],
            ['color', COLOR_KEYS],
            ['size', SIZE_KEYS],
          ].map(([slot, keys]) => (
            <label key={slot} style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              <span style={{ fontSize: '10px', color: '#666', textTransform: 'uppercase' }}>{slot}</span>
              <select
                value={customAxes[slot]}
                onChange={(e) => setAxis(slot, e.target.value)}
                style={selectStyle}
              >
                {keys.map((key) => (
                  <option key={key} value={key}>
                    {ATTRIBUTES[key].label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {activeMode === 'profile' ? (
          profileSeries.length === 0 ? (
            <ProfileEmptyState reason="no-line" />
          ) : checkedSeries.length === 0 ? (
            <ProfileEmptyState reason="no-series" />
          ) : (
            <Suspense fallback={<LoadingState renderer={renderer} />}>
              <Renderer {...rendererProps} profile={profile} />
            </Suspense>
          )
        ) : points.length === 0 ? (
          <EmptyState total={total} skipped={skipped} />
        ) : (
          <Suspense fallback={<LoadingState renderer={renderer} />}>
            <Renderer {...rendererProps} />
          </Suspense>
        )}
      </div>

      {activeMode === 'scatter' && (
        <div
          style={{
            padding: '6px 12px',
            borderTop: '1px solid #eee',
            color: '#888',
            fontSize: '10px',
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
          }}
        >
          <span>
            Color: {ATTRIBUTES[axes.color].label}
            {axes.color === 'VEL_REL' ? ' (map scale)' : ` (${formatValue(axes.color, colorDomain[0])} \u2013 ${formatValue(axes.color, colorDomain[1])})`}
          </span>
          <span>
            Size: {ATTRIBUTES[axes.size].label}
            {axes.size === 'COH' ? ' (fixed 0\u20131)' : ''}
          </span>
        </div>
      )}
    </div>
  );
}

function LoadingState({ renderer }) {
  return (
    <div style={centeredState}>
      {`Loading ${renderer} renderer\u2026`}
    </div>
  );
}

function EmptyState({ total, skipped }) {
  return (
    <div style={centeredState}>
      <div style={{ fontWeight: 600, marginBottom: '6px', color: '#666' }}>No points to plot</div>
      <div style={{ color: '#999', fontSize: '11px', textAlign: 'center', maxWidth: '260px' }}>
        {total === 0
          ? 'Draw a polygon, circle or line selection on the map.'
          : `All ${total} selected points lack a value for an active axis/color/size field${skipped ? ` (${skipped} skipped)` : ''}.`}
      </div>
    </div>
  );
}

function ProfileEmptyState({ reason }) {
  return (
    <div style={centeredState}>
      <div style={{ fontWeight: 600, marginBottom: '6px', color: '#666' }}>
        {reason === 'no-series' ? 'No series selected' : 'No line profile yet'}
      </div>
      <div style={{ color: '#999', fontSize: '11px', textAlign: 'center', maxWidth: '260px' }}>
        {reason === 'no-series'
          ? 'Select at least one series to plot.'
          : 'Draw a line selection on the map to see the profile.'}
      </div>
    </div>
  );
}

const centeredState = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#999',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '12px',
  textAlign: 'center',
  padding: '16px',
};

function buttonStyle(active, disabled = false) {
  return {
    padding: '4px 8px',
    border: active ? '1px solid #0066cc' : '1px solid #ccc',
    borderRadius: '4px',
    background: active ? '#e6f0ff' : '#fff',
    color: disabled ? '#aaa' : '#333',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    fontSize: '11px',
    fontWeight: active ? 600 : 400,
  };
}

const selectStyle = {
  padding: '3px 6px',
  border: '1px solid #ccc',
  borderRadius: '4px',
  background: '#fff',
  color: '#333',
  fontSize: '11px',
  cursor: 'pointer',
};

export default FeatureSpaceChart;

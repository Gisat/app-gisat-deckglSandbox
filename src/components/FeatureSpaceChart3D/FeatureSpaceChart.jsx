import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ATTRIBUTES,
  AXIS_KEYS,
  COLOR_KEYS,
  DEFAULT_CUSTOM_AXES,
  DEFAULT_PRESET,
  PRESET_KEYS,
  PRESETS,
  PROFILE_AXIS_KEYS,
  PROFILE_DEFAULTS,
  PROFILE_VIEW_DEFAULT,
  TREND_LINES_DEFAULT,
  SIZE_KEYS,
  formatValue,
  resolveAxes,
} from './attributes';
import { activeFieldsFor, transformPoints } from './transformPoints';
import { SIZE_PIXEL_RANGE, buildColorScale, getColorDomain, getSizeDomain } from './colorScale';
import { DISPLACEMENT_DOMAIN, DISPLACEMENT_RAMP } from './profileGeometry';

const PlotlyRenderer = lazy(() => import('./renderers/PlotlyRenderer'));
const DeckGLRenderer = lazy(() => import('./renderers/DeckGLRenderer'));
const ThreeRenderer = lazy(() => import('./renderers/ThreeRenderer'));

const RENDERERS = [
  { key: 'plotly', label: 'Plotly', note: 'billboard markers' },
  { key: 'deckgl', label: 'deck.gl', note: 'OrbitView' },
  { key: 'three', label: 'three.js', note: 'r3f + drei' },
];

const RENDERER_COMPONENTS = {
  plotly: PlotlyRenderer,
  deckgl: DeckGLRenderer,
  three: ThreeRenderer,
};

/**
 * 3D feature-space chart with two mutually exclusive modes:
 *  - `scatter`: the feature-space point cloud (default).
 *  - `profile`: 3D line profile over the drawn line selection, in one of two
 *    views — `Attribute` (X = distance, selectable Y/Z, Z band) or `Trend`
 *    (X = distance, Y = trend window, Z = displacement; windows or points).
 *
 * Portable module: consumes a GeoJSON FeatureCollection, a precomputed profile
 * sample list and a hover callback only. It intentionally imports nothing from
 * src/maps/*.
 *
 * @param {Object} props
 * @param {any} props.featureCollection  GeoJSON FeatureCollection of selected points
 * @param {Array<any>} [props.profileSamples]  precomputed ordered line samples (app-owned)
 * @param {boolean} [props.showProfile]  expose the 3D line-profile mode (only when a line is drawn)
 * @param {(id: string|null) => void} [props.onPointHover]  map-link hover callback
 * @param {'plotly'|'deckgl'|'three'} [props.defaultRenderer]
 * @param {string} [props.title]
 */
export function FeatureSpaceChart({
  featureCollection,
  profileSamples = [],
  showProfile = false,
  onPointHover,
  defaultRenderer = 'plotly',
  title = '3D feature space',
}) {
  const [renderer, setRenderer] = useState(defaultRenderer);
  const [presetKey, setPresetKey] = useState(DEFAULT_PRESET);
  const [customAxes, setCustomAxes] = useState(DEFAULT_CUSTOM_AXES);
  const [markerStyle, setMarkerStyle] = useState('sphere');

  const [mode, setMode] = useState(showProfile ? 'profile' : 'scatter');
  const [profileView, setProfileView] = useState(PROFILE_VIEW_DEFAULT);
  const [trendLines, setTrendLines] = useState(TREND_LINES_DEFAULT);
  const [yKey, setYKey] = useState(PROFILE_DEFAULTS.y);
  const [zKey, setZKey] = useState(PROFILE_DEFAULTS.z);

  // Default to the 3D line profile whenever the line tool is active (or a line
  // has been drawn); the user can still switch back to scatter.
  useEffect(() => {
    if (showProfile) setMode('profile');
  }, [showProfile]);

  const axes = useMemo(() => resolveAxes(presetKey, customAxes), [presetKey, customAxes]);
  const activeFields = useMemo(() => activeFieldsFor(axes), [axes]);

  const { points, skipped, total } = useMemo(
    () => transformPoints(featureCollection, activeFields),
    [featureCollection, activeFields],
  );

  const colorDomain = useMemo(() => getColorDomain(axes.color, points), [axes.color, points]);
  const colorScale = useMemo(() => buildColorScale(axes.color, colorDomain), [axes.color, colorDomain]);
  const sizeDomain = useMemo(() => getSizeDomain(axes.size, points), [axes.size, points]);

  // The profile mode only exists while the line tool is in use; otherwise the
  // panel falls back to scatter even if `mode` state was left on 'profile'.
  const activeMode = showProfile ? mode : 'scatter';

  const profile = useMemo(
    () =>
      activeMode === 'profile' && profileSamples.length > 0
        ? { view: profileView, yKey, zKey, trendLines, samples: profileSamples }
        : null,
    [activeMode, profileView, trendLines, yKey, zKey, profileSamples],
  );

  const profileSampleCount = profileSamples.length;

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
            alignItems: 'flex-end',
            padding: '8px 12px',
            borderBottom: '1px solid #eee',
            background: '#fafafa',
          }}
        >
          <div style={{ display: 'flex', gap: '3px' }} title="Profile view">
            <button onClick={() => setProfileView('attributes')} style={buttonStyle(profileView === 'attributes')}>
              Attribute
            </button>
            <button onClick={() => setProfileView('trend')} style={buttonStyle(profileView === 'trend')}>
              Trend
            </button>
          </div>
          {profileView === 'attributes' ? (
            <>
              <label style={axisPickerStyle}>
                <span style={axisPickerLabel}>Y axis</span>
                <select value={yKey} onChange={(e) => setYKey(e.target.value)} style={selectStyle}>
                  {PROFILE_AXIS_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {ATTRIBUTES[key].label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={axisPickerStyle}>
                <span style={axisPickerLabel}>Z axis (up)</span>
                <select
                  value={zKey}
                  onChange={(e) => setZKey(e.target.value)}
                  style={selectStyle}
                  title={ATTRIBUTES[zKey]?.stdKey ? `Band: ${ATTRIBUTES[zKey].stdKey} (indicative)` : 'No uncertainty band for this attribute'}
                >
                  {PROFILE_AXIS_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {ATTRIBUTES[key].label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }} title="Trend shape">
                <button
                  onClick={() => setTrendLines('windows')}
                  style={buttonStyle(trendLines === 'windows')}
                  title="One line per window, with its ±1σ band"
                >
                  windows ±σ
                </button>
                <button
                  onClick={() => setTrendLines('windows-plain')}
                  style={buttonStyle(trendLines === 'windows-plain')}
                  title="One line per window, no band (same Z scale as points)"
                >
                  windows
                </button>
                <button onClick={() => setTrendLines('points')} style={buttonStyle(trendLines === 'points')}>
                  points
                </button>
              </div>
              {trendLines === 'points' && (
                <div style={{ display: 'flex', flexBasis: '100%', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '10px', color: '#666' }}>displacement</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: '80px',
                      height: '8px',
                      borderRadius: '4px',
                      background: `linear-gradient(to right, ${DISPLACEMENT_RAMP.join(', ')})`,
                    }}
                  />
                  <span style={{ fontSize: '10px', color: '#666' }}>
                    {`${formatValue('TD_365', DISPLACEMENT_DOMAIN[0])} \u2013 ${formatValue('TD_365', DISPLACEMENT_DOMAIN[1])}`}
                  </span>
                </div>
              )}
            </>
          )}
          <span style={{ flexBasis: '100%', fontSize: '10px', color: '#999' }}>
            {profileView === 'trend'
              ? 'Trend windows are overlapping cumulative windows; the axis is ordered, not linear time.'
              : zKey === 'VEL_REL'
                ? 'Z defaults to relative velocity (mm/yr) \u2014 this dataset has no true vertical-rate field; the band is indicative.'
                : ATTRIBUTES[zKey]?.stdKey
                  ? `Z band: ${ATTRIBUTES[zKey].stdKey}.`
                  : 'No uncertainty band for this attribute.'}
          </span>
          {profileView === 'trend' && trendLines === 'windows' && (
            <span style={{ flexBasis: '100%', fontSize: '10px', color: '#999' }}>
              {'The shaded band is the \u00b11\u03c3 uncertainty of each window\u2019s trend displacement; it widens for longer windows because a longer accumulation carries more error.'}
            </span>
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
          profileSamples.length === 0 ? (
            <ProfileEmptyState />
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

function ProfileEmptyState() {
  return (
    <div style={centeredState}>
      <div style={{ fontWeight: 600, marginBottom: '6px', color: '#666' }}>No line profile yet</div>
      <div style={{ color: '#999', fontSize: '11px', textAlign: 'center', maxWidth: '260px' }}>
        Draw a line selection on the map to see the profile.
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

const axisPickerStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
};

const axisPickerLabel = {
  fontSize: '10px',
  color: '#666',
  textTransform: 'uppercase',
};

export default FeatureSpaceChart;

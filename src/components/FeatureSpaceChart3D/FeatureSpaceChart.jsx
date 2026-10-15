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
  { key: 'deckgl', label: 'Deck.gl', note: 'OrbitView' },
  { key: 'three', label: 'Three.js', note: 'r3f + drei' },
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
 * @param {boolean} [props.showProfile]  a line tool is active or a line has been drawn (auto-selects the profile mode)
 * @param {boolean} [props.profileDisabled]  disable the mode toggle (a polygon/circle selection is in use)
 * @param {(id: string|null) => void} [props.onPointHover]  map-link hover callback
 * @param {(state: {mode:'scatter'|'profile', view:'attributes'|'trend', zKey:string, basis:'along'|'plan', trendLines:'windows'|'windows-plain'|'points'}|null) => void} [props.onStateChange]  reports the effective mode/view/zKey/basis/trend shape (null on unmount)
 * @param {'plotly'|'deckgl'|'three'} [props.defaultRenderer]
 * @param {string} [props.title]
 */
export function FeatureSpaceChart({
  featureCollection,
  profileSamples = [],
  showProfile = false,
  profileDisabled = false,
  onPointHover,
  onStateChange,
  defaultRenderer = 'plotly',
  title = '3D feature space',
}) {
  const [renderer, setRenderer] = useState(defaultRenderer);
  const [presetKey, setPresetKey] = useState(DEFAULT_PRESET);
  const [customAxes, setCustomAxes] = useState(DEFAULT_CUSTOM_AXES);
  const [markerStyle, setMarkerStyle] = useState('sphere');

  const [mode, setMode] = useState(showProfile ? 'profile' : 'scatter');
  const [profileView, setProfileView] = useState(PROFILE_VIEW_DEFAULT);
  const [basis, setBasis] = useState(PROFILE_DEFAULTS.basis);
  const [trendLines, setTrendLines] = useState(TREND_LINES_DEFAULT);
  const [yKey, setYKey] = useState(PROFILE_DEFAULTS.y);
  const [zKey, setZKey] = useState(PROFILE_DEFAULTS.z);
  const [zPlanKey, setZPlanKey] = useState(PROFILE_DEFAULTS.zPlan);

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

  // The mode toggle is always shown, but a polygon/circle selection has no line
  // to profile, so the profile mode is disabled and the panel falls back to
  // scatter even if `mode` state was left on 'profile'.
  const activeMode = profileDisabled ? 'scatter' : mode;

  // The Lon/Lat basis fixes X/Y to lon/lat and uses its own Z pick, so keep the two
  // bases' Z selections independent.
  const activeZKey = basis === 'plan' ? zPlanKey : zKey;

  const profile = useMemo(
    () =>
      activeMode === 'profile' && profileSamples.length > 0
        ? { view: profileView, basis, yKey, zKey: activeZKey, trendLines, samples: profileSamples }
        : null,
    [activeMode, profileView, basis, activeZKey, trendLines, yKey, profileSamples],
  );

  const profileSampleCount = profileSamples.length;

  // Expose the effective mode/view/Z/basis to the host map (drives the 3D
  // curtain). Primitives only, so this fires on real changes; the parent must
  // pass a stable handler to avoid an update loop. On unmount clear it so the
  // curtain hides when the chart panel is closed.
  useEffect(() => {
    if (onStateChange) onStateChange({ mode: activeMode, view: profileView, zKey: activeZKey, basis, trendLines });
  }, [onStateChange, activeMode, profileView, activeZKey, basis, trendLines]);

  useEffect(() => () => {
    if (onStateChange) onStateChange(null);
  }, [onStateChange]);

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
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          padding: '6px 12px',
          borderBottom: '1px solid #eee',
          flexWrap: 'wrap',
        }}
        title={
          profileDisabled
            ? 'Line profile needs a line selection'
            : 'Chart mode'
        }
      >
        <button
          onClick={() => setMode('scatter')}
          style={buttonStyle(activeMode === 'scatter', profileDisabled)}
        >
          Scatter
        </button>
        <button
          onClick={() => setMode('profile')}
          style={buttonStyle(activeMode === 'profile', profileDisabled)}
        >
          3D line profile
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '6px 12px',
          borderBottom: '1px solid #eee',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: '3px' }}>
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
          style={{ display: 'flex', gap: '3px', marginLeft: 'auto' }}
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
            Circles
          </button>
          <button
            disabled={renderer === 'plotly'}
            onClick={() => setMarkerStyle('sphere')}
            style={buttonStyle(effectiveMarker === 'sphere', renderer === 'plotly')}
          >
            Spheres
          </button>
        </div>
      </div>

      {activeMode === 'scatter' && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            padding: '6px 12px',
            borderBottom: '1px solid #eee',
            flexWrap: 'wrap',
          }}
          title="Axis preset"
        >
          {PRESET_KEYS.map((key) => (
            <button
              key={key}
              onClick={() => setPresetKey(key)}
              style={buttonStyle(presetKey === key)}
            >
              {key === 'custom' ? 'Custom' : PRESETS[key].label}
            </button>
          ))}
        </div>
      )}

      {activeMode === 'profile' && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
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

          <div
            style={{ display: 'flex', gap: '3px' }}
            title={profileView === 'attributes' ? 'Horizontal-plane basis: lon/lat vs custom' : 'Trend shape'}
          >
            {profileView === 'attributes' ? (
              <>
                <button onClick={() => setBasis('plan')} style={buttonStyle(basis === 'plan')}>
                  Lon/Lat
                </button>
                <button onClick={() => setBasis('along')} style={buttonStyle(basis === 'along')}>
                  Custom
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setTrendLines('windows')}
                  style={buttonStyle(trendLines === 'windows')}
                  title="One line per window, with its ±1σ band"
                >
                  Windows ±σ
                </button>
                <button
                  onClick={() => setTrendLines('windows-plain')}
                  style={buttonStyle(trendLines === 'windows-plain')}
                  title="One line per window, no band (same Z scale as points)"
                >
                  Windows
                </button>
                <button onClick={() => setTrendLines('points')} style={buttonStyle(trendLines === 'points')}>
                  Points
                </button>
              </>
            )}
          </div>

          {profileView === 'attributes' && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'flex-end' }}>
              {basis === 'along' ? (
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
              ) : (
                <span
                  style={axisPickerStyle}
                  title="Lon/Lat basis: X = longitude, Y = latitude (equal ground scale)"
                >
                  <span style={axisPickerLabel}>X / Y axis</span>
                  <span style={{ fontSize: '11px', color: '#333' }}>Longitude / Latitude</span>
                </span>
              )}
              <label style={axisPickerStyle}>
                <span style={axisPickerLabel}>Z axis (up)</span>
                <select
                  value={activeZKey}
                  onChange={(e) => (basis === 'plan' ? setZPlanKey(e.target.value) : setZKey(e.target.value))}
                  style={selectStyle}
                  title={ATTRIBUTES[activeZKey]?.stdKey ? `Band: ${ATTRIBUTES[activeZKey].stdKey} (indicative)` : 'No uncertainty band for this attribute'}
                >
                  {PROFILE_AXIS_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {ATTRIBUTES[key].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {profileView === 'trend' && trendLines === 'points' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
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

          <span style={{ fontSize: '10px', color: '#999' }}>
            {profileView === 'trend'
              ? 'Trend windows are overlapping cumulative windows; the axis is ordered, not linear time.'
              : `${
                  basis === 'plan'
                    ? 'Lon/Lat view: X = longitude, Y = latitude on an equal ground scale. '
                    : ''
                }${
                  ATTRIBUTES[activeZKey]?.stdKey
                    ? `The shaded ribbon is the Z \u00b1 ${ATTRIBUTES[activeZKey].stdKey} (\u00b11\u03c3) uncertainty band.`
                    : 'No uncertainty ribbon for this attribute.'
                }${
                  activeZKey === 'VEL_REL'
                    ? ' Relative velocity is a LOS proxy (this dataset has no true vertical-rate field) and the VEL_SD pairing is unconfirmed \u2014 treat the band as indicative.'
                    : ''
                }`}
          </span>
          {profileView === 'trend' && trendLines === 'windows' && (
            <span style={{ fontSize: '10px', color: '#999' }}>
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

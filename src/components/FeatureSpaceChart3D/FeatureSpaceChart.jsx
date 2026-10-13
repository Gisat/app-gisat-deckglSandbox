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

/**
 * 3D feature-space scatter chart.
 *
 * Portable module: consumes a GeoJSON FeatureCollection and hover callback only.
 * It intentionally imports nothing from src/maps/*.
 *
 * @param {Object} props
 * @param {any} props.featureCollection  GeoJSON FeatureCollection of selected points
 * @param {(id: string|null) => void} [props.onPointHover]  map-link hover callback
 * @param {'plotly'|'deckgl'|'three'} [props.defaultRenderer]
 * @param {string} [props.title]
 */
export function FeatureSpaceChart({
  featureCollection,
  onPointHover,
  defaultRenderer = 'plotly',
  title = '3D feature space',
}) {
  const [renderer, setRenderer] = useState(defaultRenderer);
  const [presetKey, setPresetKey] = useState(DEFAULT_PRESET);
  const [customAxes, setCustomAxes] = useState(DEFAULT_CUSTOM_AXES);
  const [collapsed, setCollapsed] = useState(false);
  const [markerStyle, setMarkerStyle] = useState('sphere');

  const axes = useMemo(() => resolveAxes(presetKey, customAxes), [presetKey, customAxes]);
  const activeFields = useMemo(() => activeFieldsFor(axes), [axes]);

  const { points, skipped, total } = useMemo(
    () => transformPoints(featureCollection, activeFields),
    [featureCollection, activeFields],
  );

  const colorDomain = useMemo(() => getColorDomain(axes.color, points), [axes.color, points]);
  const colorScale = useMemo(() => buildColorScale(axes.color, colorDomain), [axes.color, colorDomain]);
  const sizeDomain = useMemo(() => getSizeDomain(axes.size, points), [axes.size, points]);

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

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: collapsed ? 'auto' : 'min(45%, 720px)',
        minWidth: collapsed ? 0 : '380px',
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
          borderBottom: collapsed ? 'none' : '1px solid #eee',
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
          {points.length} pts
        </span>
        {skipped > 0 && (
          <span
            title={`${skipped} of ${total} points skipped (missing value for an active axis/color/size field)`}
            style={{ color: '#b45309', fontSize: '11px' }}
          >
            {skipped} skipped
          </span>
        )}

        {!collapsed && (
          <>
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
          </>
        )}

        <button
          onClick={() => setCollapsed((c) => !c)}
          style={{ ...buttonStyle(false), marginLeft: collapsed ? 'auto' : 0 }}
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? '\u2039' : '\u203a'}
        </button>
      </div>

      {!collapsed && (
        <>
          {presetKey === 'custom' && (
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
            {points.length === 0 ? (
              <EmptyState total={total} skipped={skipped} />
            ) : (
              <Suspense fallback={<LoadingState renderer={renderer} />}>
                <Renderer {...rendererProps} />
              </Suspense>
            )}
          </div>

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
              {axes.color === 'vel_rel' ? ' (map scale)' : ` (${formatValue(axes.color, colorDomain[0])} \u2013 ${formatValue(axes.color, colorDomain[1])})`}
            </span>
            <span>
              Size: {ATTRIBUTES[axes.size].label}
              {axes.size === 'coh' ? ' (fixed 0\u20131)' : ''}
            </span>
          </div>
        </>
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

import { COLOR_ATTRIBUTES } from './trackColorScales';
import ScalePicker from './ScalePicker';

const trackLabel = (track) => `${track.id} ${track.orbit === 'A' ? '↑' : '↓'}`;

// Small monochrome cue for the shape drawn by the active Track shapes view.
// It inherits the text colour, so failed tracks still read red.
function TrackSymbolIcon({ shape }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {shape === 'sphere' && (
        <>
          <circle cx="6" cy="6" r="4" />
          <ellipse cx="6" cy="6" rx="1.8" ry="4" />
        </>
      )}
      {shape === 'cube' && (
        <>
          <path d="M6 1.6 10.2 3.7v5L6 10.8 1.8 8.7v-5Z" />
          <path d="M1.8 3.7 6 5.8l4.2-2.1M6 5.8v5" />
        </>
      )}
      {shape === 'cone' && (
        <>
          <path d="M6 1.6 2.2 9.2M6 1.6l3.8 7.6" />
          <ellipse cx="6" cy="9.2" rx="3.8" ry="1.2" />
        </>
      )}
    </svg>
  );
}

/**
 * One track card in the top-left panel: enable/disable, Color by and Scale.
 *
 * Controls stay interactive while the track is off so it can be configured
 * before enabling. Attribute availability is unknown until the track reaches
 * `ready`; only then are missing attributes disabled and labelled.
 *
 * @param {Object} props
 * @param {Object} props.track
 * @param {boolean} props.enabled
 * @param {{ status?: string, error?: string, colorStats?: Object }|undefined} props.state
 * @param {{ attribute: string, scaleId: string }} props.settings
 * @param {{ attribute: string, scaleDef: Object }} props.colorConfig
 * @param {(trackId: string) => void} props.onToggle
 * @param {(trackId: string, attribute: string) => void} props.onAttributeChange
 * @param {(trackId: string, scaleId: string) => void} props.onScaleChange
 * @param {boolean} props.showSymbol
 */
export default function TrackColorSection({
  track,
  enabled,
  state,
  settings,
  colorConfig,
  onToggle,
  onAttributeChange,
  onScaleChange,
  showSymbol,
}) {
  const isReady = state?.status === 'ready';
  const isLoading = enabled && state?.status === 'loading';
  const hasFailed = enabled && state?.status === 'error';
  const unavailable = isReady ? settings.attribute !== colorConfig.attribute : false;

  return (
    <div
      style={{
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: '6px 8px',
        background: '#fff',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <label
        title={hasFailed
          ? `${track.id} (${track.direction}) failed to load: ${state.error} Click to retry.`
          : `${track.id} (${track.direction}, ${track.symbolLabel})`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11,
          fontWeight: enabled ? 600 : 500,
          color: hasFailed ? '#a00000' : '#333',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={() => onToggle(track.id)}
          style={{ margin: 0, cursor: 'pointer', accentColor: hasFailed ? '#a00000' : '#0066cc' }}
        />
        {showSymbol && <TrackSymbolIcon shape={track.symbol} />}
        <span>{trackLabel(track)}</span>
        {isLoading && <span style={{ fontWeight: 400, color: '#777' }}>loading…</span>}
        {hasFailed && <span style={{ fontWeight: 400 }}>failed</span>}
      </label>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <label
          htmlFor={`mintarder-color-by-${track.id}`}
          style={{ color: '#555', whiteSpace: 'nowrap' }}
        >
          Color by
        </label>
        <select
          id={`mintarder-color-by-${track.id}`}
          value={colorConfig.attribute}
          onChange={(event) => onAttributeChange(track.id, event.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '3px 6px',
            border: '1px solid #bbb',
            borderRadius: 4,
            background: '#fff',
            color: '#333',
            fontFamily: 'inherit',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {COLOR_ATTRIBUTES.map((def) => {
            const available = !isReady || state.colorStats?.[def.key]?.available;
            return (
              <option key={def.key} value={def.key} disabled={!available}>
                {def.label}{available ? '' : ' (not in dataset)'}
              </option>
            );
          })}
        </select>
      </div>

      {unavailable && (
        <div style={{ color: '#8a5a00', fontSize: 10 }}>
          {settings.attribute} not in this track; using {colorConfig.attribute}.
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: '#555', whiteSpace: 'nowrap' }}>Scale</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ScalePicker
            value={settings.scaleId}
            onChange={(scaleId) => onScaleChange(track.id, scaleId)}
          />
        </div>
      </div>
    </div>
  );
}

import { COLOR_DOMAIN, colorScale } from '../../layers/displacementScale';
import { SMOOTH_OPTIONS } from './snakeGeometry';

function formatDate(epochMs) {
    return Number.isFinite(epochMs)
        ? new Date(epochMs).toISOString().slice(0, 10)
        : '—';
}

function OptionButton({ active, onClick, label }) {
    return (
        <button
            type="button"
            onClick={onClick}
            style={{
                padding: '4px 6px',
                border: active ? '2px solid #0066cc' : '1px solid #ccc',
                borderRadius: '4px',
                background: active ? '#e6f0ff' : '#fff',
                color: '#333',
                cursor: 'pointer',
                fontSize: '10px',
                fontWeight: active ? '600' : '400',
                flex: '1',
                minWidth: '34px',
                lineHeight: 1.2,
            }}
        >
            {label}
        </button>
    );
}

function OptionRow({ label, children }) {
    return (
        <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', marginBottom: '4px' }}>
                {label}
            </div>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                {children}
            </div>
        </div>
    );
}

function ToggleRow({ label, checked, onChange }) {
    return (
        <label
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: '11px',
                cursor: 'pointer',
                marginBottom: '8px',
                userSelect: 'none',
            }}
        >
            <input
                type="checkbox"
                checked={checked}
                onChange={event => onChange(event.target.checked)}
                style={{ cursor: 'pointer', width: '14px', height: '14px' }}
            />
            {label}
        </label>
    );
}

/** Compact duplicate of the bottom-left displacement ramp, so the panel is self-contained. */
function ColorStrip({ projectionMode }) {
    const stops = [];
    const [min, , max] = COLOR_DOMAIN;
    for (let i = 0; i <= 10; i++) {
        const value = min + ((max - min) * i) / 10;
        const rgb = colorScale(value);
        stops.push(`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]}) ${i * 10}%`);
    }

    return (
        <div style={{ marginBottom: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: '600', marginBottom: '4px' }}>
                {projectionMode === 'vertical'
                    ? 'Vertical equiv. displacement (mm)'
                    : 'LOS (slant-range) displacement (mm)'}
            </div>
            <div
                style={{
                    height: '10px',
                    borderRadius: '3px',
                    border: '1px solid #ddd',
                    background: `linear-gradient(to right, ${stops.join(', ')})`,
                }}
            />
            <div
                style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '9px',
                    color: '#666',
                    marginTop: '2px',
                }}
            >
                <span>{COLOR_DOMAIN[0]}</span>
                <span>0</span>
                <span>+{COLOR_DOMAIN[COLOR_DOMAIN.length - 1]}</span>
            </div>
        </div>
    );
}

/**
 * Time-snake controls. Mirrors `SelectionControls` styling and sits top-right.
 */
export function SnakeViewControls({
    smoothDays,
    onSmoothDaysChange,
    timeScale,
    onTimeScaleChange,
    timeHeightM,
    suggestedTimeHeightM,
    leanScale,
    onLeanScaleChange,
    leanMPerMm,
    suggestedLeanMPerMm,
    thicknessScale = 1,
    onThicknessScaleChange,
    widthByCoherence,
    onWidthByCoherenceChange,
    flipLean,
    onFlipLeanChange,
    projectionMode = 'los',
    onProjectionModeChange,
    showSlicePlane,
    onShowSlicePlaneChange,
    onRefit,
    onExit,
    usedFeatures = 0,
    totalFeatures = 0,
    timeRange = null,
    timestepCount = 0,
    sampleCount = 160,
}) {
    const smoothLabel = smoothDays > 0 ? `${smoothDays} d` : 'Off';

    return (
        <div
            style={{
                position: 'absolute',
                top: '130px',
                right: '10px',
                width: '248px',
                maxHeight: 'calc(100vh - 160px)',
                overflowY: 'auto',
                background: 'rgba(255, 255, 255, 0.96)',
                borderRadius: '8px',
                padding: '12px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                zIndex: 1000,
                fontFamily: 'system-ui, sans-serif',
                fontSize: '13px',
                color: '#333',
            }}
        >
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '10px',
                }}
            >
                <div style={{ fontSize: '12px', fontWeight: 'bold' }}>
                    3D time-snake
                </div>
                <button
                    type="button"
                    onClick={onExit}
                    style={{
                        padding: '4px 8px',
                        background: '#f0f0f0',
                        border: '1px solid #ddd',
                        borderRadius: '3px',
                        cursor: 'pointer',
                        fontSize: '11px',
                        fontWeight: '600',
                        color: '#333',
                    }}
                >
                    Exit 3D
                </button>
            </div>

            <div
                style={{
                    padding: '6px 8px',
                    background: '#e6f0ff',
                    borderRadius: '4px',
                    fontSize: '10px',
                    lineHeight: 1.5,
                    color: '#0066cc',
                    fontWeight: '600',
                    marginBottom: '10px',
                }}
            >
                <div>
                    showing {usedFeatures} of {totalFeatures} points
                </div>
                <div style={{ fontWeight: '400' }}>
                    {formatDate(timeRange?.startMs)} → {formatDate(timeRange?.endMs)}
                </div>
                <div style={{ fontWeight: '400' }}>
                    {timestepCount} timesteps / {sampleCount} samples • smooth {smoothLabel}
                </div>
            </div>

            <OptionRow label="Smoothing (days)">
                {SMOOTH_OPTIONS.map(days => (
                    <OptionButton
                        key={days}
                        active={smoothDays === days}
                        onClick={() => onSmoothDaysChange(days)}
                        label={days === 0 ? 'Off' : String(days)}
                    />
                ))}
            </OptionRow>

            <OptionRow label="Displacement projection">
                <OptionButton
                    active={projectionMode !== 'vertical'}
                    onClick={() => onProjectionModeChange('los')}
                    label="LOS (slant-range)"
                />
                <OptionButton
                    active={projectionMode === 'vertical'}
                    onClick={() => onProjectionModeChange('vertical')}
                    label="Vertical equiv."
                />
            </OptionRow>

            <OptionRow label={`Time height: ${Math.round(timeHeightM)} m`}>
                {[0.5, 1, 2].map(scale => (
                    <OptionButton
                        key={scale}
                        active={timeScale === scale}
                        onClick={() => onTimeScaleChange(scale)}
                        label={`${scale}×`}
                    />
                ))}
            </OptionRow>
            <div style={{ fontSize: '9px', color: '#888', marginTop: '-6px', marginBottom: '8px' }}>
                adaptive {Math.round(suggestedTimeHeightM)} m
            </div>

            <OptionRow label={`Lean: ${leanMPerMm.toFixed(1)} m per mm`}>
                {[0.5, 1, 2, 4].map(scale => (
                    <OptionButton
                        key={scale}
                        active={leanScale === scale}
                        onClick={() => onLeanScaleChange(scale)}
                        label={`${scale}×`}
                    />
                ))}
            </OptionRow>
            <div style={{ fontSize: '9px', color: '#888', marginTop: '-6px', marginBottom: '8px' }}>
                adaptive {suggestedLeanMPerMm.toFixed(1)} m per mm
            </div>

            <OptionRow label={`Thickness: ${thicknessScale}×`}>
                {[0.5, 1, 2, 3].map(scale => (
                    <OptionButton
                        key={scale}
                        active={thicknessScale === scale}
                        onClick={() => onThicknessScaleChange(scale)}
                        label={`${scale}×`}
                    />
                ))}
            </OptionRow>

            <ToggleRow
                label="Width by temporal coherence"
                checked={widthByCoherence}
                onChange={onWidthByCoherenceChange}
            />
            <ToggleRow
                label="Flip lean direction"
                checked={flipLean}
                onChange={onFlipLeanChange}
            />
            <ToggleRow
                label="Show time slice plane (static)"
                checked={showSlicePlane}
                onChange={onShowSlicePlaneChange}
            />

            <button
                type="button"
                onClick={onRefit}
                style={{
                    width: '100%',
                    padding: '6px 8px',
                    marginBottom: '10px',
                    background: '#f0f0f0',
                    border: '1px solid #ddd',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '11px',
                    fontWeight: '600',
                    color: '#333',
                }}
            >
                Refit view
            </button>

            <ColorStrip projectionMode={projectionMode} />

            <div
                style={{
                    fontSize: '9px',
                    color: '#666',
                    display: 'flex',
                    justifyContent: 'space-between',
                }}
            >
                <span>↑ last acquisition</span>
                <span>↓ first acquisition</span>
            </div>
            <div style={{ fontSize: '9px', color: '#999', marginTop: '4px' }}>
                {projectionMode === 'vertical'
                    ? 'Assuming pure vertical motion (d_LOS ÷ los_up ≈ 1.29×), displayed laterally along the look azimuth because Z is time.'
                    : 'Height is linear in real time; lateral lean (along ~260° WSW look azimuth) and color show smoothed 1D slant-range LOS displacement relative to the first acquisition.'}
            </div>
        </div>
    );
}

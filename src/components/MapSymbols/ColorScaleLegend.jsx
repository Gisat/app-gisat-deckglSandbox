/**
 * ColorScaleLegend - compact floating legend for a linear colour scale.
 *
 * `d3-scale` has no `colors()` helper (that is a chroma scale), so the gradient
 * is built by sampling the scale at evenly spaced values across the domain. The
 * sampled colours therefore always match the exact ramp used by the map layers.
 *
 * The bar is a continuous gradient sampled from the same scale the map uses, so
 * the card reads like the layer colours instead of a quantised set of classes.
 * `width`, `subtitle`, `tooltip` and `signed` are optional and default to the
 * original card look, so existing callers are unaffected.
 *
 * Purely presentational and read-only: the card ignores pointer events unless a
 * `tooltip` is supplied, so it never blocks panning behind it by default.
 *
 * @param {Object} props
 * @param {Function} props.colorScale - d3 linear scale: value -> [r, g, b].
 * @param {number[]} props.domain - Scale domain, expected as [min, mid, max].
 * @param {string} props.title - Card heading, e.g. 'LOS displacement (mm)'.
 * @param {string|null} [props.subtitle] - Optional second heading line.
 * @param {string|null} [props.tooltip] - Optional tooltip for the whole card.
 * @param {number|null} [props.width] - Fixed card width in pixels.
 * @param {boolean} [props.signed] - Prefix positive ticks with `+` (default true).
 * @param {number} [props.stops] - Number of sampled gradient stops (default 11).
 */
const LEGEND_STOPS = 11;

export function ColorScaleLegend({
    colorScale,
    domain,
    title,
    subtitle = null,
    tooltip = null,
    width = null,
    signed = true,
    stops = LEGEND_STOPS,
}) {
    const [min, mid, max] = domain;

    const gradient = `linear-gradient(to right, ${Array.from({ length: stops }, (_, i) => {
        const value = min + (i * (max - min)) / (stops - 1);
        const rgb = colorScale(value);
        return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }).join(', ')})`;

    const formatTick = (value) => (signed && value > 0 ? `+${value}` : `${value}`);

    const widthStyle = width != null
        ? { width, minWidth: width, maxWidth: width, boxSizing: 'border-box' }
        : { minWidth: '170px' };

    return (
        <div
            title={tooltip ?? undefined}
            style={{
                pointerEvents: tooltip ? 'auto' : 'none',
                background: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                padding: '8px 10px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '11px',
                color: '#333',
                ...widthStyle,
            }}
        >
            {subtitle ? (
                <>
                    <div style={{ fontWeight: 600, lineHeight: 1.25 }}>{title}</div>
                    <div
                        style={{
                            color: '#555',
                            fontSize: '10px',
                            lineHeight: 1.25,
                            marginBottom: '4px',
                        }}
                    >
                        {subtitle}
                    </div>
                </>
            ) : (
                <div style={{ marginBottom: '4px', fontWeight: 600 }}>{title}</div>
            )}
            <div
                aria-hidden="true"
                style={{
                    width: '100%',
                    height: '10px',
                    borderRadius: '2px',
                    background: gradient
                }}
            />
            <div style={{ display: 'flex', marginTop: '2px', color: '#555', fontSize: '10px' }}>
                <span style={{ flex: 1, textAlign: 'left' }}>{formatTick(min)}</span>
                <span style={{ flex: 1, textAlign: 'center' }}>{formatTick(mid)}</span>
                <span style={{ flex: 1, textAlign: 'right' }}>{formatTick(max)}</span>
            </div>
        </div>
    );
}

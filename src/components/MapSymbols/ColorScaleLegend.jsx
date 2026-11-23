/**
 * ColorScaleLegend - compact floating legend for a d3 linear color scale.
 *
 * `d3-scale` has no `colors()` helper (that is a chroma scale), so the gradient
 * is built by sampling the scale at evenly spaced values across the domain. The
 * sampled colours therefore always match the exact ramp used by the map layers.
 *
 * Purely presentational and read-only: the card ignores pointer events so it
 * never blocks panning behind it.
 *
 * @param {Object} props
 * @param {Function} props.colorScale - d3 linear scale: value -> [r, g, b].
 * @param {number[]} props.domain - Scale domain, expected as [min, mid, max].
 * @param {string} props.title - Card heading, e.g. 'LOS displacement (mm)'.
 * @param {number} [props.stops] - Number of sampled gradient stops (default 11).
 */
const LEGEND_STOPS = 11;

export function ColorScaleLegend({ colorScale, domain, title, stops = LEGEND_STOPS }) {
    const [min, mid, max] = domain;

    const gradient = `linear-gradient(to right, ${Array.from({ length: stops }, (_, i) => {
        const value = min + (i * (max - min)) / (stops - 1);
        const rgb = colorScale(value);
        return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    }).join(', ')})`;

    const formatTick = (value) => (value > 0 ? `+${value}` : `${value}`);

    return (
        <div
            style={{
                pointerEvents: 'none',
                background: 'rgba(255, 255, 255, 0.95)',
                borderRadius: '8px',
                padding: '8px 10px',
                boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
                fontFamily: 'system-ui, sans-serif',
                fontSize: '11px',
                color: '#333',
                minWidth: '170px'
            }}
        >
            <div style={{ marginBottom: '4px', fontWeight: 600 }}>
                {title}
            </div>
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

/**
 * LegendOverlay - floating lower-left wrapper for the displacement legend.
 *
 * Positioned clear of the map's own bottom-left cards. `lifted` moves it above
 * the line-profile / time-series chart when a selection card is open.
 *
 * Read-only: pointer events are disabled on the wrapper (not only the card) so
 * pan and drawing gestures pass through to the map.
 *
 * @param {Object} props
 * @param {boolean} [props.lifted] - Lift the legend above the bottom chart.
 * @param {React.ReactNode} props.children - Legend card to render.
 */
export function LegendOverlay({ lifted = false, children }) {
    return (
        <div
            style={{
                position: 'absolute',
                left: '12px',
                // The line-profile / time-series card is 320 px tall + 24 px
                // padding at bottom: 10px, so lift past it instead of hiding the
                // legend behind the chart.
                bottom: lifted ? '360px' : '12px',
                zIndex: 1000,
                pointerEvents: 'none',
            }}
        >
            {children}
        </div>
    );
}

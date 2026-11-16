// Map-local HUD for the 2D data-service stream map. The shared HUD shows
// Arrow-LOD concepts (tier, cache ratio) that do not apply here; keep its visual
// style so the two maps look consistent.
export const HudPanel = ({ zoom, tileZoom, visiblePoints, datasetPoints, status, tileCount }) => {
    return (
        <div style={{
            position: 'absolute', top: 10, left: 10,
            backgroundColor: 'rgba(255, 255, 255, 0.9)', padding: '10px 15px',
            borderRadius: '8px', boxShadow: '0 2px 10px rgba(0,0,0,0.1)',
            fontFamily: 'monospace', fontSize: '12px', zIndex: 10,
            color: '#333',
            pointerEvents: 'none' // Click through
        }}>
            <div><b>Zoom:</b> {zoom?.toFixed(2)}</div>
            <div><b>Tile:</b> z{tileZoom}</div>
            <div><b>Points:</b> {visiblePoints.toLocaleString()} / {datasetPoints.toLocaleString()}</div>
            <div><b>Status:</b> {status}</div>
            <div><b>Tiles:</b> {tileCount} loaded</div>
        </div>
    );
};

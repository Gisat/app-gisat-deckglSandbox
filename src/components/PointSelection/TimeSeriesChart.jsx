import { useState } from 'react';
import { ResponsiveScatterPlot } from '@nivo/scatterplot';
import './TimeSeriesChart.css';

/**
 * TimeSeriesChart - Reusable scatter plot for visualizing selected point data
 * 
 * Shows mean_velocity vs point index with hover highlighting
 * Fires onPointHover callback to sync with map highlighting
 * 
 * @param {Object} props
 * @param {Object} props.selectedFeatures - GeoJSON FeatureCollection with time-series data
 * @param {boolean} props.isLoading - Whether backend query is in progress
 * @param {Function} props.onPointHover - Called with point_id when hovering (or null when leaving)
 */
export function TimeSeriesChart({ selectedFeatures, isLoading, onPointHover }) {
    const [chartHoveredId, setChartHoveredId] = useState(null);

    if (!selectedFeatures || !selectedFeatures.features || selectedFeatures.features.length === 0) {
        return (
            <div className="DSI-TimeSeriesChart" style={{ display: 'none' }}>
                <div className="DSI-TimeSeriesChart-empty">No data selected</div>
            </div>
        );
    }

    // Transform features to scatter plot format
    const points = selectedFeatures.features.map((feature, index) => ({
        x: index,
        y: feature.properties.mean_velocity || 0,
        id: feature.properties.point_id || feature.id,
        fid: feature.properties.point_id || feature.id,
    }));

    // Find min/max for axes
    const yValues = points.map(p => p.y);
    const yMin = Math.min(...yValues);
    const yMax = Math.max(...yValues);
    const yRange = yMax - yMin;
    const yPadding = yRange * 0.1;

    // Nivo expects data as array of series
    const nivoData = [
        {
            id: 'Selected Points',
            data: points,
        },
    ];

    // Handle point hover
    const handleNodeMouseEnter = (node) => {
        setChartHoveredId(node.data.id);
        if (onPointHover && node.data) {
            onPointHover(node.data.id);
        }
    };

    // Handle point leave
    const handleNodeMouseLeave = () => {
        setChartHoveredId(null);
        if (onPointHover) {
            onPointHover(null);
        }
    };

    // Dynamic node sizing - larger when hovered
    const getNodeSize = (node) => {
        return chartHoveredId === node.data.id ? 14 : 8;
    };

    return (
        <div className="DSI-TimeSeriesChart">
            {isLoading && (
                <div className="DSI-TimeSeriesChart-overlay" aria-label="Loading selection">
                    <div className="DSI-TimeSeriesChart-spinner" />
                </div>
            )}
            <div className="DSI-TimeSeriesChart-chart">
                <ResponsiveScatterPlot
                    data={nivoData}
                    margin={{ top: 20, right: 20, bottom: 60, left: 70 }}
                    xScale={{ type: 'linear', min: 0, max: points.length - 1 }}
                    yScale={{ 
                        type: 'linear', 
                        min: yMin - yPadding, 
                        max: yMax + yPadding 
                    }}
                    axisBottom={{
                        legend: 'Point Index',
                        legendPosition: 'middle',
                        legendOffset: 46,
                        tickSize: 5,
                        tickPadding: 5,
                    }}
                    axisLeft={{
                        legend: 'Mean Velocity (mm/yr)',
                        legendPosition: 'middle',
                        legendOffset: -56,
                        tickSize: 5,
                        tickPadding: 5,
                    }}
                    colors={['#0066cc']}
                    nodeSize={getNodeSize}
                    useMesh={false}
                    onMouseEnter={handleNodeMouseEnter}
                    onMouseLeave={handleNodeMouseLeave}
                    tooltip={({ node }) => (
                        <div className="DSI-TimeSeriesChart-tooltip">
                            <strong>{node.data.fid}</strong>
                            <div>Index: {node.data.x}</div>
                            <div>Velocity: {node.data.y.toFixed(2)} mm/yr</div>
                        </div>
                    )}
                />
            </div>
        </div>
    );
}

import { ResponsiveLine } from '@nivo/line';
import { useRef } from 'react';

/**
 * Renders a 2D line profile chart with multiple metrics and optional error bands.
 * @param {{
 *   data: {id: string, data: {x: number, y: number}[]}[],
 *   metrics?: string[],
 *   showErrorBands?: boolean,
 *   title?: string,
 *   yAxisLabel?: string,
 *   colors?: string[],
 *   onPointHover?: (pointId: string | null) => void,
 * }} props
 */
export function LineProfileChart({
  data,
  title = 'Line Profile',
  yAxisLabel = 'Display rate (mm/y)',
  colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'],
  onPointHover,
}) {
  const lastHoveredId = useRef(null);

  const handleMouseMove = (point) => {
    if (!onPointHover) return;
    const pointId = point.data?.point_id;
    if (pointId && pointId !== lastHoveredId.current) {
      lastHoveredId.current = pointId;
      onPointHover(pointId);
    }
  };

  const handleMouseLeave = () => {
    if (!onPointHover) return;
    if (lastHoveredId.current) {
      lastHoveredId.current = null;
      onPointHover(null);
    }
  };

  if (!data || data.length === 0) {
    return (
        <div style={{
            height: '300px',
            textAlign: 'center',
            color: '#999',
            background: 'rgba(255, 255, 255, 0.95)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '8px',
            fontFamily: 'system-ui, sans-serif',
            fontSize: '11px',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        }}>
            No profile data
        </div>
    );
  }

  // Create color map for series
  const colorMap = {};
  data.forEach((series, idx) => {
    colorMap[series.id] = colors[idx % colors.length];
  });

  return (
    <div style={{
      height: '320px',
      background: 'rgba(255, 255, 255, 0.95)',
      borderRadius: '8px',
      padding: '12px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
      fontFamily: 'system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {title && (
        <div style={{
          color: '#333',
          fontSize: '13px',
          fontWeight: 'bold',
          marginBottom: '8px',
          textAlign: 'center'
        }}>
          {title}
        </div>
      )}
      <div style={{ flex: 1 }}>
        <ResponsiveLine
          data={data}
          margin={{ top: 10, right: 20, bottom: 50, left: 60 }}
          xScale={{ type: 'linear', min: 'auto', max: 'auto' }}
          yScale={{ type: 'linear', min: 'auto', max: 'auto', stacked: false, reverse: false }}
          axisTop={null}
          axisRight={null}
          axisBottom={{
            legend: 'Distance Along Profile (m)',
            legendOffset: 40,
            legendPosition: 'middle',
            tickSize: 4,
            tickPadding: 6,
          }}
          axisLeft={{
            legend: yAxisLabel,
            legendOffset: -50,
            legendPosition: 'middle',
            tickSize: 4,
            tickPadding: 6,
          }}
          colors={d => colorMap[d.id] || d.color}
          pointSize={4}
          pointColor={{ theme: 'background' }}
          pointBorderWidth={1.5}
          pointBorderColor={{ from: 'serieColor' }}
          useMesh={true}
          enableCrosshair={true}
          tooltip={() => null}
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          enableArea={false}
          lineWidth={2}
          legends={[
            {
              anchor: 'top-right',
              direction: 'column',
              justify: false,
              translateX: 0,
              translateY: 0,
              itemsSpacing: 4,
              itemDirection: 'left-to-right',
              itemWidth: 140,
              itemHeight: 18,
              itemOpacity: 0.75,
              symbolSize: 12,
              symbolShape: 'circle',
              symbolBorderColor: 'rgba(0, 0, 0, .5)',
              effects: [
                {
                  on: 'hover',
                  style: {
                    itemOpacity: 1
                  }
                }
              ]
            }
          ]}
          theme={{
            textColor: '#333',
            fontSize: 11,
            fontFamily: 'system-ui, sans-serif',
            axis: {
                domain: {
                    line: {
                        stroke: '#ccc'
                    }
                },
                legend: {
                    text: { fill: '#333', fontSize: 11 }
                },
                ticks: {
                    line: {
                        stroke: '#ccc'
                    },
                    text: { fill: '#555', fontSize: 10 }
                }
            },
            grid: {
                line: {
                    stroke: '#eee'
                }
            },
            legends: {
                text: {
                    fill: '#333'
                }
            }
          }}
        />
      </div>
    </div>
  );
}

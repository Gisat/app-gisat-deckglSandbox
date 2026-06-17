import { ResponsiveLine } from '@nivo/line';

/**
 * Renders a 2D line profile chart.
 * @param {{ data: {id: string, data: {x: number, y: number}[]}[] }} props
 */
export function LineProfileChart({ data }) {
    if (!data || data.length === 0 || data[0].data.length === 0) {
        return <div style={{height: '250px', textAlign: 'center', color: 'white', background: 'rgba(0,0,0,0.5)'}}>No profile data</div>;
    }

    return (
        <div style={{ height: '250px', background: 'rgba(30, 30, 30, 0.9)', borderRadius: '4px', padding: '10px' }}>
            <ResponsiveLine
                data={data}
                margin={{ top: 20, right: 20, bottom: 60, left: 70 }}
                xScale={{ type: 'linear', min: 'auto', max: 'auto' }}
                yScale={{ type: 'linear', min: 'auto', max: 'auto', stacked: false, reverse: false }}
                axisTop={null}
                axisRight={null}
                axisBottom={{
                    legend: 'Distance Along Line (m)',
                    legendOffset: 46,
                    legendPosition: 'middle',
                }}
                axisLeft={{
                    legend: 'Mean Velocity (mm/yr)',
                    legendOffset: -56,
                    legendPosition: 'middle',
                }}
                colors={{ scheme: 'spectral' }}
                pointSize={6}
                pointColor={{ theme: 'background' }}
                pointBorderWidth={2}
                pointBorderColor={{ from: 'serieColor' }}
                useMesh={true}
                legends={[]}
                theme={{
                    textColor: '#fff',
                    axis: {
                        legend: {
                            text: { fill: '#fff' }
                        },
                        ticks: {
                            text: { fill: '#fff' }
                        }
                    },
                    grid: {
                        line: {
                            stroke: '#555'
                        }
                    }
                }}
            />
        </div>
    );
}

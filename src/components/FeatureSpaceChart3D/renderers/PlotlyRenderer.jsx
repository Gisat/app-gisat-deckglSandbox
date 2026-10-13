/**
 * Plotly renderer for the 3D feature-space chart.
 *
 * Uses plotly.js via react-plotly.js' factory so the full library is imported
 * only once (the heavy `plotly.js-dist-min` bundle stays behind the lazy() in
 * FeatureSpaceChart).
 *
 * KNOWN LIMITATION (headline comparison finding):
 *   Plotly's `scatter3d` marker has NO per-point size. `marker.size` is a single
 *   number per trace (no data array, no sizemode/sizeref like 2D scatter). The
 *   `size = coh` channel is therefore approximated by binning points into a few
 *   traces, each with a constant marker size, plus a per-point opacity ramp.
 *   This is the only renderer that cannot honour the size channel natively.
 */

import { useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';
import createPlotlyComponent from 'react-plotly.js/factory';
import { axisTitle } from '../attributes';
import { buildPlotlyColorscale, sizeForValue } from '../colorScale';

const Plot = createPlotlyComponent(Plotly);

/** Number of coherence bins used to fake per-point sizing. */
const SIZE_BINS = 5;

/**
 * @param {Object} props
 * @param {Array<import('../transformPoints').FeatureSpacePoint>} props.points
 * @param {import('../attributes').PresetAxes} props.axes
 * @param {ReturnType<import('../colorScale').buildColorScale>} props.colorScale
 * @param {[number, number]} props.colorDomain
 * @param {[number, number]} props.sizeDomain
 * @param {[number, number]} props.sizeRange
 * @param {(id: string|null) => void} props.onHover
 */
export function PlotlyRenderer({ points, axes, colorScale, colorDomain, sizeDomain, sizeRange, onHover }) {
  const traces = useMemo(() => {
    const bins = Array.from({ length: SIZE_BINS }, () => []);
    for (const p of points) {
      const t = sizeForValue(p[axes.size], sizeDomain, [0, 1]);
      const idx = Math.min(SIZE_BINS - 1, Math.floor(t * SIZE_BINS));
      bins[idx].push(p);
    }

    const colorscale = buildPlotlyColorscale(colorScale, colorDomain);

    return bins
      .map((binPoints, binIndex) => {
        if (binPoints.length === 0) return null;
        const sizeT = (binIndex + 0.5) / SIZE_BINS;
        const markerSize = sizeRange[0] + sizeT * (sizeRange[1] - sizeRange[0]);
        return {
          type: 'scatter3d',
          mode: 'markers',
          name: `size bin ${binIndex + 1}`,
          x: binPoints.map((p) => p[axes.x]),
          y: binPoints.map((p) => p[axes.y]),
          z: binPoints.map((p) => p[axes.z]),
          customdata: binPoints.map((p) => [p.id, p.idOrig, p[axes.x], p[axes.y], p[axes.z], p.coh]),
          marker: {
            size: markerSize,
            // Per-point colour maps values through a colorscale; scatter3d
            // marker.color does not accept raw hex-string arrays.
            color: binPoints.map((p) => p[axes.color]),
            colorscale,
            cmin: colorDomain[0],
            cmax: colorDomain[1],
            opacity: 0.55 + sizeT * 0.45,
            line: { width: 0 },
          },
          hovertemplate:
            '<b>%{customdata[0]}</b><br>'
            + 'id_orig: %{customdata[1]}<br>'
            + `${axisTitle(axes.x)}: %{customdata[2]}<br>`
            + `${axisTitle(axes.y)}: %{customdata[3]}<br>`
            + `${axisTitle(axes.z)}: %{customdata[4]}<br>`
            + 'coherence: %{customdata[5]}'
            + '<extra></extra>',
        };
      })
      .filter(Boolean);
  }, [points, axes, colorScale, colorDomain, sizeDomain, sizeRange]);

  const layout = useMemo(
    () => ({
      autosize: true,
      margin: { l: 0, r: 0, t: 6, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      showlegend: false,
      font: { family: 'system-ui, sans-serif', size: 10, color: '#333' },
      scene: {
        bgcolor: 'rgba(0,0,0,0)',
        aspectmode: 'cube',
        xaxis: axisStyle(axes.x),
        yaxis: axisStyle(axes.y),
        zaxis: axisStyle(axes.z),
        camera: { eye: { x: 1.5, y: 1.5, z: 1.1 } },
      },
    }),
    [axes.x, axes.y, axes.z],
  );

  const config = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['toImage'],
      scrollZoom: true,
    }),
    [],
  );

  return (
    <div style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => onHover(null)}>
      <Plot
        data={traces}
        layout={layout}
        config={config}
        revision={points.length}
        onHover={(e) => {
          const id = e?.points?.[0]?.customdata?.[0];
          if (id != null) onHover(String(id));
        }}
        onUnhover={() => onHover(null)}
        useResizeHandler
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}

function axisStyle(key) {
  return {
    title: { text: axisTitle(key) },
    gridcolor: '#eee',
    zerolinecolor: '#ddd',
    color: '#555',
    tickfont: { size: 9 },
  };
}

export default PlotlyRenderer;

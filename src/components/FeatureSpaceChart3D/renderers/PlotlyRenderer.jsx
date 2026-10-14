/**
 * Plotly renderer for the 3D feature-space chart.
 *
 * Uses plotly.js via react-plotly.js' factory so the full library is imported
 * only once (the heavy `plotly.js-dist-min` bundle stays behind the lazy() in
 * FeatureSpaceChart).
 *
 * Two modes:
 *  - scatter: the feature-space cloud (see KNOWN LIMITATION below).
 *  - profile: multi-series line profile (`scatter3d` lines+markers) plus a
 *    translucent `mesh3d` uncertainty ribbon in `along` mode. Plotly has real
 *    axes, so profile values are plotted in raw units.
 *
 * KNOWN LIMITATION (headline comparison finding):
 *   Plotly's `scatter3d` marker has NO per-point size. `marker.size` is a single
 *   number per trace (no data array, no sizemode/sizeref like 2D scatter). The
 *   `size = COH` channel is therefore approximated by binning points into a few
 *   traces, each with a constant marker size, plus a per-point opacity ramp.
 *   This is the only renderer that cannot honour the size channel natively.
 */

import { useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';
import createPlotlyComponent from 'react-plotly.js/factory';
import { axisTitle } from '../attributes';
import { buildPlotlyColorscale, sizeForValue } from '../colorScale';
import { buildProfileFrame, formatTick } from '../profileGeometry';

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
 * @param {{mode:'along'|'geo',series:Array<any>}} [props.profile]
 * @param {(id: string|null) => void} props.onHover
 */
export function PlotlyRenderer({ points, axes, colorScale, colorDomain, sizeDomain, sizeRange, profile, onHover }) {
  const frame = useMemo(() => (profile ? buildProfileFrame(profile) : null), [profile]);

  const traces = useMemo(() => {
    if (frame) return buildProfileTraces(frame);

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
          customdata: binPoints.map((p) => [p.id, p.idOrig, p[axes.x], p[axes.y], p[axes.z], p.COH]),
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
            + 'fid: %{customdata[1]}<br>'
            + `${axisTitle(axes.x)}: %{customdata[2]}<br>`
            + `${axisTitle(axes.y)}: %{customdata[3]}<br>`
            + `${axisTitle(axes.z)}: %{customdata[4]}<br>`
            + 'coherence: %{customdata[5]}'
            + '<extra></extra>',
        };
      })
      .filter(Boolean);
  }, [points, axes, colorScale, colorDomain, sizeDomain, sizeRange, frame]);

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
        xaxis: frame ? axisStyleText(frame.titles.x) : axisStyle(axes.x),
        yaxis: frame ? axisStyleText(frame.titles.y) : axisStyle(axes.y),
        zaxis: frame ? axisStyleText(frame.titles.z) : axisStyle(axes.z),
        camera: { eye: { x: 1.5, y: 1.5, z: 1.1 } },
      },
    }),
    [axes.x, axes.y, axes.z, frame],
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

  const revision = frame
    ? frame.series.reduce((acc, s) => acc + s.samples.length, 0) + frame.series.length
    : points.length;

  return (
    <div style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => onHover(null)}>
      <Plot
        data={traces}
        layout={layout}
        config={config}
        revision={revision}
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

/** Multi-series profile traces: mesh3d ribbons (along mode) + scatter3d lines. */
function buildProfileTraces(frame) {
  const traces = [];

  if (frame.along) {
    for (const s of frame.series) {
      const n = s.samples.length;
      if (n < 2) continue;
      const x = [];
      const y = [];
      const z = [];
      const i = [];
      const j = [];
      const k = [];
      s.samples.forEach((smp) => {
        x.push(smp.raw.x, smp.raw.x);
        y.push(smp.raw.lo, smp.raw.hi);
        z.push(smp.raw.z, smp.raw.z);
      });
      for (let a = 0; a < n - 1; a++) {
        const b0 = 2 * a;
        const t0 = 2 * a + 1;
        const b1 = 2 * a + 2;
        const t1 = 2 * a + 3;
        i.push(b0, b0);
        j.push(t0, t1);
        k.push(t1, b1);
      }
      traces.push({
        type: 'mesh3d',
        x,
        y,
        z,
        i,
        j,
        k,
        name: `${s.label} band`,
        color: s.color,
        opacity: 0.22,
        flatshading: false,
        hoverinfo: 'skip',
        showscale: false,
      });
    }
  }

  for (const s of frame.series) {
    traces.push({
      type: 'scatter3d',
      mode: 'lines+markers',
      name: s.label,
      x: s.samples.map((p) => p.raw.x),
      y: s.samples.map((p) => p.raw.y),
      z: s.samples.map((p) => p.raw.z),
      customdata: s.samples.map((p) => [p.id, formatTick(p.sample?.value), p.sample?.std == null ? '\u2014' : formatTick(p.sample.std)]),
      line: { color: s.color, width: 3 },
      marker: { color: s.color, size: 3, line: { width: 0 } },
      hovertemplate:
        `<b>${s.label}</b><br>`
        + 'id: %{customdata[0]}<br>'
        + `value: %{customdata[1]}${s.unit ? ` ${s.unit}` : ''}<br>`
        + `std: %{customdata[2]}${s.unit ? ` ${s.unit}` : ''}`
        + '<extra></extra>',
    });
  }

  return traces;
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

function axisStyleText(title) {
  return {
    title: { text: title },
    gridcolor: '#eee',
    zerolinecolor: '#ddd',
    color: '#555',
    tickfont: { size: 9 },
  };
}

export default PlotlyRenderer;

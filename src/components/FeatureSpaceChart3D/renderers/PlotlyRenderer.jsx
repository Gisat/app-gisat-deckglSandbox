/**
 * Plotly renderer for the 3D feature-space chart.
 *
 * Uses plotly.js via react-plotly.js' factory so the full library is imported
 * only once (the heavy `plotly.js-dist-min` bundle stays behind the lazy() in
 * FeatureSpaceChart).
 *
 * Two modes:
 *  - scatter: the feature-space cloud (see KNOWN LIMITATION below).
 *  - profile: one `scatter3d` line per `frame.curves` entry, plus a translucent
 *    `mesh3d` uncertainty ribbon on Z for each banded curve (attribute view and
 *    trend windows only). Plotly has real axes, so profile values are plotted in
 *    raw units.
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
import { axisTitle, getAttribute } from '../attributes';
import { buildPlotlyColorscale, sizeForValue } from '../colorScale';
import { buildProfileFrame, DISPLACEMENT_COLORSCALE, displacementColor, formatTick } from '../profileGeometry';

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
 * @param {{view:'attributes'|'trend', yKey:string, zKey:string, trendLines:string, samples:Array<any>}} [props.profile]
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
        yaxis: frame
          ? frame.yTicks
            ? {
                ...axisStyleText(frame.titles.y),
                tickvals: frame.yTicks.map((t) => t.value),
                ticktext: frame.yTicks.map((t) => t.label),
              }
            : axisStyleText(frame.titles.y)
          : axisStyle(axes.y),
        zaxis: frame ? axisStyleText(frame.titles.z) : axisStyle(axes.z),
        // Canonical default view (matches three.js / deck.gl): Z up, camera at
        // azimuth 45deg / elevation 30deg.
        camera: { eye: { x: 1.47, y: 1.47, z: 1.2 }, up: { x: 0, y: 0, z: 1 } },
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
    ? frame.curves.reduce((n, c) => n + c.samples.length, 0)
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

/** One `scatter3d` line per curve plus a `mesh3d` Z ribbon for each banded curve. */
function buildProfileTraces(frame) {
  const traces = [];

  for (const curve of frame.curves) {
    const samples = curve.samples;
    const n = samples.length;
    if (n < 2) continue;

    if (curve.stdKey) {
      const x = [];
      const y = [];
      const z = [];
      const i = [];
      const j = [];
      const k = [];
      samples.forEach((smp) => {
        x.push(smp.raw.x, smp.raw.x);
        y.push(smp.raw.y, smp.raw.y);
        // Band lives on Z: lo/hi are `z ∓ std`.
        z.push(smp.raw.lo, smp.raw.hi);
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
        name: `${curve.label} band`,
        color: curve.color,
        opacity: 0.22,
        flatshading: false,
        hoverinfo: 'skip',
        showscale: false,
      });
    }

    const hover = curveHover(frame, curve, samples);
    // Point/station curves colour their markers by displacement. `scatter3d`
    // cannot gradient a line, so the line takes the station's mean displacement
    // colour (thin) and the markers carry the full ramp.
    const marker = curve.colored
      ? {
          color: samples.map((p) => p.raw.z),
          colorscale: DISPLACEMENT_COLORSCALE,
          cmin: frame.colorDomain[0],
          cmax: frame.colorDomain[1],
          size: 3,
          line: { width: 0 },
          showscale: false,
        }
      : { color: curve.color, size: 3, line: { width: 0 } };
    const lineColor = curve.colored
      ? displacementColor(meanDisplacementT(frame.colorDomain, samples))
      : curve.color;
    traces.push({
      type: 'scatter3d',
      mode: 'lines+markers',
      name: curve.label,
      x: samples.map((p) => p.raw.x),
      y: samples.map((p) => p.raw.y),
      z: samples.map((p) => p.raw.z),
      customdata: hover.customdata,
      line: { color: lineColor, width: curve.colored ? 2 : 3 },
      marker,
      hovertemplate: hover.hovertemplate,
    });
  }

  return traces;
}

/** Mean normalised displacement (t in [0,1]) of a station, for its line colour. */
function meanDisplacementT([cLo, cHi], samples) {
  if (samples.length === 0 || cHi === cLo) return 0.5;
  let sum = 0;
  for (const p of samples) {
    sum += Math.max(0, Math.min(1, (p.raw.z - cLo) / (cHi - cLo)));
  }
  return sum / samples.length;
}

/** Per-view `customdata` (id first, so `onHover` reads `customdata[0]`) + template. */
function curveHover(frame, curve, samples) {
  if (frame.view === 'trend') {
    const unit = getAttribute(samples[0].windowKey ?? curve.key)?.unit ?? '';
    const u = unit ? ` ${unit}` : '';
    if (curve.stdKey) {
      return {
        customdata: samples.map((p) => {
          const std = p.sample?.[curve.stdKey];
          return [
            p.id,
            formatTick(p.raw.z),
            std == null ? '\u2014' : formatTick(std),
            formatTick(p.sample?.distance),
          ];
        }),
        hovertemplate:
          `<b>${curve.label}</b><br>`
          + `displacement: %{customdata[1]}${u} \u00b1 %{customdata[2]}${u}<br>`
          + 'distance: %{customdata[3]} m<br>'
          + 'id: %{customdata[0]}'
          + '<extra></extra>',
      };
    }
    return {
      customdata: samples.map((p) => [
        p.id,
        p.windowLabel ?? '\u2014',
        formatTick(p.raw.z),
        formatTick(p.sample?.distance),
      ]),
      hovertemplate:
        `<b>${curve.label}</b><br>`
        + 'window: %{customdata[1]}<br>'
        + `displacement: %{customdata[2]}${u}<br>`
        + 'distance: %{customdata[3]} m'
        + '<extra></extra>',
    };
  }

  const yAttr = getAttribute(frame.yKey);
  const zAttr = getAttribute(frame.zKey);
  const yUnit = yAttr.unit ? ` ${yAttr.unit}` : '';
  const zUnit = zAttr.unit ? ` ${zAttr.unit}` : '';
  return {
    customdata: samples.map((p) => {
      const std = curve.stdKey ? p.sample?.[curve.stdKey] : null;
      return [
        p.id,
        formatTick(p.raw.y),
        formatTick(p.raw.z),
        std == null ? '\u2014' : formatTick(std),
        formatTick(p.sample?.distance),
      ];
    }),
    hovertemplate:
      '<b>id: %{customdata[0]}</b><br>'
      + `${yAttr.label}: %{customdata[1]}${yUnit}<br>`
      + `${zAttr.label}: %{customdata[2]}${zUnit}${curve.stdKey ? ` \u00b1 %{customdata[3]}${zUnit}` : ''}<br>`
      + 'distance: %{customdata[4]} m'
      + '<extra></extra>',
  };
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

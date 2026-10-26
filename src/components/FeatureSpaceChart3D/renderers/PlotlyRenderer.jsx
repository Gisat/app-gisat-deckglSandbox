/**
 * Plotly renderer for the 3D feature-space chart.
 *
 * Uses plotly.js via react-plotly.js' factory so the full library is imported
 * only once (the heavy `plotly.js-dist-min` bundle stays behind the lazy() in
 * FeatureSpaceChart).
 *
 * Two modes:
 *  - scatter: the feature-space cloud. `scatter3d.marker.size` accepts a numeric
 *    array, so the size channel is honoured per point.
 *  - profile: one `scatter3d` line per `frame.curves` entry, plus a translucent
 *    `mesh3d` uncertainty ribbon on Z for each banded curve (attribute view and
 *    the trend `windows` shape only). Plotly has real axes, so profile values are plotted in
 *    raw units.
 *
 * KNOWN LIMITATION:
 *   Plotly's `scatter3d` markers are flat billboards — there is no sphere marker
 *   geometry — so this renderer cannot match the shaded spheres the deck.gl and
 *   three.js renderers draw for the `sphere` marker style.
 */

import { useMemo } from 'react';
import Plotly from 'plotly.js-dist-min';
import createPlotlyComponent from 'react-plotly.js/factory';
import { axisTitle, getAttribute } from '../attributes';
import { buildPlotlyColorscale, sizeForValue } from '../colorScale';
import { buildProfileFrame, DISPLACEMENT_COLORSCALE, displacementColor, formatTick } from '../profileGeometry';

const Plot = createPlotlyComponent(Plotly);

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

    const colorscale = buildPlotlyColorscale(colorScale, colorDomain);

    // `scatter3d.marker.size` accepts a numeric array, so the size channel maps
    // one-to-one (no binning). Plotly's real limitation is the flat billboard
    // marker, not per-point sizing.
    return [{
      type: 'scatter3d',
      mode: 'markers',
      name: 'points',
      x: points.map((p) => p[axes.x]),
      y: points.map((p) => p[axes.y]),
      z: points.map((p) => p[axes.z]),
      customdata: points.map((p) => [p.id, p.idOrig, p[axes.x], p[axes.y], p[axes.z], p.COH]),
      marker: {
        size: points.map((p) => sizeForValue(p[axes.size], sizeDomain, sizeRange)),
        // Per-point colour maps values through a colorscale; scatter3d
        // marker.color does not accept raw hex-string arrays.
        color: points.map((p) => p[axes.color]),
        colorscale,
        cmin: colorDomain[0],
        cmax: colorDomain[1],
        opacity: 0.85,
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
    }];
  }, [points, axes, colorScale, colorDomain, sizeDomain, sizeRange, frame]);

  const layout = useMemo(() => {
    const plan = frame?.basis === 'plan' && frame?.view === 'attributes';
    // The Plan basis plots the same normalised cube positions deck.gl/three use,
    // so it needs a fixed [-1,1] cube box with raw-value tick labels (rather than
    // Plotly's auto-ranged axes) to look identical to the other renderers.
    const planAxis = (slot) => ({
      ...axisStyleText(frame.titles[slot]),
      range: [-1, 1],
      tickvals: [-1, 1],
      ticktext: [
        formatTick(frame.axisDomains[slot][0]),
        formatTick(frame.axisDomains[slot][1]),
      ],
    });
    return {
      autosize: true,
      margin: { l: 0, r: 0, t: 6, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      showlegend: false,
      font: { family: 'system-ui, sans-serif', size: 10, color: '#333' },
      scene: {
        bgcolor: 'rgba(0,0,0,0)',
        aspectmode: 'cube',
        xaxis: frame ? (plan ? planAxis('x') : axisStyleText(frame.titles.x)) : axisStyle(axes.x),
        yaxis: frame
          ? plan
            ? planAxis('y')
            : frame.yTicks
              ? {
                  ...axisStyleText(frame.titles.y),
                  tickvals: frame.yTicks.map((t) => t.value),
                  ticktext: frame.yTicks.map((t) => t.label),
                }
              : axisStyleText(frame.titles.y)
          : axisStyle(axes.y),
        zaxis: frame ? (plan ? planAxis('z') : axisStyleText(frame.titles.z)) : axisStyle(axes.z),
        // Canonical default view (matches three.js / deck.gl): Z up, camera at
        // azimuth 45deg / elevation 30deg.
        camera: { eye: { x: 1.47, y: 1.47, z: 1.2 }, up: { x: 0, y: 0, z: 1 } },
      },
    };
  }, [axes.x, axes.y, axes.z, frame]);

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
  // The Plan basis plots the cube-normalised positions (not raw lon/lat) so it
  // shares the exact cube geometry deck.gl/three show; every other view plots
  // raw values with real axes.
  const plan = frame.basis === 'plan' && frame.view === 'attributes';
  const coordsOf = (p) => (plan ? p.position : [p.raw.x, p.raw.y, p.raw.z]);
  const aggregate = frame.view === 'aggregate';
  const traces = [];

  for (const curve of frame.curves) {
    const samples = curve.samples;
    const n = samples.length;
    if (n < 2) continue;

    if (curve.banded) {
      // Only finite-σ samples define the band; a missing std means "unknown", so
      // those samples drop out. Keep each sample's source index so a gap breaks
      // the band rather than bridging an interval whose uncertainty is unknown
      // (matches deck.gl).
      const banded = [];
      samples.forEach((smp, index) => {
        if (smp.ribbon) banded.push({ smp, index });
      });
      if (banded.length >= 2) {
        const x = [];
        const y = [];
        const z = [];
        const i = [];
        const j = [];
        const k = [];
        banded.forEach(({ smp }) => {
          if (plan) {
            x.push(smp.ribbon.lo[0], smp.ribbon.hi[0]);
            y.push(smp.ribbon.lo[1], smp.ribbon.hi[1]);
            z.push(smp.ribbon.lo[2], smp.ribbon.hi[2]);
          } else {
            x.push(smp.raw.x, smp.raw.x);
            y.push(smp.raw.y, smp.raw.y);
            // Band lives on Z: lo/hi are `z ∓ std`.
            z.push(smp.raw.lo, smp.raw.hi);
          }
        });
        for (let a = 0; a < banded.length - 1; a++) {
          // Only join source-adjacent samples.
          if (banded[a + 1].index !== banded[a].index + 1) continue;
          const b0 = 2 * a;
          const t0 = 2 * a + 1;
          const b1 = 2 * a + 2;
          const t1 = 2 * a + 3;
          i.push(b0, b0);
          j.push(t0, t1);
          k.push(t1, b1);
        }
        if (i.length > 0) {
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
      }
    }

    const hover = curveHover(frame, curve);

    if (aggregate) {
      // One line connecting all bins, with markers on measured bins only
      // (interpolated bins stay line-only and are flagged in the tooltip).
      const line = toArrays(samples, coordsOf, hover.row);
      traces.push({
        type: 'scatter3d',
        mode: 'lines',
        name: curve.label,
        x: line.x,
        y: line.y,
        z: line.z,
        customdata: line.cd,
        line: { color: curve.color, width: 3 },
        hovertemplate: hover.hovertemplate,
      });
      const measured = samples.filter((p) => !p.interpolated);
      if (measured.length > 0) {
        const m = toArrays(measured, coordsOf, hover.row);
        traces.push({
          type: 'scatter3d',
          mode: 'markers',
          name: `${curve.label} (measured)`,
          x: m.x,
          y: m.y,
          z: m.z,
          customdata: m.cd,
          marker: { color: curve.color, size: 4, line: { width: 0 } },
          hovertemplate: hover.hovertemplate,
        });
      }
      continue;
    }

    // Point/station curves colour their markers by displacement. `scatter3d`
    // cannot gradient a line, so the line takes the station's mean displacement
    // colour (thin) and the markers carry the full ramp. Marker size encodes the
    // perpendicular offset in both the Attribute and Trend views.
    const sizes = frame.sizeByOffset
      ? samples.map((p) => 3 + (p.offsetT ?? 0) * 4)
      : 3;
    const marker = curve.colored
      ? {
          color: samples.map((p) => p.raw.z),
          colorscale: DISPLACEMENT_COLORSCALE,
          cmin: frame.colorDomain[0],
          cmax: frame.colorDomain[1],
          size: sizes,
          line: { width: 0 },
          showscale: false,
        }
      : { color: curve.color, size: sizes, line: { width: 0 } };
    const lineColor = curve.colored
      ? displacementColor(meanDisplacementT(frame.colorDomain, samples))
      : curve.color;
    const a = toArrays(samples, coordsOf, hover.row);
    traces.push({
      type: 'scatter3d',
      mode: 'lines+markers',
      name: curve.label,
      x: a.x,
      y: a.y,
      z: a.z,
      customdata: a.cd,
      line: { color: lineColor, width: curve.colored ? 2 : 3 },
      marker,
      hovertemplate: hover.hovertemplate,
    });
  }

  return traces;
}

/**
 * Map a sample list to Plotly coordinate arrays. `row` builds the per-sample
 * customdata (id first, so `onHover` reads `customdata[0]`).
 */
function toArrays(samples, coordsOf, row) {
  const x = [];
  const y = [];
  const z = [];
  const cd = [];
  for (const s of samples) {
    const c = coordsOf(s);
    x.push(c[0]);
    y.push(c[1]);
    z.push(c[2]);
    cd.push(row ? row(s) : [s.id]);
  }
  return { x, y, z, cd };
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

/**
 * Per-view hovertemplate + a `row(sample)` builder (id first, so `onHover` reads
 * `customdata[0]`). The builder is applied over a sample list by `toArrays`.
 */
function curveHover(frame, curve) {
  if (frame.view === 'aggregate') {
    const attr = getAttribute(frame.valueKey);
    const unit = attr.unit ? ` ${attr.unit}` : '';
    return {
      row: (p) => {
        const bin = p.sample ?? {};
        return [
          p.id,
          formatTick(p.raw.z),
          bin.iqrLo == null ? '\u2014' : formatTick(bin.iqrLo),
          bin.iqrHi == null ? '\u2014' : formatTick(bin.iqrHi),
          bin.n ?? 0,
          formatTick(bin.distance),
          formatTick(bin.binStart),
          formatTick(bin.binEnd),
          p.interpolated ? 'yes' : 'no',
        ];
      },
      hovertemplate:
        `<b>${attr.label}${unit}</b><br>`
        + `median: %{customdata[1]}${unit}<br>`
        + `IQR: %{customdata[2]} \u2013 %{customdata[3]}${unit}<br>`
        + 'n: %{customdata[4]}<br>'
        + 'bin: %{customdata[6]} \u2013 %{customdata[7]} m<br>'
        + 'interpolated: %{customdata[8]}'
        + '<extra></extra>',
    };
  }

  if (frame.view === 'trend') {
    const u = ' mm';
    if (frame.shape === 'windows') {
      return {
        row: (p) => {
          const std = p.raw.std;
          return [
            p.id,
            formatTick(p.raw.z),
            std == null ? '\u2014' : formatTick(std),
            formatTick(p.sample?.distance),
          ];
        },
        hovertemplate:
          `<b>${curve.label}</b><br>`
          + `displacement: %{customdata[1]}${u} \u00b1 %{customdata[2]}${u}<br>`
          + 'distance: %{customdata[3]} m<br>'
          + 'id: %{customdata[0]}'
          + '<extra></extra>',
      };
    }
    if (frame.shape === 'points') {
      return {
        row: (p) => [
          p.id,
          p.stepLabel ?? '\u2014',
          formatTick(p.raw.z),
          formatTick(p.sample?.distance),
        ],
        hovertemplate:
          `<b>${curve.label}</b><br>`
          + 'time step: %{customdata[1]}<br>'
          + `settlement: %{customdata[2]}${u}<br>`
          + 'distance: %{customdata[3]} m'
          + '<extra></extra>',
      };
    }
    return {
      row: (p) => [p.id, formatTick(p.raw.z), formatTick(p.sample?.distance)],
      hovertemplate:
        `<b>${curve.label}</b><br>`
        + `settlement: %{customdata[1]}${u}<br>`
        + 'distance: %{customdata[2]} m'
        + '<extra></extra>',
    };
  }

  const yAttr = getAttribute(frame.yKey);
  const zAttr = getAttribute(frame.zKey);
  const yUnit = yAttr.unit ? ` ${yAttr.unit}` : '';
  const zUnit = zAttr.unit ? ` ${zAttr.unit}` : '';
  return {
    row: (p) => {
      const std = p.raw.std;
      return [
        p.id,
        formatTick(p.raw.y),
        formatTick(p.raw.z),
        std == null ? '\u2014' : formatTick(std),
        formatTick(p.sample?.distance),
        formatTick(p.sample?.offset),
      ];
    },
    hovertemplate:
      '<b>id: %{customdata[0]}</b><br>'
      + `${yAttr.label}: %{customdata[1]}${yUnit}<br>`
      + `${zAttr.label}: %{customdata[2]}${zUnit}${curve.stdKey ? ` \u00b1 %{customdata[3]}${zUnit}` : ''}<br>`
      + 'distance: %{customdata[4]} m<br>'
      + 'offset: %{customdata[5]} m'
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

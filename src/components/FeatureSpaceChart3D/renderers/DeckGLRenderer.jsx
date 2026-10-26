/**
 * deck.gl renderer for the 3D feature-space chart.
 *
 * Uses OrbitView (OrthographicView cannot rotate). Two modes:
 *  - scatter: points as shaded spheres (SimpleMeshLayer + luma.gl SphereGeometry)
 *    or billboarded discs (ScatterplotLayer), matching the map's marker style.
 *  - profile: one line per `frame.curves` entry (`PathLayer`), a translucent
 *    `z ± std` uncertainty ribbon per banded curve (`PolygonLayer` quads, not in
 *    trend points) and per-sample points.
 *
 * A hand-built cube/axis overlay is needed because deck.gl ships no axes, grid
 * or ticks. Axis labels are TextLayer instances: deck.gl generates the SDF font
 * atlas in an offscreen canvas, so nothing is fetched from a CDN (important under
 * the app's COEP require-corp headers).
 */

import { useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { LineLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { axisTitle, formatValue } from '../attributes';
import { colorToRgba, sizeForValue } from '../colorScale';
import { computeAxisDomains, projectToCube } from '../transformPoints';
import { buildProfileFrame, formatTick, hexToRgba } from '../profileGeometry';
import { PointTooltip } from '../PointTooltip';
import { ProfileTooltip } from '../ProfileTooltip';

/** Half-extent of the normalised cube the points are projected into. */
const CUBE = 1;

/** Shared sphere mesh for the point layer (radius 1; scaled per point). */
const sphereGeometry = new SphereGeometry();

const AXIS_COLORS = {
  x: [214, 39, 40],
  y: [44, 160, 44],
  z: [31, 119, 180],
};

/** 12 edges of the [-CUBE, CUBE]^3 wireframe. */
function cubeSegments() {
  const c = CUBE;
  const corners = [
    [-c, -c, -c], [c, -c, -c], [c, c, -c], [-c, c, -c],
    [-c, -c, c], [c, -c, c], [c, c, c], [-c, c, c],
  ];
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.map(([a, b]) => ({ source: corners[a], target: corners[b] }));
}

/** Three axis shafts from the low corner to the three high corners. */
function axisSegments() {
  const c = CUBE;
  return [
    { source: [-c, -c, -c], target: [c, -c, -c], color: AXIS_COLORS.x },
    { source: [-c, -c, -c], target: [-c, c, -c], color: AXIS_COLORS.y },
    { source: [-c, -c, -c], target: [-c, -c, c], color: AXIS_COLORS.z },
  ];
}

function cubeLayers() {
  return [
    new LineLayer({
      id: 'feature-space-cube',
      data: cubeSegments(),
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: [220, 220, 220, 255],
      widthUnits: 'pixels',
      getWidth: 1,
    }),
    new LineLayer({
      id: 'feature-space-axes',
      data: axisSegments(),
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: (d) => d.color,
      widthUnits: 'pixels',
      getWidth: 2,
    }),
  ];
}

/** Axis-title + tick labels laid out around the cube, with explicit titles. */
function profileLabels(frame) {
  const c = CUBE;
  const off = c + 0.14;
  const out = [
    { position: [0, -off, -off], text: frame.titles.x, color: AXIS_COLORS.x },
    { position: [-off, 0, -off], text: frame.titles.y, color: AXIS_COLORS.y },
    { position: [-off, -off, 0], text: frame.titles.z, color: AXIS_COLORS.z },
  ];
  const ticks = [
    ['x', [-c, -off - 0.05, -off - 0.05], [c, -off - 0.05, -off - 0.05]],
    ['z', [-off - 0.05, -off - 0.05, -c], [-off - 0.05, -off - 0.05, c]],
  ];
  for (const [slot, minPos, maxPos] of ticks) {
    out.push({ position: minPos, text: formatTick(frame.axisDomains[slot][0]), color: [110, 110, 110] });
    out.push({ position: maxPos, text: formatTick(frame.axisDomains[slot][1]), color: [110, 110, 110] });
  }
  if (frame.yTicks) {
    // Trend: label each Y band with its window instead of the -1..1 endpoints.
    const t = off + 0.05;
    for (const tick of frame.yTicks) {
      out.push({ position: [-t, tick.value, -t], text: tick.label, color: [110, 110, 110] });
    }
  } else {
    out.push({ position: [-off - 0.05, -c, -off - 0.05], text: formatTick(frame.axisDomains.y[0]), color: [110, 110, 110] });
    out.push({ position: [-off - 0.05, c, -off - 0.05], text: formatTick(frame.axisDomains.y[1]), color: [110, 110, 110] });
  }
  return out;
}

/**
 * @param {Object} props
 * @param {Array<import('../transformPoints').FeatureSpacePoint>} props.points
 * @param {import('../attributes').PresetAxes} props.axes
 * @param {ReturnType<import('../colorScale').buildColorScale>} props.colorScale
 * @param {[number, number]} props.sizeDomain
 * @param {[number, number]} props.sizeRange
 * @param {'billboard'|'sphere'} props.markerStyle
 * @param {{view:'attributes'|'trend', yKey:string, zKey:string, trendLines:string, samples:Array<any>}} [props.profile]
 * @param {(id: string|null) => void} props.onHover
 */
export function DeckGLRenderer({ points, axes, colorScale, sizeDomain, sizeRange, markerStyle, profile, onHover }) {
  const [tooltip, setTooltip] = useState(null);

  const domains = useMemo(() => computeAxisDomains(points, axes), [points, axes]);
  const frame = useMemo(() => (profile ? buildProfileFrame(profile, CUBE) : null), [profile]);

  const scatterData = useMemo(
    () =>
      points.map((p) => {
        const radius = sizeForValue(p[axes.size], sizeDomain, sizeRange);
        const t = sizeRange[1] === sizeRange[0] ? 0.5 : (radius - sizeRange[0]) / (sizeRange[1] - sizeRange[0]);
        return {
          ...p,
          position: projectToCube(p, axes, domains, CUBE),
          fillColor: colorToRgba(colorScale, p[axes.color]),
          // Billboard circle radius in pixels.
          radius,
          // SphereGeometry has radius 1, so getScale is the sphere radius in
          // world units (the cube spans [-1, 1]).
          scale: 0.02 + t * 0.06,
        };
      }),
    [points, axes, domains, colorScale, sizeDomain, sizeRange],
  );

  const labels = useMemo(() => {
    if (frame) return profileLabels(frame);
    const c = CUBE;
    const off = c + 0.14;
    /** @type {Array<{ position: number[], text: string, color: number[] }>} */
    const out = [
      { position: [0, -off, -off], text: axisTitle(axes.x), color: AXIS_COLORS.x },
      { position: [-off, 0, -off], text: axisTitle(axes.y), color: AXIS_COLORS.y },
      { position: [-off, -off, 0], text: axisTitle(axes.z), color: AXIS_COLORS.z },
    ];
    const ticks = [
      ['x', [-c, -off - 0.05, -off - 0.05], [c, -off - 0.05, -off - 0.05]],
      ['y', [-off - 0.05, -c, -off - 0.05], [-off - 0.05, c, -off - 0.05]],
      ['z', [-off - 0.05, -off - 0.05, -c], [-off - 0.05, -off - 0.05, c]],
    ];
    for (const [slot, minPos, maxPos] of ticks) {
      out.push({ position: minPos, text: formatValue(axes[slot], domains[slot].min), color: [110, 110, 110] });
      out.push({ position: maxPos, text: formatValue(axes[slot], domains[slot].max), color: [110, 110, 110] });
    }
    return out;
  }, [axes, domains, frame]);

  const view = useMemo(() => new OrbitView({ orbitAxis: 'Z', fovy: 45 }), []);

  const profileLayers = useMemo(() => {
    if (!frame) return null;

    // Trend ▸ points uses thinner lines and smaller marks; the other profile
    // views keep their current weight.
    const pointsMode = frame.shape === 'points';
    const aggregateView = frame.view === 'aggregate';
    const sizeByOffset = frame.sizeByOffset;
    const baseBillboard = pointsMode ? 3 : 4;
    const baseScale = pointsMode ? 0.02 : 0.03;

    // Uniform-coloured curves use a PathLayer; settlement-coloured points are
    // split into per-segment lines so each segment shows its colour. Curves
    // containing interpolated bins are drawn as a distinct (thinner, translucent)
    // path so the inferred stretches read differently from measured ones.
    const linePaths = [];
    const interpPaths = [];
    const lineSegments = [];
    for (const c of frame.curves) {
      if (c.colored) {
        for (let i = 0; i < c.samples.length - 1; i++) {
          const a = c.samples[i];
          const b = c.samples[i + 1];
          lineSegments.push({
            source: a.position,
            target: b.position,
            color: hexToRgba(a.color ?? c.color, 255),
          });
        }
      } else {
        const entry = { path: c.samples.map((p) => p.position), color: hexToRgba(c.color, 255) };
        // The Aggregate line is a single connected polyline, so interpolated
        // bins stay on the same line (flagged in the tooltip instead).
        if (!aggregateView && c.samples.some((p) => p.interpolated)) interpPaths.push(entry);
        else linePaths.push(entry);
      }
    }

    const ribbons = frame.curves.flatMap((c) => {
      if (!c.banded) return [];
      return c.samples.slice(0, -1).flatMap((a, i) => {
        const b = c.samples[i + 1];
        if (!a.ribbon || !b.ribbon) return [];
        return [{
          key: `${c.key}-ribbon-${i}`,
          polygon: [a.ribbon.lo, b.ribbon.lo, b.ribbon.hi, a.ribbon.hi],
          fillColor: hexToRgba(c.color, 55),
        }];
      });
    });

    const pointData = frame.curves.flatMap((c) =>
      c.samples
        // Aggregate marks the measured bins only; interpolated bins stay line-only.
        .filter((p) => !(aggregateView && p.interpolated))
        .map((p) => {
          const off = !aggregateView && sizeByOffset && p.offsetT != null ? p.offsetT : null;
          return {
            id: p.id,
            position: p.position,
            fillColor: hexToRgba(p.color ?? c.color, 255),
            // Billboard circle radius (px) and sphere world radius; the
            // perpendicular offset grows the mark from the base size (bigger
            // offset = bigger mark), never below it.
            radius: off == null ? baseBillboard : baseBillboard + off * 4,
            scale: off == null ? baseScale : baseScale + off * 0.04,
            frameSample: p,
            curve: c,
          };
        }),
    );

    const out = [];
    if (ribbons.length > 0) {
      out.push(
        new PolygonLayer({
          id: 'profile-ribbons',
          data: ribbons,
          getPolygon: (d) => d.polygon,
          getFillColor: (d) => d.fillColor,
          stroked: false,
          extruded: false,
          pickable: false,
        }),
      );
    }
    if (linePaths.length > 0) {
      out.push(
        new PathLayer({
          id: 'profile-lines',
          data: linePaths,
          getPath: (d) => d.path,
          getColor: (d) => d.color,
          widthUnits: 'pixels',
          getWidth: 2,
          jointRounded: true,
          capRounded: true,
          pickable: false,
        }),
      );
    }
    if (interpPaths.length > 0) {
      // Interpolated runs: thinner + translucent (deck.gl has no native dashes).
      out.push(
        new PathLayer({
          id: 'profile-lines-interpolated',
          data: interpPaths,
          getPath: (d) => d.path,
          getColor: (d) => [d.color[0], d.color[1], d.color[2], 140],
          widthUnits: 'pixels',
          getWidth: 1,
          jointRounded: true,
          capRounded: true,
          pickable: false,
        }),
      );
    }
    if (lineSegments.length > 0) {
      out.push(
        new LineLayer({
          id: 'profile-line-segments',
          data: lineSegments,
          getSourcePosition: (d) => d.source,
          getTargetPosition: (d) => d.target,
          getColor: (d) => d.color,
          widthUnits: 'pixels',
          getWidth: 1,
          pickable: false,
        }),
      );
    }
    if (markerStyle === 'billboard') {
      out.push(
        new ScatterplotLayer({
          id: 'profile-points',
          data: pointData,
          getPosition: (d) => d.position,
          getRadius: (d) => d.radius,
          radiusUnits: 'pixels',
          radiusMinPixels: 2,
          radiusMaxPixels: 12,
          billboard: true,
          getFillColor: (d) => d.fillColor,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 0, 0, 255],
        }),
      );
    } else {
      out.push(
        new SimpleMeshLayer({
          id: 'profile-points-mesh',
          data: pointData,
          mesh: sphereGeometry,
          getPosition: (d) => d.position,
          getColor: (d) => d.fillColor,
          getScale: (d) => [d.scale, d.scale, d.scale],
          material: { ambient: 0.35, diffuse: 0.6, shininess: 0, specularColor: [0, 0, 0] },
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 0, 0, 255],
        }),
      );
    }
    return out;
  }, [frame, markerStyle]);

  const layers = useMemo(() => {
    const base = cubeLayers();
    const labelLayer = new TextLayer({
      id: 'feature-space-labels',
      data: labels,
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getColor: (d) => d.color,
      getSize: 11,
      sizeUnits: 'pixels',
      billboard: true,
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 500,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      characterSet: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-[]/()\u00b0\u2013\u00b1\u00b2',
    });

    if (frame) return [...base, ...(profileLayers || []), labelLayer];

    return [
      ...base,
      new ScatterplotLayer({
        id: 'feature-space-points',
        data: scatterData,
        visible: markerStyle === 'billboard',
        getPosition: (d) => d.position,
        getRadius: (d) => d.radius,
        radiusUnits: 'pixels',
        radiusMinPixels: 1,
        radiusMaxPixels: 40,
        // Face the camera (default false draws the disc in the common-space XY
        // plane, which looks "up-facing" under OrbitView).
        billboard: true,
        getFillColor: (d) => d.fillColor,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 0, 0, 255],
        updateTriggers: {
          getFillColor: [colorScale, axes.color],
          getRadius: [sizeDomain, sizeRange, axes.size],
        },
      }),
      new SimpleMeshLayer({
        id: 'feature-space-points-mesh',
        data: scatterData,
        visible: markerStyle === 'sphere',
        mesh: sphereGeometry,
        getPosition: (d) => d.position,
        getColor: (d) => d.fillColor,
        getScale: (d) => [d.scale, d.scale, d.scale],
        // Matte spheres: no specular highlight, and ambient+diffuse <= 1 so the
        // face colour is not washed out and still reads true to the scale.
        material: { ambient: 0.35, diffuse: 0.6, shininess: 0, specularColor: [0, 0, 0] },
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 0, 0, 255],
        updateTriggers: {
          getColor: [colorScale, axes.color],
          getScale: [sizeDomain, sizeRange, axes.size],
        },
      }),
      labelLayer,
    ];
  }, [frame, profileLayers, labels, scatterData, colorScale, axes.color, axes.size, sizeDomain, sizeRange, markerStyle]);

  return (
    <div style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => setTooltip(null)}>
      <DeckGL
        views={view}
        initialViewState={{
          target: [0, 0, 0],
          // Canonical default view (matches three.js / Plotly): Z up, camera at
          // azimuth 45deg / elevation 30deg. OrbitView puts the camera at
          // [-d cosX sinOrbit, -d cosX cosOrbit, d sinX], so 30/225 -> (+, +, +).
          rotationX: 30,
          rotationOrbit: 225,
          zoom: 7.5,
          minZoom: 4,
          maxZoom: 12,
        }}
        controller
        layers={layers}
        getCursor={() => 'crosshair'}
        onHover={(info) => {
          const object = info.object ?? null;
          if (object) {
            setTooltip({ x: info.x, y: info.y, object });
          } else {
            setTooltip(null);
          }
          onHover(object ? object.id : null);
        }}
      />
      {tooltip && (
        <div style={{ position: 'absolute', left: tooltip.x + 14, top: tooltip.y + 14, zIndex: 5 }}>
          {frame ? <ProfileTooltip sample={tooltip.object.frameSample} curve={tooltip.object.curve} frame={frame} /> : <PointTooltip point={tooltip.object} axes={axes} />}
        </div>
      )}
    </div>
  );
}

export default DeckGLRenderer;

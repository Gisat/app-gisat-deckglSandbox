/**
 * deck.gl renderer for the 3D feature-space chart.
 *
 * Uses OrbitView (OrthographicView cannot rotate). Two modes:
 *  - scatter: points as shaded spheres (SimpleMeshLayer + luma.gl SphereGeometry)
 *    or billboarded discs (ScatterplotLayer), matching the map's marker style.
 *  - profile: one line per `frame.curves` entry (`PathLayer`), a translucent
 *    `z ± std` uncertainty ribbon per banded curve (3D `SolidPolygonLayer` quads,
 *    not in trend points) and per-sample points.
 *
 * A hand-built cube/axis overlay is needed because deck.gl ships no axes, grid
 * or ticks. Axis labels are TextLayer instances: deck.gl generates the SDF font
 * atlas in an offscreen canvas, so nothing is fetched from a CDN (important under
 * the app's COEP require-corp headers).
 */

import { useCallback, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { LineLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { scaleLinear } from 'd3-scale';
import { axisTitle, getAttribute } from '../attributes';
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

const GRID_COLOR = [232, 232, 232, 255];
const TICK_LABEL_COLOR = [110, 110, 110];
const TICK_LABEL_SIZE = 10;
const TITLE_SIZE = 11;

/** Static far-corner signs for the default camera (azimuth 225 / elevation 30). */
const DEFAULT_SIGNS = [-1, -1, -1];

/**
 * The [-CUBE, CUBE]^3 wireframe, minus the far-corner edges that a colored axis
 * shaft replaces. Drawing both would make the thin lines z-fight and hide the
 * axis color.
 */
function cubeSegments(signs, enabled) {
  const c = CUBE;
  const [sx, sy, sz] = signs;
  const corners = [
    [-c, -c, -c], [c, -c, -c], [c, c, -c], [-c, c, -c],
    [-c, -c, c], [c, -c, c], [c, c, c], [-c, c, c],
  ];
  const pairs = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs
    .map(([a, b]) => ({ source: corners[a], target: corners[b] }))
    .filter(({ source, target }) => {
      const same = (i) => source[i] === target[i];
      // Only drop the far edge when the matching colored shaft replaces it.
      if (enabled.x && same(1) && same(2) && source[1] === sy * c && source[2] === sz * c) return false;
      if (enabled.y && same(0) && same(2) && source[0] === sx * c && source[2] === sz * c) return false;
      if (enabled.z && same(0) && same(1) && source[0] === sx * c && source[1] === sy * c) return false;
      return true;
    });
}

/**
 * Far-corner signs for the current OrbitView camera. The colored axes and grid
 * sit on the faces opposite the camera, behind the data, and flip as the view
 * orbits.
 */
function farCornerSigns(rotationOrbit = 225, rotationX = 30) {
  const rad = Math.PI / 180;
  const cosX = Math.cos(rotationX * rad);
  const camX = -cosX * Math.sin(rotationOrbit * rad);
  const camY = -cosX * Math.cos(rotationOrbit * rad);
  const camZ = Math.sin(rotationX * rad);
  return [camX >= 0 ? -1 : 1, camY >= 0 ? -1 : 1, camZ >= 0 ? -1 : 1];
}

/** "Nice" numeric ticks for a domain, positioned in cube coordinates. */
function makeTicks(domain, format) {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
  return scaleLinear()
    .domain([min, max])
    .ticks(5)
    .map((value) => ({
      value,
      t: ((value - min) / (max - min)) * 2 * CUBE - CUBE,
      label: format(value),
    }));
}

/**
 * Tick formatter for the bare number (the unit lives in the axis title). The
 * decimal count follows the tick step, not the attribute's tooltip precision,
 * so a narrow domain does not collapse into identical labels.
 */
function axisTickFormatter(key, domain) {
  const [min, max] = domain;
  const span = Math.abs(max - min);
  if (!Number.isFinite(span) || span === 0) return (value) => String(value);
  const needed = Math.max(0, Math.ceil(-Math.log10(span / 5)));
  // Lon/lat always keep at least 4 decimals; everything else is step-driven.
  const decimals = getAttribute(key).coordinate
    ? Math.max(4, Math.min(6, needed))
    : Math.min(6, needed);
  return (value) => (Number.isFinite(value) ? value.toFixed(decimals) : '');
}

/**
 * Tick formatter for a profile axis. Lon/lat need their own precision, so they
 * must not go through the generic `formatTick` (which rounds to 1 decimal above
 * 10). Distance and trend axes keep the adaptive formatter.
 */
function profileTickFormatter(frame, slot) {
  if (frame.view === 'aggregate') {
    return slot === 'x'
      ? formatTick
      : axisTickFormatter(frame.valueKey, frame.axisDomains[slot]);
  }
  if (frame.view === 'attributes') {
    if (frame.basis === 'plan') {
      const key = slot === 'x' ? 'lon' : slot === 'y' ? 'lat' : frame.zKey;
      return axisTickFormatter(key, frame.axisDomains[slot]);
    }
    if (slot === 'x') return formatTick;
    return axisTickFormatter(slot === 'y' ? frame.yKey : frame.zKey, frame.axisDomains[slot]);
  }
  return formatTick; // trend: distance, window/step bands, settlement
}

/** Three axis shafts, at the far corner of the other two axes. */
function axisSegments(signs, enabled) {
  const c = CUBE;
  const [sx, sy, sz] = signs;
  return [
    { key: 'x', source: [-c, sy * c, sz * c], target: [c, sy * c, sz * c], color: AXIS_COLORS.x },
    { key: 'y', source: [sx * c, -c, sz * c], target: [sx * c, c, sz * c], color: AXIS_COLORS.y },
    { key: 'z', source: [sx * c, sy * c, -c], target: [sx * c, sy * c, c], color: AXIS_COLORS.z },
  ].filter((segment) => enabled[segment.key]);
}

function cubeLayers(signs, enabled) {
  return [
    new LineLayer({
      id: 'feature-space-cube',
      data: cubeSegments(signs, enabled),
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: [225, 225, 225, 255],
      widthUnits: 'pixels',
      getWidth: 0.5,
      pickable: false,
    }),
  ];
}

/**
 * Axis shafts, tick marks, light grid on the back faces, and the matching
 * title/tick labels. All geometry is generated in cube space and stays
 * depth-tested with the points.
 */
function axisOverlay({ signs, ticks, titles, enabled }) {
  const c = CUBE;
  // Colored axes, grid and labels all sit on the far corner, behind the data.
  const [sx, sy, sz] = signs;
  const tickOff = c + 0.08;
  const titleOff = c + 0.24;
  const mark = 0.04;

  const lines = axisSegments(signs, enabled);
  const titleLabels = [];
  const tickLabels = [];

  const pushTitle = (slot, position) => {
    if (!enabled[slot] || !titles[slot]) return;
    titleLabels.push({ position, text: titles[slot], color: AXIS_COLORS[slot], size: TITLE_SIZE });
  };
  const pushTick = (slot, position, label) => {
    if (!enabled[slot]) return;
    tickLabels.push({ position, text: label, color: TICK_LABEL_COLOR, size: TICK_LABEL_SIZE });
  };
  const pushGrid = (source, target) => {
    lines.push({ source, target, color: GRID_COLOR, width: 0.5 });
  };
  const pushMark = (slot, source, target) => {
    lines.push({ source, target, color: [...AXIS_COLORS[slot], 190], width: 0.5 });
  };

  if (enabled.x) {
    pushTitle('x', [0, sy * titleOff, sz * titleOff]);
    for (const tick of ticks.x) {
      pushTick('x', [tick.t, sy * tickOff, sz * tickOff], tick.label);
      pushMark('x', [tick.t, sy * c, sz * c], [tick.t, sy * (c + mark), sz * (c + mark)]);
      pushGrid([tick.t, -c, sz * c], [tick.t, c, sz * c]);
      pushGrid([tick.t, sy * c, -c], [tick.t, sy * c, c]);
    }
  }
  if (enabled.y) {
    pushTitle('y', [sx * titleOff, 0, sz * titleOff]);
    for (const tick of ticks.y) {
      pushTick('y', [sx * tickOff, tick.t, sz * tickOff], tick.label);
      pushMark('y', [sx * c, tick.t, sz * c], [sx * (c + mark), tick.t, sz * (c + mark)]);
      pushGrid([-c, tick.t, sz * c], [c, tick.t, sz * c]);
      pushGrid([sx * c, tick.t, -c], [sx * c, tick.t, c]);
    }
  }
  if (enabled.z) {
    pushTitle('z', [sx * titleOff, sy * titleOff, 0]);
    for (const tick of ticks.z) {
      pushTick('z', [sx * tickOff, sy * tickOff, tick.t], tick.label);
      pushMark('z', [sx * c, sy * c, tick.t], [sx * (c + mark), sy * (c + mark), tick.t]);
      pushGrid([-c, sy * c, tick.t], [c, sy * c, tick.t]);
      pushGrid([sx * c, -c, tick.t], [sx * c, c, tick.t]);
    }
  }

  return { lines, titleLabels, tickLabels, enabled };
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

  // Only the three far-corner signs are state: during an orbit the axis geometry
  // is rebuilt only when the camera crosses a cube face, not on every frame.
  const [signs, setSigns] = useState(DEFAULT_SIGNS);
  const handleViewStateChange = useCallback(({ viewState }) => {
    const next = farCornerSigns(viewState.rotationOrbit, viewState.rotationX);
    setSigns((prev) => (
      prev[0] === next[0] && prev[1] === next[1] && prev[2] === next[2] ? prev : next
    ));
  }, []);

  const axis = useMemo(() => {
    const titles = frame
      ? frame.titles
      : { x: axisTitle(axes.x), y: axisTitle(axes.y), z: axisTitle(axes.z) };
    // Aggregate pins Y to zero and carries no Y title, so leave the axis out.
    const enabled = { x: true, y: !(frame && frame.titles.y === ''), z: true };
    const ticks = frame
      ? {
          x: makeTicks(frame.axisDomains.x, profileTickFormatter(frame, 'x')),
          // Trend Y is categorical: reuse the band labels instead of numeric ticks.
          y: frame.yTicks
            ? frame.yTicks.map((tick) => ({ value: tick.value, t: tick.value, label: tick.label }))
            : makeTicks(frame.axisDomains.y, profileTickFormatter(frame, 'y')),
          z: makeTicks(frame.axisDomains.z, profileTickFormatter(frame, 'z')),
        }
      : {
          x: makeTicks([domains.x.min, domains.x.max], axisTickFormatter(axes.x, [domains.x.min, domains.x.max])),
          y: makeTicks([domains.y.min, domains.y.max], axisTickFormatter(axes.y, [domains.y.min, domains.y.max])),
          z: makeTicks([domains.z.min, domains.z.max], axisTickFormatter(axes.z, [domains.z.min, domains.z.max])),
        };
    return axisOverlay({ signs, ticks, titles, enabled });
  }, [axes, domains, frame, signs]);

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
      // Ribbon quads differ only in Z (lo/hi share X/Y), so a normal PolygonLayer
      // ear-cuts them in XY and emits no triangles. Tessellate in the largest-area
      // plane instead, the same setup the map curtains use for vertical walls.
      out.push(
        new SolidPolygonLayer({
          id: 'profile-ribbons',
          data: ribbons,
          getPolygon: (d) => d.polygon.flat(),
          getFillColor: (d) => d.fillColor,
          filled: true,
          extruded: false,
          _normalize: false,
          _full3d: true,
          // Keep the translucent band from z-fighting with the median line that
          // lies inside it (three.js also disables depth writes for the ribbon).
          parameters: { depthWrite: false },
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
          getWidth: 1,
          // Screen-space extrusion: without this the stroke is a horizontal
          // ribbon whose apparent width foreshortens as the chart rotates.
          billboard: true,
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
          getWidth: 0.75,
          billboard: true,
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

  const staticLayers = useMemo(() => {
    const base = cubeLayers(signs, axis.enabled);
    const axisLineLayer = axis.lines.length > 0
      ? new LineLayer({
          id: 'feature-space-axes',
          data: axis.lines,
          getSourcePosition: (d) => d.source,
          getTargetPosition: (d) => d.target,
          getColor: (d) => d.color,
          widthUnits: 'pixels',
          getWidth: (d) => d.width ?? 0.5,
          pickable: false,
        })
      : null;

    const textProps = {
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getColor: (d) => d.color,
      getSize: (d) => d.size,
      sizeUnits: 'pixels',
      billboard: true,
      fontFamily: 'system-ui, sans-serif',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      // Axis text must stay readable even when a sphere sits in front of it;
      // Plotly/three also keep labels above the marks.
      parameters: { depthTest: false, depthWrite: false },
      // Build the SDF atlas from the actual labels: the old fixed character set
      // omitted spaces and non-ASCII (units, Czech text).
      characterSet: 'auto',
    };
    const titleLayer = new TextLayer({
      id: 'feature-space-axis-titles',
      data: axis.titleLabels,
      ...textProps,
      fontWeight: 600,
    });
    const tickLayer = new TextLayer({
      id: 'feature-space-axis-ticks',
      data: axis.tickLabels,
      ...textProps,
      fontWeight: 400,
    });

    const axisLines = axisLineLayer ? [axisLineLayer] : [];
    const labels = [titleLayer, tickLayer];

    if (frame) return [...base, ...axisLines, ...(profileLayers || []), ...labels];

    return [
      ...base,
      ...axisLines,
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
      ...labels,
    ];
  }, [axis, frame, profileLayers, scatterData, colorScale, axes.color, axes.size, sizeDomain, sizeRange, markerStyle, signs]);

  // Plotly-style hover spikes: one axis-parallel line from the hovered point to
  // each far wall, plus the two cross-lines on each wall (`spikesides`). Kept in
  // its own memo so hovering does not rebuild the point layers.
  const hoveredPosition = tooltip?.object?.position ?? null;
  const hoverLayer = useMemo(() => {
    if (!hoveredPosition) return null;
    const [x, y, z] = hoveredPosition;
    const c = CUBE;
    const [fx, fy, fz] = signs;
    const data = [
      { source: [x, y, z], target: [fx * c, y, z] },
      { source: [x, y, z], target: [x, fy * c, z] },
      { source: [x, y, z], target: [x, y, fz * c] },
      { source: [fx * c, -c, z], target: [fx * c, c, z] },
      { source: [fx * c, y, -c], target: [fx * c, y, c] },
      { source: [-c, fy * c, z], target: [c, fy * c, z] },
      { source: [x, fy * c, -c], target: [x, fy * c, c] },
      { source: [-c, y, fz * c], target: [c, y, fz * c] },
      { source: [x, -c, fz * c], target: [x, c, fz * c] },
    ];
    return new LineLayer({
      id: 'feature-space-hover-spikes',
      data,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: [110, 110, 110, 220],
      widthUnits: 'pixels',
      getWidth: 1.5,
      pickable: false,
    });
  }, [hoveredPosition, signs]);

  const layers = useMemo(
    () => [...staticLayers, hoverLayer].filter(Boolean),
    [staticLayers, hoverLayer],
  );

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
        onViewStateChange={handleViewStateChange}
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

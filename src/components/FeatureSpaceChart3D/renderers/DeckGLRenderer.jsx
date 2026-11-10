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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { OrbitView, OrbitViewport } from '@deck.gl/core';
import { LineLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { scaleLinear } from 'd3-scale';
import { axisTitle, getAttribute } from '../attributes';
import { OFFSET_MARKER_SIZE, colorToRgba, sizeForValue } from '../colorScale';
import { computeAxisDomains, projectToCube } from '../transformPoints';
import { buildProfileFrame, formatTick, hexToRgba } from '../profileGeometry';
import { PointTooltip } from '../PointTooltip';
import { ProfileTooltip } from '../ProfileTooltip';
import { TimelineTooltip } from '../TimelineTooltip';

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
const GRID_WIDTH = 0.5;
/** Colored shafts are deliberately thicker than the grid/cube so the axis reads. */
const AXIS_WIDTH = 1.5;
const TICK_LABEL_COLOR = [110, 110, 110];
// Match the 2D timeline card's nivo theme: 10 px tick text, 11 px axis titles.
const TICK_LABEL_SIZE = 10;
const TITLE_SIZE = 11;

/** Static far-corner signs for the default camera (azimuth 225 / elevation 30). */
const DEFAULT_SIGNS = [-1, -1, -1];

/** Starting zoom, used only until the container is measured (see fitZoom below). */
const DEFAULT_ZOOM = 7.5;

/**
 * Projected extent of the [-1, 1]^3 cube at the default camera, in cube units.
 * Yawing 45deg makes the XY diagonal dominate: 2 * sqrt(2).
 */
const CUBE_PROJECTED_EXTENT = 2 * Math.SQRT2;
/** Fraction of the smallest viewport side the projected cube may occupy. */
const CUBE_FIT_FRACTION = 0.7;
/** Scatter/Custom gets extra margin so the sphere cloud and labels breathe. */
const SCATTER_FIT_FRACTION = 0.6;

/**
 * Zoom that fits the cube to the viewport with room for the axis titles/ticks.
 * Zoom is log2(px per world unit), so the cube spans extent * 2^zoom pixels.
 */
function fitZoom(width, height, fraction = CUBE_FIT_FRACTION) {
  const side = Math.min(width, height);
  if (!(side > 0)) return DEFAULT_ZOOM;
  return Math.log2((side * fraction) / CUBE_PROJECTED_EXTENT);
}

/**
 * Canonical default view (matches three.js / Plotly): Z up, camera at
 * azimuth 45deg / elevation 30deg. OrbitView puts the camera at
 * [-d cosX sinOrbit, -d cosX cosOrbit, d sinX], so 30/225 -> (+, +, +).
 */
const INITIAL_VIEW_STATE = {
  target: [0, 0, 0],
  rotationX: 30,
  rotationOrbit: 225,
  zoom: DEFAULT_ZOOM,
  minZoom: 4,
  maxZoom: 12,
};

/**
 * The [-CUBE, CUBE]^3 wireframe, minus the near/left edges that a colored axis
 * shaft replaces. Drawing both would make the thin lines z-fight and hide the
 * axis color.
 */
function cubeSegments(edges, enabled) {
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
  return pairs
    .map(([a, b]) => ({ source: corners[a], target: corners[b] }))
    .filter(({ source, target }) => {
      const same = (i) => source[i] === target[i];
      // Only drop the shaft edge when the matching colored axis replaces it.
      if (enabled.x && same(1) && same(2) && source[1] === edges.x.y * c && source[2] === edges.x.z * c) return false;
      if (enabled.y && same(0) && same(2) && source[0] === edges.y.x * c && source[2] === edges.y.z * c) return false;
      if (enabled.z && same(0) && same(1) && source[0] === edges.z.x * c && source[1] === edges.z.y * c) return false;
      return true;
    });
}

/**
 * Far-corner signs for the current OrbitView camera. The grid sits on the faces
 * opposite the camera, behind the data, and flips as the view orbits.
 */
function farCornerSigns(rotationOrbit = 225, rotationX = 30) {
  const rad = Math.PI / 180;
  const cosX = Math.cos(rotationX * rad);
  const camX = -cosX * Math.sin(rotationOrbit * rad);
  const camY = -cosX * Math.cos(rotationOrbit * rad);
  const camZ = Math.sin(rotationX * rad);
  return [camX >= 0 ? -1 : 1, camY >= 0 ? -1 : 1, camZ >= 0 ? -1 : 1];
}

/**
 * Plotly-style shaft edges, derived from the far-corner signs so they track the
 * camera: X/Y run on the two near-bottom edges, Z on the left vertical edge.
 * Grid lines stay on the far faces.
 */
function axisEdgeSigns(far) {
  const [fx, fy, fz] = far;
  const nx = -fx;
  const ny = -fy;
  return {
    x: { y: ny, z: fz },
    y: { x: nx, z: fz },
    z: { x: nx, y: fy },
  };
}

/**
 * World direction of each axis, used to orient the title along its shaft.
 * These stay axis-aligned: `axisEdgeSigns` only picks which edge a shaft sits
 * on (fixing the other two coordinates), never which way the shaft runs.
 */
const AXIS_DIRECTIONS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/**
 * `getAngle` (degrees) that aligns text with an axis in the current view.
 * TextLayer rotates the glyph quad counter-clockwise (the shader rotates, then
 * flips pixelOffset.y for its y-down atlas frame), while `viewport.project`
 * works in y-down screen coords, so the screen slope is negated. Titles are
 * kept upright like Plotly's, hence the fold into [-90, 90].
 */
function axisTitleAngle(viewport, position, direction) {
  // Half the cube half-extent: a long probe keeps the projected segment well
  // above the noise floor even at `minZoom`, and a straight 3D line projects to
  // a straight screen line, so the chord angle equals the line's angle.
  const eps = 0.5;
  const a = viewport.project([
    position[0] - direction[0] * eps,
    position[1] - direction[1] * eps,
    position[2] - direction[2] * eps,
  ]);
  const b = viewport.project([
    position[0] + direction[0] * eps,
    position[1] + direction[1] * eps,
    position[2] + direction[2] * eps,
  ]);
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // A probe landing exactly on the camera plane projects to Infinity (the
  // camera can get very close at the top of the zoom range).
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  // An axis pointing almost straight at the camera projects onto a few pixels,
  // where the angle is pure noise; leave that title horizontal instead.
  if (Math.hypot(dx, dy) < 2) return 0;
  // An axis can project to an exactly vertical line (the Z shaft at some
  // azimuths), leaving only float dust in dx. Without the snap the noise picks
  // between +90 and -90, flipping the reading direction; keep it bottom-to-top.
  if (Math.abs(dx) < 0.01) return dy < 0 ? 90 : -90;
  // Negate the y-down screen slope: positive `getAngle` turns text
  // counter-clockwise, so it aligns with (cos, -sin) rather than (cos, sin).
  let deg = -Math.atan2(dy, dx) * (180 / Math.PI);
  // Fold past vertical by 180 degrees so text never reads right-to-left or
  // upside down, matching Plotly's always-upright 3D titles.
  if (deg > 90) deg -= 180;
  if (deg < -90) deg += 180;
  return deg;
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
  if (frame.view === 'timeline') {
    // X uses the per-point band labels from `frame.xTicks` and Y the trend-step
    // labels from `frame.yTicks`; only Z (settlement, mm) remains here.
    return formatTick;
  }
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

/** Three axis shafts, on the near/left edges (Plotly placement). */
function axisSegments(edges, enabled) {
  const c = CUBE;
  return [
    { key: 'x', source: [-c, edges.x.y * c, edges.x.z * c], target: [c, edges.x.y * c, edges.x.z * c], color: AXIS_COLORS.x, width: AXIS_WIDTH },
    { key: 'y', source: [edges.y.x * c, -c, edges.y.z * c], target: [edges.y.x * c, c, edges.y.z * c], color: AXIS_COLORS.y, width: AXIS_WIDTH },
    { key: 'z', source: [edges.z.x * c, edges.z.y * c, -c], target: [edges.z.x * c, edges.z.y * c, c], color: AXIS_COLORS.z, width: AXIS_WIDTH },
  ].filter((segment) => enabled[segment.key]);
}

function cubeLayer(edges, enabled) {
  return new LineLayer({
    id: 'feature-space-cube',
    data: cubeSegments(edges, enabled),
    getSourcePosition: (d) => d.source,
    getTargetPosition: (d) => d.target,
    getColor: [225, 225, 225, 255],
    widthUnits: 'pixels',
    getWidth: GRID_WIDTH,
    pickable: false,
  });
}

/**
 * Axis shafts, light grid on the back faces, and the matching title/tick
 * labels. Shafts and labels sit on the near/left edges (Plotly placement); the
 * grid stays on the far faces behind the data. All geometry is generated in
 * cube space and stays depth-tested with the points.
 */
function axisOverlay({ edges, far, ticks, titles, enabled }) {
  const c = CUBE;
  const [fx, fy, fz] = far;
  const tickOff = c + 0.08;
  const titleOff = c + 0.24;

  const lines = axisSegments(edges, enabled);
  const titleLabels = [];
  const tickLabels = [];

  const pushTitle = (slot, position) => {
    if (!enabled[slot] || !titles[slot]) return;
    // The direction lets the title layer derive its screen angle from the live
    // camera; it is inert for every other consumer of the label datum.
    titleLabels.push({
      position,
      text: titles[slot],
      color: AXIS_COLORS[slot],
      size: TITLE_SIZE,
      direction: AXIS_DIRECTIONS[slot],
    });
  };
  const pushTick = (slot, position, label) => {
    if (!enabled[slot]) return;
    tickLabels.push({ position, text: label, color: TICK_LABEL_COLOR, size: TICK_LABEL_SIZE });
  };
  const pushGrid = (source, target) => {
    lines.push({ source, target, color: GRID_COLOR, width: GRID_WIDTH });
  };
  // A tick at the very end of the domain maps to ±CUBE, where its grid line
  // would land exactly on a wireframe edge and z-fight with it.
  const insideCube = (t) => Math.abs(t) < c - 1e-9;

  if (enabled.x) {
    pushTitle('x', [0, edges.x.y * titleOff, edges.x.z * titleOff]);
    for (const tick of ticks.x) {
      pushTick('x', [tick.t, edges.x.y * tickOff, edges.x.z * tickOff], tick.label);
      if (!insideCube(tick.t)) continue;
      pushGrid([tick.t, -c, fz * c], [tick.t, c, fz * c]);
      pushGrid([tick.t, fy * c, -c], [tick.t, fy * c, c]);
    }
  }
  if (enabled.y) {
    pushTitle('y', [edges.y.x * titleOff, 0, edges.y.z * titleOff]);
    for (const tick of ticks.y) {
      pushTick('y', [edges.y.x * tickOff, tick.t, edges.y.z * tickOff], tick.label);
      if (!insideCube(tick.t)) continue;
      pushGrid([-c, tick.t, fz * c], [c, tick.t, fz * c]);
      pushGrid([fx * c, tick.t, -c], [fx * c, tick.t, c]);
    }
  }
  if (enabled.z) {
    pushTitle('z', [edges.z.x * titleOff, edges.z.y * titleOff, 0]);
    for (const tick of ticks.z) {
      pushTick('z', [edges.z.x * tickOff, edges.z.y * tickOff, tick.t], tick.label);
      if (!insideCube(tick.t)) continue;
      pushGrid([-c, fy * c, tick.t], [c, fy * c, tick.t]);
      pushGrid([fx * c, -c, tick.t], [fx * c, c, tick.t]);
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
 * @param {{view:'attributes'|'trend'|'aggregate'|'timeline', yKey:string, zKey:string, trendLines:string, samples:Array<any>}} [props.profile]
 * @param {(id: string|null) => void} props.onHover
 * @param {(id: string) => void} [props.onPointClick]  select a picked point (map sphere + 2D timeline)
 * @param {boolean} [props.zoomOutScatter]  give the scatter/Custom view extra margin (compact embedded card)
 * @param {string[]} [props.velAvgPalette]  map-supplied ramp for the timeline curve colour
 */
export function DeckGLRenderer({ points, axes, colorScale, sizeDomain, sizeRange, markerStyle, profile, onHover, onPointClick, zoomOutScatter = false, velAvgPalette = null }) {
  const [tooltip, setTooltip] = useState(null);

  // Controlled camera: the axis labels are sized from the live clip-space depth
  // (see `labelSizeFactor`), so a re-render per interaction is required. Clone
  // the module constant so no mount can mutate the shared default object.
  const [viewState, setViewState] = useState(() => ({
    ...INITIAL_VIEW_STATE,
    target: [...INITIAL_VIEW_STATE.target],
  }));
  const viewStateRef = useRef(viewState);
  const containerRef = useRef(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // Refit when the chart type or the card height changes (e.g. the 2D timeline
  // opening below), while keeping user camera changes within one layout.
  const fitKey = profile ? `profile:${profile.view}` : 'scatter';

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const measure = () => setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit the cube to the measured container, so a compact card does not open with
  // the axis box cropped. The scatter/Custom view is zoomed out a little more.
  useEffect(() => {
    const { width, height } = viewportSize;
    if (!width || !height) return;
    const fraction = fitKey === 'scatter' && zoomOutScatter
      ? SCATTER_FIT_FRACTION
      : CUBE_FIT_FRACTION;
    const nextZoom = Math.max(
      INITIAL_VIEW_STATE.minZoom,
      Math.min(INITIAL_VIEW_STATE.maxZoom, fitZoom(width, height, fraction)),
    );
    if (Math.abs(nextZoom - viewStateRef.current.zoom) < 0.01) return;
    const merged = { ...viewStateRef.current, zoom: nextZoom };
    viewStateRef.current = merged;
    setViewState(merged);
  }, [viewportSize, fitKey, zoomOutScatter]);

  const domains = useMemo(() => computeAxisDomains(points, axes), [points, axes]);
  const frame = useMemo(
    () => (profile ? buildProfileFrame(profile, CUBE, velAvgPalette) : null),
    [profile, velAvgPalette],
  );

  const scatterData = useMemo(
    () =>
      points.map((p) => {
        const radius = sizeForValue(p[axes.size], sizeDomain, sizeRange);
        const t = sizeRange[1] === sizeRange[0] ? 0.5 : (radius - sizeRange[0]) / (sizeRange[1] - sizeRange[0]);
        return {
          ...p,
          position: projectToCube(p, axes, domains, CUBE),
          fillColor: colorToRgba(colorScale, p[axes.color]),
          // Billboard radius in pixels, matching the Plotly/three size channel,
          // and sphere radius in world units (SphereGeometry has radius 1), using
          // the same range as ThreeRenderer so the renderer switch keeps parity.
          radius,
          scale: 0.018 + t * 0.055,
        };
      }),
    [points, axes, domains, colorScale, sizeDomain, sizeRange],
  );

  // Only the three far-corner signs are state for the axis geometry: it is
  // rebuilt when the camera crosses a cube face, not on every frame. The camera
  // itself is tracked separately because TextLayer renders in clip space, where
  // the perspective divide (1/w) would otherwise scale labels with zoom.
  const [signs, setSigns] = useState(DEFAULT_SIGNS);
  const handleViewStateChange = useCallback(({ viewState: next }) => {
    // Read the previous camera from a ref so a partial event (e.g. a pan that
    // omits rotation) cannot snap the grid back to the default orientation.
    const prev = viewStateRef.current;
    const target = next.target ?? prev.target;
    const merged = {
      ...prev,
      ...next,
      target,
      zoom: next.zoom ?? prev.zoom,
      rotationX: next.rotationX ?? prev.rotationX,
      rotationOrbit: next.rotationOrbit ?? prev.rotationOrbit,
    };
    // Ignore repeat events that do not move the camera.
    if (
      prev.zoom === merged.zoom
      && prev.rotationX === merged.rotationX
      && prev.rotationOrbit === merged.rotationOrbit
      && prev.target[0] === target[0]
      && prev.target[1] === target[1]
      && prev.target[2] === target[2]
    ) return;
    viewStateRef.current = merged;
    setViewState(merged);
    const nextSigns = farCornerSigns(merged.rotationOrbit, merged.rotationX);
    setSigns((current) => (
      current[0] === nextSigns[0] && current[1] === nextSigns[1] && current[2] === nextSigns[2]
        ? current
        : nextSigns
    ));
  }, []);

  // Mirrors the OrbitView viewport so label anchors can be transformed into
  // clip space and their perspective factor read off the w component.
  const labelViewport = useMemo(() => new OrbitViewport({
    width: Math.max(1, viewportSize.width),
    height: Math.max(1, viewportSize.height),
    zoom: viewState.zoom,
    rotationX: viewState.rotationX,
    rotationOrbit: viewState.rotationOrbit,
    target: viewState.target,
    orbitAxis: 'Z',
    fovy: 45,
  }), [viewportSize, viewState]);

  // TextLayer offsets glyphs in clip space, so the perspective divide shrinks
  // text nearer the camera and grows it farther away. Scaling the requested
  // size by w / focalDistance cancels that and keeps one on-screen font size
  // through zooming and orbiting.
  const labelSizeFactor = useMemo(() => {
    const matrix = labelViewport.viewProjectionMatrix;
    const focal = labelViewport.focalDistance || 1;
    return (position) => {
      const w = matrix[3] * position[0] + matrix[7] * position[1] + matrix[11] * position[2] + matrix[15];
      return Number.isFinite(w) && w > 0 ? w / focal : 0;
    };
  }, [labelViewport]);

  const axis = useMemo(() => {
    const titles = frame
      ? frame.titles
      : { x: axisTitle(axes.x), y: axisTitle(axes.y), z: axisTitle(axes.z) };
    // Aggregate pins Y to zero (no Y title), so leave the whole axis out.
    const enabled = { x: true, y: !(frame && frame.view === 'aggregate'), z: true };
    const ticks = frame
      ? {
          x: frame.xTicks
            ? frame.xTicks.map((tick) => ({ value: tick.value, t: tick.value, label: tick.label }))
            : makeTicks(frame.axisDomains.x, profileTickFormatter(frame, 'x')),
          // Trend Y is categorical: reuse the band labels instead of numeric ticks.
          y: !enabled.y
            ? []
            : frame.yTicks
              ? frame.yTicks.map((tick) => ({ value: tick.value, t: tick.value, label: tick.label }))
              : makeTicks(frame.axisDomains.y, profileTickFormatter(frame, 'y')),
          z: makeTicks(frame.axisDomains.z, profileTickFormatter(frame, 'z')),
        }
      : {
          x: makeTicks([domains.x.min, domains.x.max], axisTickFormatter(axes.x, [domains.x.min, domains.x.max])),
          y: makeTicks([domains.y.min, domains.y.max], axisTickFormatter(axes.y, [domains.y.min, domains.y.max])),
          z: makeTicks([domains.z.min, domains.z.max], axisTickFormatter(axes.z, [domains.z.min, domains.z.max])),
        };
    return axisOverlay({ edges: axisEdgeSigns(signs), far: signs, ticks, titles, enabled });
  }, [axes, domains, frame, signs]);

  const view = useMemo(() => new OrbitView({ orbitAxis: 'Z', fovy: 45 }), []);

  const profileLayers = useMemo(() => {
    if (!frame) return null;

    // Timeline: one pickable path per point with a marker at each trend step,
    // no ribbons. Hovering a path or marker highlights it red and forwards the
    // point ID to the map.
    if (frame.view === 'timeline') {
      const pathData = frame.curves.map((c) => ({
        path: c.samples.map((p) => p.position),
        color: hexToRgba(c.color, 255),
        id: c.id,
        label: c.label,
        curve: c,
      }));
      const markerData = frame.curves.flatMap((c) => c.samples.map((p) => ({
        id: c.id,
        label: c.label,
        curve: c,
        position: p.position,
        fillColor: hexToRgba(c.color, 255),
      })));

      const pathLayer = new PathLayer({
        id: 'profile-timeline-lines',
        data: pathData,
        getPath: (d) => d.path,
        getColor: (d) => d.color,
        widthUnits: 'pixels',
        getWidth: 1.5,
        billboard: true,
        jointRounded: true,
        capRounded: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 0, 0, 255],
      });

      const markerLayer = markerStyle === 'billboard'
        ? new ScatterplotLayer({
            id: 'profile-timeline-points',
            data: markerData,
            getPosition: (d) => d.position,
            getRadius: 2.5,
            radiusUnits: 'pixels',
            radiusMinPixels: 1,
            radiusMaxPixels: 10,
            billboard: true,
            getFillColor: (d) => d.fillColor,
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 0, 0, 255],
          })
        : new SimpleMeshLayer({
            id: 'profile-timeline-points-mesh',
            data: markerData,
            mesh: sphereGeometry,
            getPosition: (d) => d.position,
            getColor: (d) => d.fillColor,
            getScale: () => [0.014, 0.014, 0.014],
            material: { ambient: 0.35, diffuse: 0.6, shininess: 0, specularColor: [0, 0, 0] },
            pickable: true,
            autoHighlight: true,
            highlightColor: [255, 0, 0, 255],
          });

      return [pathLayer, markerLayer];
    }

    // Trend ▸ points uses thinner lines and smaller marks; the other profile
    // views keep their current weight.
    const pointsMode = frame.shape === 'points';
    const aggregateView = frame.view === 'aggregate';
    const sizeByOffset = frame.sizeByOffset;
    // Billboard radius (px) and sphere radius (world units) mirror ThreeRenderer.
    const baseRadius = pointsMode ? 3 : 4;
    const baseWorld = pointsMode ? 0.017 : 0.03;
    const [minRadius, maxRadius] = pointsMode ? OFFSET_MARKER_SIZE.pointsRadius : OFFSET_MARKER_SIZE.radius;
    const [minWorld, maxWorld] = pointsMode ? OFFSET_MARKER_SIZE.pointsWorld : OFFSET_MARKER_SIZE.world;

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
            // The perpendicular offset maps the mark across the compact
            // OFFSET_MARKER_SIZE range (bigger offset = bigger mark).
            radius: off == null ? baseRadius : minRadius + off * (maxRadius - minRadius),
            scale: off == null ? baseWorld : minWorld + off * (maxWorld - minWorld),
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
    // Screen-space extrusion: without it the stroke is a horizontal ribbon whose
    // apparent width foreshortens as the chart rotates.
    const curvePathLayer = (id, data, width, alpha) => new PathLayer({
      id,
      data,
      getPath: (d) => d.path,
      getColor: alpha == null
        ? (d) => d.color
        : (d) => [d.color[0], d.color[1], d.color[2], alpha],
      widthUnits: 'pixels',
      getWidth: width,
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: false,
    });

    if (linePaths.length > 0) {
      out.push(curvePathLayer('profile-lines', linePaths, 1));
    }
    if (interpPaths.length > 0) {
      // Interpolated runs: thinner + translucent (deck.gl has no native dashes).
      out.push(curvePathLayer('profile-lines-interpolated', interpPaths, 0.75, 140));
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
          // LineLayer has no screen-space extrusion, so the settlement-coloured
          // segments still foreshorten with the camera; keeping them as lines
          // avoids one PathLayer per segment.
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
          radiusMinPixels: 1,
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
    const base = [cubeLayer(axisEdgeSigns(signs), axis.enabled)];
    const axisLineLayer = axis.lines.length > 0
      ? new LineLayer({
          id: 'feature-space-axes',
          data: axis.lines,
          getSourcePosition: (d) => d.source,
          getTargetPosition: (d) => d.target,
          getColor: (d) => d.color,
          widthUnits: 'pixels',
          getWidth: (d) => d.width ?? GRID_WIDTH,
          pickable: false,
        })
      : null;

    const axisLines = axisLineLayer ? [axisLineLayer] : [];

    if (frame) return [...base, ...axisLines, ...(profileLayers || [])];

    const markerLayer = markerStyle === 'billboard'
      ? new ScatterplotLayer({
          id: 'feature-space-points',
          data: scatterData,
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
        })
      : new SimpleMeshLayer({
          id: 'feature-space-points-mesh',
          data: scatterData,
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
        });

    return [...base, ...axisLines, markerLayer];
  }, [axis, signs, frame, profileLayers, scatterData, colorScale, axes.color, axes.size, sizeDomain, sizeRange, markerStyle]);

  // Labels live in their own memo: only their sizes depend on the camera, so
  // orbiting/zooming refreshes ~20 glyphs instead of every point attribute.
  const labelLayers = useMemo(() => {
    // Wait for the first container measurement: before it the mirrored viewport
    // is a placeholder and the compensated sizes would be wrong.
    if (viewportSize.width === 0 || viewportSize.height === 0) return [];

    // Labels whose anchor is at/behind the camera have no valid perspective
    // factor; drop them instead of drawing mirrored or zero-sized text. The
    // compensated size is baked into the datum so `getSize` stays a read.
    const scaleLabels = (labels) => labels.flatMap((d) => {
      const factor = labelSizeFactor(d.position);
      return factor > 0 ? [{ ...d, size: d.size * factor }] : [];
    });
    const titleData = scaleLabels(axis.titleLabels);
    const tickData = scaleLabels(axis.tickLabels);

    const textProps = {
      getPosition: (d) => d.position,
      getText: (d) => d.text,
      getColor: (d) => d.color,
      // Perspective-compensated: keeps a single on-screen font size while
      // zooming and orbiting (see `labelSizeFactor`).
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
    return [
      new TextLayer({
        id: 'feature-space-axis-titles',
        data: titleData,
        ...textProps,
        fontWeight: 400,
        // Titles run along their shaft (Plotly behaviour). `billboard: true`
        // still draws them screen-facing; `getAngle` only spins them within
        // that plane, so this is a screen-space rotation, not a 3D tilt.
        getAngle: (d) => axisTitleAngle(labelViewport, d.position, d.direction),
      }),
      new TextLayer({
        id: 'feature-space-axis-ticks',
        data: tickData,
        ...textProps,
        // Ticks stay horizontal like Plotly's 3D tick labels, so they keep the
        // default angle; the rotation belongs to the title layer alone.
        fontWeight: 400,
      }),
    ];
  }, [axis, labelSizeFactor, labelViewport, viewportSize]);

  // Plotly-style hover spikes: one axis-parallel line from the hovered point to
  // each far wall, plus the two cross-lines on each wall (`spikesides`). Kept in
  // its own memo so hovering does not rebuild the point layers. Timeline path
  // objects carry no `position`, but its step markers do, so hovering a marker
  // shows the same helper axes as the other views.
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
      getColor: [175, 175, 175, 235],
      widthUnits: 'pixels',
      getWidth: 1,
      pickable: false,
    });
  }, [hoveredPosition, signs]);

  // Labels are last: they disable the depth test, so drawing the hover spikes
  // after them would paint the spikes over the axis text.
  const layers = useMemo(
    () => [...staticLayers, hoverLayer, ...labelLayers].filter(Boolean),
    [staticLayers, labelLayers, hoverLayer],
  );

  return (
    <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => setTooltip(null)}>
      <DeckGL
        views={view}
        viewState={viewState}
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
        onClick={(info) => {
          const object = info.object ?? null;
          if (onPointClick && object && object.id != null) onPointClick(object.id);
        }}
      />
      {tooltip && (
        <div style={{ position: 'absolute', left: tooltip.x + 14, top: tooltip.y + 14, zIndex: 5 }}>
          {frame?.view === 'timeline' ? (
            <TimelineTooltip curve={tooltip.object.curve} />
          ) : frame ? (
            <ProfileTooltip sample={tooltip.object.frameSample} curve={tooltip.object.curve} frame={frame} />
          ) : (
            <PointTooltip point={tooltip.object} axes={axes} />
          )}
        </div>
      )}
    </div>
  );
}

export default DeckGLRenderer;

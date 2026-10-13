/**
 * deck.gl renderer for the 3D feature-space chart.
 *
 * Uses OrbitView (OrthographicView cannot rotate). Points are drawn as shaded
 * spheres with SimpleMeshLayer + a luma.gl SphereGeometry (ScatterplotLayer only
 * draws flat billboarded discs), matching the map's marker style, with per-point
 * scale for the size channel. A hand-built cube/axis overlay is needed because
 * deck.gl ships no axes, grid or ticks. Axis labels are TextLayer instances:
 * deck.gl generates the SDF font atlas in an offscreen canvas, so nothing is
 * fetched from a CDN (important under the app's COEP require-corp headers).
 */

import { useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { OrbitView } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { axisTitle, formatValue } from '../attributes';
import { colorToRgba, sizeForValue } from '../colorScale';
import { computeAxisDomains, projectToCube } from '../transformPoints';
import { PointTooltip } from '../PointTooltip';

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

/**
 * @param {Object} props
 * @param {Array<import('../transformPoints').FeatureSpacePoint>} props.points
 * @param {import('../attributes').PresetAxes} props.axes
 * @param {ReturnType<import('../colorScale').buildColorScale>} props.colorScale
 * @param {[number, number]} props.sizeDomain
 * @param {[number, number]} props.sizeRange
 * @param {'billboard'|'sphere'} props.markerStyle
 * @param {(id: string|null) => void} props.onHover
 */
export function DeckGLRenderer({ points, axes, colorScale, sizeDomain, sizeRange, markerStyle, onHover }) {
  const [tooltip, setTooltip] = useState(null);

  const domains = useMemo(() => computeAxisDomains(points, axes), [points, axes]);

  const data = useMemo(
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
  }, [axes, domains]);

  const view = useMemo(() => new OrbitView({ orbitAxis: 'Z', fovy: 45 }), []);

  const layers = useMemo(
    () => [
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
      new ScatterplotLayer({
        id: 'feature-space-points',
        data,
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
        data,
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
      new TextLayer({
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
        characterSet: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-[]/()\u00b0\u2013',
      }),
    ],
    [data, labels, colorScale, axes.color, axes.size, sizeDomain, sizeRange, markerStyle],
  );

  return (
    <div style={{ position: 'absolute', inset: 0 }} onMouseLeave={() => setTooltip(null)}>
      <DeckGL
        views={view}
        initialViewState={{
          target: [0, 0, 0],
          rotationX: 30,
          rotationOrbit: -30,
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
            setTooltip({ x: info.x, y: info.y, point: object });
          } else {
            setTooltip(null);
          }
          onHover(object ? object.id : null);
        }}
      />
      {tooltip && (
        <div style={{ position: 'absolute', left: tooltip.x + 14, top: tooltip.y + 14, zIndex: 5 }}>
          <PointTooltip point={tooltip.point} axes={axes} />
        </div>
      )}
    </div>
  );
}

export default DeckGLRenderer;

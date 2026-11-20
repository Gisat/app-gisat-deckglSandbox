// Local-frame 3D inspector for the focused pylon: the same OBJ tower the map
// draws, the structural section boundaries the ring rig uses, and the active
// track's scatterers coloured by KTEMP / VEL_AVG / section. Everything is in
// metres with [0,0,0] at the tower base centre (+X east, +Y north, +Z up), so
// `H_REF` (already ground-relative in this dataset) is used as local z directly.
import { useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { COORDINATE_SYSTEM, OrbitView } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import {
  METRES_PER_DEG_LAT,
  RING_SEGMENTS,
  getSectionLayout,
  metresPerDegLon,
} from './tracks';
import { bandIndexOf } from './rigData';
import { POLAKY_VEL_AVG_DOMAIN } from './velAvgPalette';
import { PYLON_MODELS, getPylonOrientation } from './pylonModels';

// Stable empty input: the tower keeps rendering while a track's points load.
const EMPTY = [];
// One trivial instance for the tower mesh: `SimpleMeshLayer` renders nothing
// with its default empty `data`, even though the mesh, scale and orientation
// are constants here.
const MESH_DATA = [{}];

// Local rings are tighter than the map's 15 m rig rings: the chart has no
// sibling towers to avoid, and a 12 m radius still clears the widest cross-arms.
const SECTION_RING_RADIUS_M = 12;
const KTEMP_DOMAIN = [0, 0.8];
const KTEMP_STOPS = [[56, 142, 232], [45, 190, 175], [245, 145, 55]];
const SECTION_COLORS = [[90, 169, 255], [79, 209, 197], [246, 173, 85]];
const NEUTRAL_COLOR = [140, 148, 158];
const SELECTION_COLOR = [66, 212, 244];
const HOVER_COLOR = [255, 0, 0];
const DIM_ALPHA = 45;

const COLOR_MODES = [
  { id: 'ktemp', label: 'KTEMP' },
  { id: 'vel', label: 'VEL_AVG' },
  { id: 'section', label: 'Section' },
];

const KTEMP_GRADIENT = `linear-gradient(to right, ${
  KTEMP_STOPS.map(stop => `rgb(${stop.join(', ')})`).join(', ')
})`;

const CARD_STYLE = {
  position: 'relative',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  padding: '8px 10px 10px',
  background: 'rgba(32, 35, 41, 0.95)',
  border: '1px solid #484d55',
  borderRadius: '8px',
  boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
  fontFamily: 'system-ui, sans-serif',
};

const CHART_AREA_STYLE = {
  flex: 1,
  minHeight: 0,
  position: 'relative',
};

const CAPTION_STYLE = {
  marginTop: '4px',
  fontSize: '10px',
  color: '#9aa0a8',
};

// Same pill look as the map's track / rig switchers, kept local because the
// chart must not import from `index.jsx`.
function modeButtonStyle(active) {
  return {
    minHeight: '24px',
    padding: '4px 8px',
    border: `1px solid ${active ? '#5aa9ff' : '#4a4f57'}`,
    borderRadius: '4px',
    background: active ? '#2f4a6b' : '#2a2d33',
    color: '#dfe3e8',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: '11px',
    fontWeight: active ? 600 : 400,
  };
}

function numeric(value) {
  // `Number(null)` is 0, so reject empty values first: missing attributes must
  // read as no data and never as a real zero.
  if (value == null || value === '') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

// Linear RGB interpolation over a stop list, clamped to [0, 1]. `tracks.js` has
// the same maths privately; re-implemented here to keep that module untouched.
function rampColor(stops, t) {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const from = stops[index];
  const to = stops[index + 1];
  return [
    Math.round(from[0] + (to[0] - from[0]) * frac),
    Math.round(from[1] + (to[1] - from[1]) * frac),
    Math.round(from[2] + (to[2] - from[2]) * frac),
  ];
}

// Every hyphen part is capitalised, so the portal layout reads `Cross-Beam`.
function sectionTitle(label) {
  const text = label ?? 'section';
  return text
    .split('-')
    .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join('-');
}

function formatValue(value, digits) {
  if (value == null || value === '') return '–';
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

// Closed horizontal loop at `z`; the first vertex is repeated so the ring path
// closes without a `closed` flag.
function circlePath(z, radius, segments) {
  const path = [];
  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * Math.PI * 2;
    path.push([Math.cos(angle) * radius, Math.sin(angle) * radius, z]);
  }
  return path;
}

function ktempColor(value) {
  if (!Number.isFinite(value)) return NEUTRAL_COLOR;
  const [min, max] = KTEMP_DOMAIN;
  const clamped = Math.max(min, Math.min(max, value));
  return rampColor(KTEMP_STOPS, (clamped - min) / (max - min));
}

function velAvgColor(value, colorScale) {
  if (!Number.isFinite(value) || typeof colorScale !== 'function') return NEUTRAL_COLOR;
  const [min, max] = POLAKY_VEL_AVG_DOMAIN;
  const clamped = Math.max(min, Math.min(max, value));
  const rgb = colorScale(clamped).rgb();
  return [rgb[0], rgb[1], rgb[2]];
}

function rgbCss(rgb) {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * Tower + section-ring + scatterer inspector for the focused pylon.
 *
 * @param {{
 *   pylon: any, pylonFeature: any, activeTrack: any, colorScale: any,
 *   selectedPointId: any, hoveredPointId: any, activeSectionIndex: number|null,
 *   onSelectSection: (bandIndex: number|null) => void,
 *   onPointHover: (id: any) => void, onPointClick: (id: any) => void,
 *   onClose: () => void,
 * }} props
 */
export default function PylonScatter3DChart({
  pylon,
  pylonFeature,
  activeTrack,
  colorScale,
  selectedPointId,
  hoveredPointId,
  activeSectionIndex,
  onSelectSection,
  onPointHover,
  onPointClick,
  onClose,
}) {
  const [colorMode, setColorMode] = useState('ktemp');

  const pylonTyp = pylon?.typ ?? null;
  const pylonId = pylon?.id ?? '–';
  const pylonLon = Number(pylon?.lon);
  const pylonLat = Number(pylon?.lat);
  const rawHeight = Number(pylon?.height);
  const pylonHeight = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 0;
  const activeTrackId = activeTrack?.id;
  const trackPoints = pylon?.byTrack?.[activeTrackId] ?? EMPTY;

  const layout = useMemo(() => getSectionLayout(pylonTyp), [pylonTyp]);
  const meshModel = useMemo(
    () => PYLON_MODELS.find(model => model.typ === pylonTyp) ?? null,
    [pylonTyp],
  );

  // One local-frame datum per InSAR scatterer. Section assignment goes through
  // the same `bandIndexOf` the rig uses, so the chart cannot disagree with the
  // rings; a missing `H_REF` falls back to `H - H_dem` and then to the base.
  const points = useMemo(() => {
    if (!(pylonHeight > 0) || !Number.isFinite(pylonLon) || !Number.isFinite(pylonLat)) return EMPTY;
    const mPerDegLon = metresPerDegLon(pylonLat);
    const out = [];
    for (const feature of trackPoints) {
      const lon = Number(feature?.geometry?.coordinates?.[0]);
      const lat = Number(feature?.geometry?.coordinates?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

      const props = feature?.properties ?? {};
      const hRefRaw = numeric(props.H_REF);
      const hMinusDem = numeric(props.H) - numeric(props.H_dem);
      const hRef = Number.isFinite(hRefRaw) ? hRefRaw : Number.isFinite(hMinusDem) ? hMinusDem : 0;
      const sectionIndex = bandIndexOf(hRef, pylonHeight, layout.assignFractions);

      out.push({
        id: props.ID ?? null,
        position: [
          (lon - pylonLon) * mPerDegLon,
          (lat - pylonLat) * METRES_PER_DEG_LAT,
          hRef,
        ],
        hRef,
        coh: numeric(props.COH),
        ktemp: numeric(props.KTEMP),
        velAvg: numeric(props.VEL_AVG),
        sectionIndex,
        sectionLabel: layout.labels[sectionIndex] ?? 'section',
      });
    }
    return out;
  }, [trackPoints, pylonLon, pylonLat, pylonHeight, layout]);

  // Cut heights [0, f1 × h, …, h] paired into one band per structural section.
  const sectionBounds = useMemo(() => {
    const cuts = [0, ...layout.assignFractions.map(fraction => fraction * pylonHeight), pylonHeight];
    const bounds = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      bounds.push({ lo: cuts[i], hi: cuts[i + 1] });
    }
    return bounds;
  }, [layout, pylonHeight]);

  const sectionRings = useMemo(() => {
    const rings = [];
    for (const fraction of layout.assignFractions) {
      rings.push({
        path: circlePath(fraction * pylonHeight, SECTION_RING_RADIUS_M, RING_SEGMENTS),
        color: [255, 255, 255, 110],
        width: 1.2,
      });
    }
    rings.push({
      path: circlePath(0.1, SECTION_RING_RADIUS_M, RING_SEGMENTS),
      color: [255, 255, 255, 70],
      width: 0.8,
    });
    rings.push({
      path: circlePath(pylonHeight, SECTION_RING_RADIUS_M, RING_SEGMENTS),
      color: [255, 255, 255, 70],
      width: 0.8,
    });

    // Cyan bracket on the section selected from the map: two rings at its exact
    // cut heights, matching the ring stack's own highlight colour.
    const activeBounds = Number.isInteger(activeSectionIndex)
      ? sectionBounds[activeSectionIndex]
      : null;
    if (activeBounds) {
      for (const z of [activeBounds.lo, activeBounds.hi]) {
        rings.push({
          path: circlePath(z, SECTION_RING_RADIUS_M, RING_SEGMENTS),
          color: [66, 212, 244, 230],
          width: 2.4,
        });
      }
    }
    return rings;
  }, [layout, pylonHeight, activeSectionIndex, sectionBounds]);

  // One label per structural section, doubling as the chart's section pick
  // target: clicking a label forwards its index so the ring stack can highlight
  // the same section the map rings do.
  const sectionLabels = useMemo(() => {
    const counts = layout.labels.map(() => 0);
    for (const point of points) {
      if (counts[point.sectionIndex] != null) counts[point.sectionIndex] += 1;
    }
    return layout.labels.map((label, index) => {
      const bounds = sectionBounds[index];
      return {
        sectionIndex: index,
        active: index === activeSectionIndex,
        text: `${sectionTitle(label)} (${counts[index]}) pts`,
        position: [13.5, 0, bounds ? (bounds.lo + bounds.hi) / 2 : pylonHeight / 2],
      };
    });
  }, [points, layout, sectionBounds, pylonHeight, activeSectionIndex]);

  // 11-stop sample of the same per-orbit ramp the map symbols use.
  const velLegendBackground = useMemo(
    () => (typeof colorScale === 'function' && typeof colorScale.colors === 'function'
      ? `linear-gradient(to right, ${colorScale.colors(11).join(', ')})`
      : rgbCss(NEUTRAL_COLOR)),
    [colorScale],
  );

  const initialViewState = useMemo(() => ({
    target: [0, 0, pylonHeight * 0.5],
    zoom: 2.3,
    rotationX: 22,
    rotationOrbit: -35,
    minZoom: 0.8,
    maxZoom: 8,
  }), [pylonHeight]);

  const view = useMemo(() => new OrbitView({ orbitAxis: 'Z', fovy: 45 }), []);

  const layers = useMemo(() => {
    const pointColor = (point) => {
      if (colorMode === 'vel') return velAvgColor(point.velAvg, colorScale);
      if (colorMode === 'section') return SECTION_COLORS[point.sectionIndex] ?? NEUTRAL_COLOR;
      return ktempColor(point.ktemp);
    };

    const getFillColor = (point) => {
      if (selectedPointId != null && String(point.id) === String(selectedPointId)) {
        return [...SELECTION_COLOR, 255];
      }
      if (hoveredPointId != null && String(point.id) === String(hoveredPointId)) {
        return [...HOVER_COLOR, 255];
      }
      const dimmed = activeSectionIndex != null && point.sectionIndex !== activeSectionIndex;
      return [...pointColor(point), dimmed ? DIM_ALPHA : 255];
    };

    // A thin cyan outline only on points inside the selected section, so the
    // dimmed cloud still reads as one group.
    const getLineColor = (point) => (
      activeSectionIndex != null && point.sectionIndex === activeSectionIndex
        ? [66, 212, 244, 220]
        : [0, 0, 0, 0]
    );

    const result = [];

    if (meshModel) {
      const scale = pylonHeight / meshModel.nativeHeight;
      result.push(new SimpleMeshLayer({
        id: 'chart-pylon-mesh',
        data: MESH_DATA,
        mesh: meshModel.mesh,
        loaders: [OBJLoader],
        coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
        position: [0, 0, 0],
        getScale: [scale, scale, scale],
        getOrientation: () => getPylonOrientation(pylonFeature),
        getColor: [183, 188, 193, 130],
        pickable: false,
      }));
    }

    result.push(new PathLayer({
      id: 'chart-section-rings',
      data: sectionRings,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPath: (ring) => ring.path,
      getColor: (ring) => ring.color,
      getWidth: (ring) => ring.width,
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: false,
    }));

    result.push(new TextLayer({
      id: 'chart-section-labels',
      data: sectionLabels,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (label) => label.position,
      getText: (label) => label.text,
      // The active section's label carries the same cyan as its bracket rings.
      getColor: (label) => (label.active ? [...SELECTION_COLOR] : [232, 236, 241]),
      getSize: 11,
      sizeUnits: 'pixels',
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: 600,
      billboard: true,
      pickable: true,
    }));

    result.push(new ScatterplotLayer({
      id: 'chart-pylon-scatterers',
      data: points,
      coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
      getPosition: (point) => point.position,
      radiusUnits: 'meters',
      getRadius: (point) => 0.45 + Math.max(0, Math.min(1, Number.isFinite(point.coh) ? point.coh : 0)) * 0.7,
      radiusMaxPixels: 12,
      getFillColor,
      stroked: true,
      getLineColor,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      billboard: true,
      pickable: true,
      // deck.gl keeps the attribute buffers unless an update trigger changes;
      // the accessors alone are not compared, so recolouring needs these.
      updateTriggers: {
        getFillColor: [colorMode, colorScale, activeSectionIndex, selectedPointId, hoveredPointId],
        getLineColor: [activeSectionIndex],
      },
    }));

    return result;
  }, [
    meshModel,
    pylonHeight,
    pylonFeature,
    sectionRings,
    sectionLabels,
    points,
    colorMode,
    colorScale,
    activeSectionIndex,
    selectedPointId,
    hoveredPointId,
  ]);

  const chipLabel = Number.isInteger(activeSectionIndex) && layout.labels[activeSectionIndex]
    ? sectionTitle(layout.labels[activeSectionIndex])
    : null;

  return (
    <div style={CARD_STYLE}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, color: '#e8eaed', whiteSpace: 'nowrap' }}>
          {`Pylon ${pylonId} (${pylonTyp ?? '–'}) · ${activeTrackId ?? '–'}`}
        </div>
        <div style={{ fontSize: '11px', color: '#b3b8bf' }}>
          {points.length} pts
        </div>
        {chipLabel && (
          <button
            type="button"
            onClick={() => onSelectSection(null)}
            aria-label={`Clear ${chipLabel} section filter`}
            style={{
              padding: '1px 6px',
              fontSize: '10px',
              color: '#42d4f4',
              background: 'rgba(66, 212, 244, 0.12)',
              border: '1px solid #42d4f4',
              borderRadius: '10px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {`Section: ${chipLabel} ×`}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close pylon inspector"
          style={{
            marginLeft: 'auto',
            width: '22px',
            height: '22px',
            lineHeight: '18px',
            padding: 0,
            fontSize: '16px',
            color: '#b3b8bf',
            background: 'none',
            border: '1px solid #4a4f57',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
        <span style={{ fontSize: '10px', color: '#9aa0a8' }}>Color:</span>
        {COLOR_MODES.map(mode => (
          <button
            key={mode.id}
            type="button"
            aria-pressed={colorMode === mode.id}
            onClick={() => setColorMode(mode.id)}
            style={modeButtonStyle(colorMode === mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      <div style={{ minHeight: '14px', marginBottom: '4px' }}>
        {colorMode === 'ktemp' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: KTEMP_GRADIENT }} />
            <span style={{ fontSize: '10px', color: '#b3b8bf', whiteSpace: 'nowrap' }}>
              0.0 · 0.4 · 0.8+ mm/°C
            </span>
          </div>
        )}
        {colorMode === 'vel' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <div style={{
              flex: 1,
              height: '6px',
              borderRadius: '3px',
              background: velLegendBackground,
            }} />
            <span style={{ fontSize: '10px', color: '#b3b8bf', whiteSpace: 'nowrap' }}>
              −2.5 · 0 · +2.5 mm/yr
            </span>
          </div>
        )}
        {colorMode === 'section' && (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '10px',
            fontSize: '10px',
            color: '#b3b8bf',
          }}>
            {layout.labels.map((label, index) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  background: rgbCss(SECTION_COLORS[index] ?? NEUTRAL_COLOR),
                }} />
                {sectionTitle(label)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={CHART_AREA_STYLE}>
        <div style={{ position: 'absolute', inset: 0 }}>
          <DeckGL
            views={view}
            initialViewState={initialViewState}
            controller
            layers={layers}
            getTooltip={({ object, layer }) => (
              object && layer?.id === 'chart-pylon-scatterers'
                ? {
                  text: [
                    `ID ${object.id ?? '–'}`,
                    sectionTitle(object.sectionLabel),
                    `H_REF ${formatValue(object.hRef, 2)} m`,
                    `KTEMP ${formatValue(object.ktemp, 2)} mm/°C`,
                    `VEL_AVG ${formatValue(object.velAvg, 2)} mm/yr`,
                    `COH ${formatValue(object.coh, 2)}`,
                  ].join('\n'),
                }
                : null
            )}
            onHover={({ object, layer }) => {
              const isPoint = layer?.id === 'chart-pylon-scatterers';
              onPointHover(isPoint ? object?.id ?? null : null);
            }}
            onClick={({ object, layer }) => {
              if (!object) return;
              if (layer?.id === 'chart-section-labels') {
                onSelectSection(object.sectionIndex);
                return;
              }
              if (layer?.id === 'chart-pylon-scatterers') onPointClick(object.id);
            }}
          />
        </div>
      </div>

      <div style={CAPTION_STYLE}>
        {`Drag to orbit · Scroll to zoom · Click a section label to filter · Z: H_REF (0–${pylonHeight.toFixed(0)} m) · Size: COH`}
      </div>
    </div>
  );
}

import { ScatterplotLayer } from '@deck.gl/layers';
import type { Accessor, Color, Layer } from '@deck.gl/core';
import { DynamicArrowLayer } from '../DynamicArrowLayer';
import {
  computeArrowHeading,
  isNonDominantOrbit,
  isSphere,
  SMALL_SPHERE_RADIUS_METERS,
  SPHERE_RADIUS_METERS
} from '../velocity/velocitySymbols';
import {
  computeArrowRadius,
  computeHeadSizeFraction,
  computeHeadWidthFraction,
  computeStemLengthFraction,
  computeStemThicknessFraction,
  metersToArrowFraction
} from '../velocity/velocityArrow';
import {
  ARROW_SHAPE_PRESET_STROKE_WIDTH_SCALE,
  getArrowShapePreset,
  type ArrowShapePresetId
} from '../velocity/arrowShapePresets';
import {
  DEFAULT_FEATURE_FILL_RGBA,
  VELOCITY_COLORMAP,
  VELOCITY_DESCENDING_COLORMAP,
  type RgbaColor
} from '../velocity/velocityColormap';
import {
  NON_SELECTED_FEATURE_LINE_COLOR,
  NON_SELECTED_FEATURE_LINE_WIDTH,
  SELECTED_FEATURE_LINE_WIDTH
} from '../velocity/selection';
import { computeVelocitySizeZoomScale } from '../velocity/velocityZoom';

/** Point feature as decoded from the LOS GeoJSON. */
export interface VelocityFeature {
  geometry: { type?: string; coordinates: number[] };
  properties: Record<string, any>;
}

export interface BuildDeckGLLayerWithSymbologyProps {
  id: string;
  /** Decoded GeoJSON features (Point geometry in lng/lat). */
  features: VelocityFeature[];
  /** Current view zoom; drives the zoom-adaptive meter size band. */
  zoom: number;
  visible?: boolean;
  pickable?: boolean;
  /** Dominant orbit of the active style; features from the other orbit render as small gray circles. */
  dominantOrbit?: 'A' | 'D' | null;
  /** Per-feature selection stroke color (alpha 0 = unselected); drives selection on both sublayers. */
  getLineColor?: Accessor<VelocityFeature, Color>;
  /**
   * Per-feature circle border width (CSS px). Defaults to
   * `SELECTED_FEATURE_LINE_WIDTH` for features whose `getLineColor` alpha is
   * non-zero, otherwise `NON_SELECTED_FEATURE_LINE_WIDTH` (transparent 1px).
   * Arrows ignore this (their stroke is fixed in the shader and their quad must
   * stay uninflated), so it only affects the circle sublayer. When the selected
   * preset is thin-edge, unselected circles are forced to 0.
   */
  getLineWidth?: Accessor<VelocityFeature, number>;
  updateTriggers?: Record<string, unknown[]>;
  /**
   * When set, overrides the data-driven arrow geometry (stem/head dimensions)
   * with a fixed shape preset so the shapes can be compared on the map. The
   * orientation always uses the data-driven heading (`computeArrowHeading`).
   * A preset can also be thin-edged, which removes the unselected border from
   * both the arrows and the circles. `null`/undefined keeps the data-driven LOS
   * symbology.
   */
  arrowShapePresetId?: ArrowShapePresetId | null;
}

/**
 * Visual-emphasis factor on the near-zero / non-dominant-orbit circle radius.
 * `2` doubles the radius (so the circles read ~2x larger than the arrows, which
 * are drawn from the meter-sized sphere reference). Set to `1` for 3D parity.
 */
const CIRCLE_RADIUS_SCALE = 2;

/**
 * Reference pen width (map meters) at which the preset head geometry is drawn.
 *
 * The three preset arrows keep a **fixed head size** — the same wing shape for
 * every feature — while the pen (`rel_len`) changes only the stroke thickness and
 * the stem length follows `vel_rel`. `headWidth` / `headSize` are multiples of
 * this reference pen, so the head is sized once in map meters here.
 */
const ARROW_HEAD_PEN_METERS = 1.5;

const readNumber = (feature: VelocityFeature, keys: readonly string[]): number | null => {
  const properties = feature?.properties ?? {};
  for (const key of keys) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
};

/**
 * Reads the velocity symbology attributes from a feature, tolerating the
 * attribute spellings used by the different InSAR exports (`vel_avg`/`VEL_AVG`,
 * `vel_rel`/`VEL_REL`, `rel_len`/`REL_LEN`, `coh`/`COH`).
 */
const readVelocity = (feature: VelocityFeature) => {
  const properties = feature?.properties ?? {};
  return {
    velAvg: readNumber(feature, ['vel_avg', 'VEL_AVG', 'vel_last', 'VEL_LAST']),
    velRel: readNumber(feature, ['vel_rel', 'VEL_REL', 'REL', 'rel']),
    relLen: readNumber(feature, ['rel_len', 'REL_LEN']),
    coh: readNumber(feature, ['coh', 'COH', 'coh_mod', 'COH_MOD']),
    orbit: (properties.orbit ?? properties.ORBIT ?? null) as string | null
  };
};

const getPosition = (feature: VelocityFeature): [number, number] => {
  const coordinates = feature?.geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    return [coordinates[0], coordinates[1]];
  }
  const properties = feature?.properties ?? {};
  return [Number(properties.lon ?? properties.LON), Number(properties.lat ?? properties.LAT)];
};

const getFillColor = (feature: VelocityFeature, dominantOrbit: 'A' | 'D' | null): RgbaColor => {
  const { velAvg, orbit } = readVelocity(feature);
  if (isNonDominantOrbit(orbit, dominantOrbit)) {
    return DEFAULT_FEATURE_FILL_RGBA;
  }
  return (orbit === 'D' ? VELOCITY_DESCENDING_COLORMAP : VELOCITY_COLORMAP)(velAvg);
};

/**
 * Builds the shader-rasterized 2D InSAR velocity (LOS) layers: meter-sized SDF
 * arrows for significant velocities plus ScatterplotLayer circles for near-zero
 * values and the non-dominant orbit.
 *
 * The rendering rules mirror `app-damStabilityInspector`'s `velocitySymbology`
 * (fixed 52 m reference radius, `vel_rel` stem, `rel_len` thickness, a
 * `coh`-sized head on the data path or a fixed preset head, orbit-aware heading,
 * discrete velocity colormap, zoom-adaptive meter band). Selection uses the
 * parent-provided `getLineColor` accessor: arrows render a
 * `SELECTED_FEATURE_LINE_WIDTH` stroke via the shader, circles use the same color
 * with a `SELECTED_FEATURE_LINE_WIDTH` stroke.
 *
 * Unlike the tiled MVT path, the source is a plain GeoJSON FeatureCollection, so
 * positions come straight from `geometry.coordinates` (lng/lat) and no
 * tile-local coordinate handling is needed.
 */
const buildDeckGLLayerWithSymbology = ({
  id,
  features,
  zoom,
  visible = true,
  pickable = true,
  dominantOrbit = null,
  getLineColor = (() =>
    NON_SELECTED_FEATURE_LINE_COLOR) as unknown as Accessor<VelocityFeature, Color>,
  getLineWidth,
  updateTriggers,
  arrowShapePresetId = null
}: BuildDeckGLLayerWithSymbologyProps): Layer[] => {
  const zoomSizeScale = computeVelocitySizeZoomScale(zoom);
  const resolveLineColor = getLineColor as unknown as (feature: VelocityFeature) => Color;
  // Circle border width: a provided accessor, else derived from the selection
  // color (selected => SELECTED_FEATURE_LINE_WIDTH, else the transparent
  // NON_SELECTED_FEATURE_LINE_WIDTH). Arrows always keep a 0 line width so their
  // quad stays uninflated (`unitPosition` geometry).
  const resolveLineWidth = (getLineWidth ??
    ((feature: VelocityFeature): number => {
      const color = resolveLineColor(feature);
      return color && color[3] > 0 ? SELECTED_FEATURE_LINE_WIDTH : NON_SELECTED_FEATURE_LINE_WIDTH;
    })) as unknown as (feature: VelocityFeature) => number;
  // `dominantOrbit` drives both the fill color and the circle radius, and the
  // layer ids are stable across changes to it, so both accessors must be forced
  // to recompute when it changes.
  const mergedUpdateTriggers = {
    ...updateTriggers,
    getFillColor: [...(updateTriggers?.getFillColor ?? []), dominantOrbit],
    getRadius: [...(updateTriggers?.getRadius ?? []), zoomSizeScale, dominantOrbit]
  };
  const arrowPreset = getArrowShapePreset(arrowShapePresetId);

  // The thin-edge variant drops the unselected border on the arrows (via the
  // shader) and on the circles (here). Selection / hover borders are kept.
  const thinEdge = arrowPreset?.thinEdge === true;
  const resolveCircleLineWidth = (feature: VelocityFeature): number => {
    if (thinEdge) {
      const color = resolveLineColor(feature);
      if (!(color && color[3] > 0)) {
        return 0;
      }
    }
    return resolveLineWidth(feature);
  };
  // The circle layer is not recreated when the preset changes, so its line
  // widths must also recompute when the thin-edge treatment changes.
  const circleUpdateTriggers = {
    ...mergedUpdateTriggers,
    getLineWidth: [...(mergedUpdateTriggers.getLineWidth ?? []), thinEdge]
  };

  // Each feature's symbology attributes are read many times per render (fill,
  // angle, stem length, stem thickness, head size/width), so parse them once
  // per feature for this build. The cache is scoped to the call, so replacing
  // the input features (a new `buildDeckGLLayerWithSymbology` call) always
  // re-reads them.
  const velocityAttributes = new WeakMap<VelocityFeature, ReturnType<typeof readVelocity>>();
  const getVelocity = (feature: VelocityFeature): ReturnType<typeof readVelocity> => {
    let attributes = velocityAttributes.get(feature);
    if (!attributes) {
      attributes = readVelocity(feature);
      velocityAttributes.set(feature, attributes);
    }
    return attributes;
  };

  // Pen width shared by the stem and the head (fraction of the quad), driven by
  // `rel_len`. The preset glyphs are fixed-pen-width drawings traced from the
  // reference SVG, so scaling every head dimension by this same width makes the
  // head bars exactly as thick as the stem — one pen draws the whole arrow.
  // Presets scale it down (max 2.5 m instead of the fill head's 5 m); the fill
  // head keeps the unscaled mapping.
  const arrowPenScale = arrowPreset ? ARROW_SHAPE_PRESET_STROKE_WIDTH_SCALE : 1;
  const arrowPenWidth = (feature: VelocityFeature): number =>
    computeStemThicknessFraction(getVelocity(feature).relLen) * arrowPenScale;

  // Preset head geometry: a fixed wing shape, sized once at the reference pen.
  // The pen only drives the stroke thickness and the stem length follows `vel_rel`.
  const headPenFraction = metersToArrowFraction(ARROW_HEAD_PEN_METERS);
  const headSizeFraction = arrowPreset ? arrowPreset.headSize * headPenFraction : 0;
  const headWidthFraction = arrowPreset ? arrowPreset.headWidth * headPenFraction : 0;

  const arrowFeatures: VelocityFeature[] = [];
  const circleFeatures: VelocityFeature[] = [];

  for (const feature of features ?? []) {
    const { velAvg, orbit } = getVelocity(feature);
    if (isNonDominantOrbit(orbit, dominantOrbit) || isSphere(velAvg)) {
      circleFeatures.push(feature);
    } else {
      arrowFeatures.push(feature);
    }
  }

  // Circles are listed first (drawn below); the arrow layers are appended last
  // so deck.gl draws them on top of the circles.
  const circleLayers: Layer[] = [];
  const arrowLayers: Layer[] = [];

  if (arrowFeatures.length > 0) {
    arrowLayers.push(
      new DynamicArrowLayer<VelocityFeature>({
        id: `${id}-arrows-${arrowShapePresetId ?? 'data'}`,
        data: arrowFeatures,
        visible,
        pickable,
        glyph: arrowPreset ? arrowPreset.glyph : 'triangle',
        thinEdge,
        getPosition,
        getFillColor: (feature: VelocityFeature): RgbaColor => getFillColor(feature, dominantOrbit),
        getAngle: (feature: VelocityFeature): number => {
          const { velAvg, orbit } = getVelocity(feature);
          return computeArrowHeading(velAvg, orbit);
        },
        // Stem length is the data-driven (`vel_rel`) dimension; the shader adds the
        // minimum bare-stem reserve on top.
        getStemLength: (feature: VelocityFeature): number => computeStemLengthFraction(getVelocity(feature).velRel),
        // Pen (`rel_len`): stroke thickness, drawn through the stem and both wings.
        getStemThickness: (feature: VelocityFeature): number => arrowPenWidth(feature),
        // Preset heads keep a fixed size (a single shared wing shape); the pen only
        // thickens the stroke. The data path still sizes its head from `coh`.
        getHeadSize: arrowPreset
          ? headSizeFraction
          : (feature: VelocityFeature): number => computeHeadSizeFraction(getVelocity(feature).coh),
        getHeadWidth: arrowPreset
          ? headWidthFraction
          : (feature: VelocityFeature): number => computeHeadWidthFraction(getVelocity(feature).coh),
        getRadius: computeArrowRadius() * zoomSizeScale,
        radiusUnits: 'meters',
        lineWidthUnits: 'pixels',
        // The arrow renders its own SDF stroke, so the base ScatterplotLayer
        // stroke pass is unused: `stroked` stays false and `getLineWidth` stays 0
        // (a non-zero width would inflate the quad and break the `unitPosition`
        // meter mapping).
        getLineWidth: 0,
        getLineColor: resolveLineColor,
        updateTriggers: mergedUpdateTriggers
      })
    );
  }

  if (circleFeatures.length > 0) {
    circleLayers.push(
      new ScatterplotLayer<VelocityFeature>({
        id: `${id}-circles`,
        data: circleFeatures,
        visible,
        pickable,
        getPosition,
        getFillColor: (feature: VelocityFeature): RgbaColor => getFillColor(feature, dominantOrbit),
        getRadius: (feature: VelocityFeature): number => {
          const { orbit } = getVelocity(feature);
          const hidden = isNonDominantOrbit(orbit, dominantOrbit);
          return (hidden ? SMALL_SPHERE_RADIUS_METERS : SPHERE_RADIUS_METERS) * zoomSizeScale * CIRCLE_RADIUS_SCALE;
        },
        radiusUnits: 'meters',
        lineWidthUnits: 'pixels',
        getLineColor: resolveLineColor,
        getLineWidth: resolveCircleLineWidth,
        stroked: true,
        filled: true,
        updateTriggers: circleUpdateTriggers
      })
    );
  }

  return [...circleLayers, ...arrowLayers];
};

export default buildDeckGLLayerWithSymbology;

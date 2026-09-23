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
  computeStemThicknessFraction
} from '../velocity/velocityArrow';
import {
  DEFAULT_FEATURE_FILL_RGBA,
  VELOCITY_COLORMAP,
  VELOCITY_DESCENDING_COLORMAP,
  type RgbaColor
} from '../velocity/velocityColormap';
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
  updateTriggers?: Record<string, unknown[]>;
}

/** Selected-feature stroke width (CSS px), mirroring the shader's `SELECTED_FEATURE_LINE_WIDTH`. */
const SELECTED_FEATURE_LINE_WIDTH = 3;

const TRANSPARENT: RgbaColor = [0, 0, 0, 0];

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
 * (fixed 40 m reference radius, `vel_rel` stem, `rel_len` thickness, `coh`
 * head, orbit-aware heading, discrete velocity colormap, zoom-adaptive meter
 * band). Selection uses the parent-provided `getLineColor` accessor: arrows
 * render a hardcoded 3 px stroke via the shader, circles use the same color with
 * a 3 px stroke.
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
  getLineColor = (() => TRANSPARENT) as unknown as Accessor<VelocityFeature, Color>,
  updateTriggers
}: BuildDeckGLLayerWithSymbologyProps): Layer[] => {
  const zoomSizeScale = computeVelocitySizeZoomScale(zoom);
  const resolveLineColor = getLineColor as unknown as (feature: VelocityFeature) => Color;
  const mergedUpdateTriggers = { ...updateTriggers, getRadius: [zoomSizeScale] };

  const arrowFeatures: VelocityFeature[] = [];
  const circleFeatures: VelocityFeature[] = [];

  for (const feature of features ?? []) {
    const { velAvg, orbit } = readVelocity(feature);
    if (isNonDominantOrbit(orbit, dominantOrbit) || isSphere(velAvg)) {
      circleFeatures.push(feature);
    } else {
      arrowFeatures.push(feature);
    }
  }

  const layers: Layer[] = [];

  if (arrowFeatures.length > 0) {
    layers.push(
      new DynamicArrowLayer<VelocityFeature>({
        id: `${id}-arrows`,
        data: arrowFeatures,
        visible,
        pickable,
        getPosition,
        getFillColor: (feature: VelocityFeature): RgbaColor => getFillColor(feature, dominantOrbit),
        getAngle: (feature: VelocityFeature): number => {
          const { velAvg, orbit } = readVelocity(feature);
          return computeArrowHeading(velAvg, orbit);
        },
        getStemLength: (feature: VelocityFeature): number => computeStemLengthFraction(readVelocity(feature).velRel),
        getStemThickness: (feature: VelocityFeature): number =>
          computeStemThicknessFraction(readVelocity(feature).relLen),
        getHeadSize: (feature: VelocityFeature): number => computeHeadSizeFraction(readVelocity(feature).coh),
        getHeadWidth: (feature: VelocityFeature): number => computeHeadWidthFraction(readVelocity(feature).coh),
        getRadius: computeArrowRadius() * zoomSizeScale,
        radiusUnits: 'meters',
        lineWidthUnits: 'pixels',
        stroked: true,
        getLineWidth: 0,
        getLineColor: resolveLineColor,
        updateTriggers: mergedUpdateTriggers
      })
    );
  }

  if (circleFeatures.length > 0) {
    layers.push(
      new ScatterplotLayer<VelocityFeature>({
        id: `${id}-circles`,
        data: circleFeatures,
        visible,
        pickable,
        getPosition,
        getFillColor: (feature: VelocityFeature): RgbaColor => getFillColor(feature, dominantOrbit),
        getRadius: (feature: VelocityFeature): number => {
          const { orbit } = readVelocity(feature);
          const hidden = isNonDominantOrbit(orbit, dominantOrbit);
          return (hidden ? SMALL_SPHERE_RADIUS_METERS : SPHERE_RADIUS_METERS) * zoomSizeScale;
        },
        radiusUnits: 'meters',
        lineWidthUnits: 'pixels',
        getLineColor: resolveLineColor,
        getLineWidth: (feature: VelocityFeature): number => {
          const color = resolveLineColor(feature);
          return color && color[3] > 0 ? SELECTED_FEATURE_LINE_WIDTH : 0;
        },
        stroked: true,
        filled: true,
        updateTriggers: mergedUpdateTriggers
      })
    );
  }

  return layers;
};

export default buildDeckGLLayerWithSymbology;

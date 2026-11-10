import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Color, Layer, LayerExtension } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import {
  ARROW_MAP_SIZE_SCALE,
  computeArrowHeading,
  computeArrowOrientation,
  computeArrowTranslation,
  computeBodyScale,
  computeCapOrientation,
  computeCapScale,
  computeStemTranslation,
  computeVectorRaiseMeters,
  computeWingHeading,
  computeWingOrientation,
  computeWingScale,
  computeWingTipTranslation,
} from '../velocity/velocity3dArrow';
import { compute3dVelocitySizeZoomScale } from '../velocity/velocityZoom';

/**
 * Local, Vite-base-safe OBJ URLs for the 3D LOS arrow composite. The rod mesh is
 * used for the straight body and both wing rods; the round-end mesh is used for
 * the rear cap, the two wing-tip caps and the arrow-tip cap.
 */
const ARROW_TAIL_UNIT_ROUNDED = `${import.meta.env.BASE_URL}meshes/arrow_tail_unit_rounded.obj`;
const ARROW_TAIL_ROUND_END_ROUNDED = `${import.meta.env.BASE_URL}meshes/arrow_tail_round_end_rounded.obj`;

const VEL_AVG_KEYS = ['VEL_AVG', 'vel_avg'] as const;
const VEL_REL_KEYS = ['VEL_REL', 'vel_rel'] as const;
const REL_LEN_KEYS = ['REL_LEN', 'rel_len'] as const;

/** InSAR point feature as decoded from the LOS GeoJSON. */
export interface LosArrowFeature {
  geometry?: { type?: string; coordinates?: number[] } | null;
  properties?: Record<string, unknown> | null;
}

/** Parsed symbology attributes for one feature. */
interface LosArrowAttributes {
  velAvg: number | null;
  velRel: number | null;
  relLen: number | null;
}

export interface Build3dLosArrowLayersProps {
  /** Stable prefix for the seven sublayer ids. */
  idPrefix: string;
  /** LOS point features (every feature is rendered as an arrow). */
  data: LosArrowFeature[];
  /** Shared selection-aware colour accessor applied to all seven parts. */
  getColor: (feature: LosArrowFeature) => Color;
  /**
   * Anchor accessor `[lon, lat, z]` **without** the vertical raise; the builder
   * adds `computeVectorRaiseMeters(relLen) × arrowScale` to the z coordinate.
   * z is in metres, i.e. a height above the anchor's local surface when the
   * layer uses `TerrainExtension` offset mode.
   * Defaults to the geometry coordinates (or `LON`/`LAT`) with `H` as z.
   */
  getPosition?: (feature: LosArrowFeature) => [number, number, number];
  /** Orbit used to pick the fixed heading pair (`'D'` → 280°/100°). */
  orbit?: 'A' | 'D' | null;
  /** Current view zoom; drives the floor-only 3D size band. */
  zoom: number;
  pickable?: boolean;
  /** Extra update triggers, e.g. `{ getColor: [selectedId, hoveredId] }`. */
  updateTriggers?: Record<string, unknown[]>;
  /**
   * Layer extensions applied to all seven sublayers. Add
   * `new TerrainExtension()` together with `terrainDrawMode: 'offset'` to
   * anchor the composite on the terrain height map.
   */
  extensions?: LayerExtension[];
  /**
   * Terrain draw mode provided by `TerrainExtension`. `'offset'` shifts the
   * whole arrow by the terrain height under its anchor instead of draping it.
   */
  terrainDrawMode?: 'offset' | 'drape';
}

const readNumber = (
  feature: LosArrowFeature,
  keys: readonly string[],
): number | null => {
  const properties = feature?.properties ?? {};
  for (const key of keys) {
    const value = properties[key];
    if (value == null || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const defaultGetPosition = (feature: LosArrowFeature): [number, number, number] => {
  const coordinates = feature?.geometry?.coordinates;
  if (Array.isArray(coordinates) && coordinates.length >= 2) {
    const height = Number(feature?.properties?.H);
    return [
      coordinates[0],
      coordinates[1],
      Number.isFinite(height) ? height : 0,
    ];
  }
  const properties = feature?.properties ?? {};
  const height = Number(properties.H);
  return [
    Number(properties.LON ?? properties.lon),
    Number(properties.LAT ?? properties.lat),
    Number.isFinite(height) ? height : 0,
  ];
};

const scaleVec = (
  tuple: [number, number, number],
  scale: number,
): [number, number, number] => [tuple[0] * scale, tuple[1] * scale, tuple[2] * scale];

/**
 * Builds the seven `SimpleMeshLayer`s of the 3D LOS round-cap arrow composite:
 * rear cap, straight body, two wing rods, two wing-tip caps and the arrow tip.
 *
 * Every feature renders as an arrow — there is no near-zero sphere split. All
 * seven parts share one data set, one `getColor` accessor, one anchor and one
 * `arrowScale` (floor-only 3D zoom band × `ARROW_MAP_SIZE_SCALE`), so the cap /
 * body / wing seams stay glued.
 *
 * Attribute readers tolerate the uppercase (`VEL_AVG`) and lowercase (`vel_avg`)
 * spellings. Missing values coalesce to `VEL_AVG = 0`, `VEL_REL = 0`,
 * `REL_LEN = 0.4` and `H = 0`, so a feature without attributes still draws an
 * arrow.
 *
 * @param props - Builder props (see {@link Build3dLosArrowLayersProps}).
 * @returns The seven arrow sublayers, in draw order.
 */
export const build3dLosArrowLayers = ({
  idPrefix,
  data,
  getColor,
  getPosition = defaultGetPosition,
  orbit = 'D',
  zoom,
  pickable = true,
  updateTriggers,
  extensions,
  terrainDrawMode,
}: Build3dLosArrowLayersProps): Layer[] => {
  const arrowScale = compute3dVelocitySizeZoomScale(zoom) * ARROW_MAP_SIZE_SCALE;

  // Each feature's attributes are read several times per render, so parse them
  // once per build. Replacing the data array always re-reads them.
  const attributeCache = new WeakMap<LosArrowFeature, LosArrowAttributes>();
  const getAttributes = (feature: LosArrowFeature): LosArrowAttributes => {
    let attributes = attributeCache.get(feature);
    if (!attributes) {
      attributes = {
        velAvg: readNumber(feature, VEL_AVG_KEYS),
        velRel: readNumber(feature, VEL_REL_KEYS),
        relLen: readNumber(feature, REL_LEN_KEYS),
      };
      attributeCache.set(feature, attributes);
    }
    return attributes;
  };

  const getArrowPosition = (feature: LosArrowFeature): [number, number, number] => {
    const [longitude, latitude, height] = getPosition(feature);
    const raise = computeVectorRaiseMeters(getAttributes(feature).relLen) * arrowScale;
    return [longitude, latitude, height + raise];
  };

  const triggers = updateTriggers ?? {};
  const sharedUpdateTriggers = {
    ...triggers,
    getColor: [...(triggers.getColor ?? [])],
    // Re-evaluate the geometry when the floor-only 3D band changes.
    getScale: [...(triggers.getScale ?? []), arrowScale],
    getPosition: [...(triggers.getPosition ?? []), arrowScale],
    getTranslation: [...(triggers.getTranslation ?? []), arrowScale],
    getOrientation: [...(triggers.getOrientation ?? []), orbit],
  };

  const sharedProps = {
    data,
    pickable,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    mesh: ARROW_TAIL_UNIT_ROUNDED,
    loaders: [OBJLoader],
    getPosition: getArrowPosition,
    getColor,
    updateTriggers: sharedUpdateTriggers,
    ...(extensions ? { extensions, terrainDrawMode } : {}),
  };

  // Rear cap: the cap dome points rearward (opposite the arrow heading).
  const stemCap = new SimpleMeshLayer<LosArrowFeature>({
    ...sharedProps,
    id: `${idPrefix}-stem-cap`,
    mesh: ARROW_TAIL_ROUND_END_ROUNDED,
    getScale: (feature) => scaleVec(computeCapScale(getAttributes(feature).relLen), arrowScale),
    getOrientation: (feature) =>
      computeCapOrientation(
        (computeArrowHeading(getAttributes(feature).velAvg, orbit) + 180) % 360,
      ),
    getTranslation: (feature) =>
      scaleVec(
        computeStemTranslation(getAttributes(feature).relLen, getAttributes(feature).velAvg, orbit),
        arrowScale,
      ),
  });

  // Straight body: pen-sized cross-section, stretched to the body length.
  const stemBody = new SimpleMeshLayer<LosArrowFeature>({
    ...sharedProps,
    id: `${idPrefix}-stem-body`,
    getScale: (feature) =>
      scaleVec(
        computeBodyScale(getAttributes(feature).velRel, getAttributes(feature).relLen),
        arrowScale,
      ),
    getOrientation: (feature) =>
      computeArrowOrientation(getAttributes(feature).velAvg, orbit),
    getTranslation: (feature) =>
      scaleVec(
        computeStemTranslation(getAttributes(feature).relLen, getAttributes(feature).velAvg, orbit),
        arrowScale,
      ),
  });

  const makeWing = (side: 'left' | 'right'): SimpleMeshLayer<LosArrowFeature> =>
    new SimpleMeshLayer<LosArrowFeature>({
      ...sharedProps,
      id: `${idPrefix}-wing-${side}`,
      getScale: (feature) => scaleVec(computeWingScale(getAttributes(feature).relLen), arrowScale),
      getOrientation: (feature) =>
        computeWingOrientation(getAttributes(feature).velAvg, orbit, side),
      getTranslation: (feature) =>
        scaleVec(
          computeArrowTranslation(
            getAttributes(feature).velRel,
            getAttributes(feature).relLen,
            getAttributes(feature).velAvg,
            orbit,
          ),
          arrowScale,
        ),
    });

  const makeWingTipCap = (side: 'left' | 'right'): SimpleMeshLayer<LosArrowFeature> =>
    new SimpleMeshLayer<LosArrowFeature>({
      ...sharedProps,
      id: `${idPrefix}-wing-${side}-cap`,
      mesh: ARROW_TAIL_ROUND_END_ROUNDED,
      getScale: (feature) => scaleVec(computeCapScale(getAttributes(feature).relLen), arrowScale),
      // Dome points outward along the wing heading.
      getOrientation: (feature) =>
        computeCapOrientation(
          computeWingHeading(
            computeArrowHeading(getAttributes(feature).velAvg, orbit),
            side,
          ),
        ),
      getTranslation: (feature) =>
        scaleVec(
          computeWingTipTranslation(
            getAttributes(feature).velRel,
            getAttributes(feature).relLen,
            getAttributes(feature).velAvg,
            orbit,
            side,
          ),
          arrowScale,
        ),
    });

  // Arrow-tip cap: dome points forward along the heading.
  const tipCap = new SimpleMeshLayer<LosArrowFeature>({
    ...sharedProps,
    id: `${idPrefix}-tip`,
    mesh: ARROW_TAIL_ROUND_END_ROUNDED,
    getScale: (feature) => scaleVec(computeCapScale(getAttributes(feature).relLen), arrowScale),
    getOrientation: (feature) =>
      computeCapOrientation(computeArrowHeading(getAttributes(feature).velAvg, orbit)),
    getTranslation: (feature) =>
      scaleVec(
        computeArrowTranslation(
          getAttributes(feature).velRel,
          getAttributes(feature).relLen,
          getAttributes(feature).velAvg,
          orbit,
        ),
        arrowScale,
      ),
  });

  return [
    stemCap,
    stemBody,
    makeWing('left'),
    makeWing('right'),
    makeWingTipCap('left'),
    makeWingTipCap('right'),
    tipCap,
  ];
};

export default build3dLosArrowLayers;

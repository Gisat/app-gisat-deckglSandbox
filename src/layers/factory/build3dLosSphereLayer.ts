import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Color, LayerExtension } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import type { LosArrowFeature } from './build3dLosArrowLayers';
import { compute3dVelocitySizeZoomScale } from '../velocity/velocityZoom';

/** Shared unit sphere (radius 1); the per-instance scale sets the world radius. */
const SPHERE_MESH = new SphereGeometry();

export interface Build3dLosSphereLayerProps {
  /** Sublayer id; the map passes `${POINT_LAYER_PREFIX}-spheres`. */
  id: string;
  /** Near-zero LOS features (the arrow builder receives the rest). */
  data: LosArrowFeature[];
  /** Shared selection-aware colour accessor. */
  getColor: (feature: LosArrowFeature) => Color;
  /**
   * Anchor accessor `[lon, lat, z]` **without** the vertical lift; the builder
   * adds the scaled radius to z so the sphere sits on the point elevation.
   */
  getPosition: (feature: LosArrowFeature) => [number, number, number];
  /** Current view zoom; drives the floor-only 3D size band. */
  zoom: number;
  /** World radius in map meters, before the zoom band. */
  radiusMeters?: number;
  pickable?: boolean;
  /** Extra update triggers, e.g. `{ getColor: [selectedId, hoveredId] }`. */
  updateTriggers?: Record<string, unknown[]>;
  /** Layer extensions, e.g. `new TerrainExtension()`. */
  extensions?: LayerExtension[];
  /** Terrain draw mode provided by `TerrainExtension`. */
  terrainDrawMode?: 'offset' | 'drape';
}

/**
 * Builds the near-zero `VEL_AVG` sphere layer.
 *
 * One `SimpleMeshLayer` of radius-1 spheres scaled to `radiusMeters ×` the
 * floor-only 3D zoom band (no `ARROW_MAP_SIZE_SCALE`), lifted by the scaled
 * radius so the sphere is centred one radius above the anchor.
 *
 * @param props - Builder props (see {@link Build3dLosSphereLayerProps}).
 * @returns The sphere sublayer.
 */
export const build3dLosSphereLayer = ({
  id,
  data,
  getColor,
  getPosition,
  zoom,
  radiusMeters = 1.6,
  pickable = true,
  updateTriggers,
  extensions,
  terrainDrawMode,
}: Build3dLosSphereLayerProps): SimpleMeshLayer<LosArrowFeature> => {
  const radius = radiusMeters * compute3dVelocitySizeZoomScale(zoom);

  const triggers = updateTriggers ?? {};

  return new SimpleMeshLayer<LosArrowFeature>({
    id,
    data,
    mesh: SPHERE_MESH,
    pickable,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    getPosition: (feature) => {
      const [longitude, latitude, height] = getPosition(feature);
      return [longitude, latitude, height + radius];
    },
    getScale: () => [radius, radius, radius],
    getColor,
    material: { ambient: 0.35, diffuse: 0.6, shininess: 0, specularColor: [0, 0, 0] },
    updateTriggers: {
      ...triggers,
      getColor: [...(triggers.getColor ?? [])],
      // Re-evaluate the geometry when the floor-only 3D band changes.
      getPosition: [...(triggers.getPosition ?? []), radius],
      getScale: [...(triggers.getScale ?? []), radius],
    },
    ...(extensions ? { extensions, terrainDrawMode } : {}),
  });
};

export default build3dLosSphereLayer;

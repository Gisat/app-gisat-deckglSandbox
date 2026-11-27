import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Color, LayerExtension } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { ConeGeometry, CubeGeometry, SphereGeometry } from '@luma.gl/engine';
import type { LosArrowFeature } from './build3dLosArrowLayers';
import { compute3dVelocitySizeZoomScale } from '../velocity/velocityZoom';

/** Built-in shape used to draw every point of one track. */
export type LosTrackSymbolShape = 'sphere' | 'cube' | 'cone';

/** Shared unit meshes; the per-instance scale sets the world size. */
const SPHERE_MESH = new SphereGeometry();
const CUBE_MESH = new CubeGeometry();
const CONE_MESH = new ConeGeometry();

const SHAPE_MESHES: Record<
  LosTrackSymbolShape,
  SphereGeometry | CubeGeometry | ConeGeometry
> = {
  sphere: SPHERE_MESH,
  cube: CUBE_MESH,
  cone: CONE_MESH,
};

export interface Build3dLosTrackSymbolLayerProps {
  /** Sublayer id; the map passes `${pointLayerPrefix}-shape`. */
  id: string;
  /** Features of one track; every feature gets the same shape. */
  data: LosArrowFeature[];
  /** Shape drawn for every feature of this track. */
  shape: LosTrackSymbolShape;
  /** Shared selection-aware colour accessor. */
  getColor: (feature: LosArrowFeature) => Color;
  /**
   * Anchor accessor `[lon, lat, z]` **without** the vertical lift; the builder
   * adds the scaled radius to z so the shape's base sits on the point
   * elevation.
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
 * Builds the per-track shape layer used by the `Track shapes` view.
 *
 * One `SimpleMeshLayer` of unit sphere / cube / cone meshes scaled to
 * `radiusMeters ×` the floor-only 3D zoom band (no `ARROW_MAP_SIZE_SCALE`).
 * Every shape is lifted by the scaled radius so the sphere bottom, cube bottom
 * and cone base all rest on the anchor. The cone is scaled to height `2r` on
 * its local +Y axis and orientated at roll `90`, which maps that axis to world
 * up, so it stands tip-up.
 *
 * @param props - Builder props (see {@link Build3dLosTrackSymbolLayerProps}).
 * @returns The track shape sublayer.
 */
export const build3dLosTrackSymbolLayer = ({
  id,
  data,
  shape,
  getColor,
  getPosition,
  zoom,
  radiusMeters = 1.6,
  pickable = true,
  updateTriggers,
  extensions,
  terrainDrawMode,
}: Build3dLosTrackSymbolLayerProps): SimpleMeshLayer<LosArrowFeature> => {
  const radius = radiusMeters * compute3dVelocitySizeZoomScale(zoom);
  const isCone = shape === 'cone';

  const triggers = updateTriggers ?? {};

  return new SimpleMeshLayer<LosArrowFeature>({
    id,
    data,
    mesh: SHAPE_MESHES[shape] ?? SPHERE_MESH,
    pickable,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    getPosition: (feature) => {
      const [longitude, latitude, height] = getPosition(feature);
      return [longitude, latitude, height + radius];
    },
    // The cone mesh is a unit height centred on its local +Y axis, so the
    // local Y scale of 2r gives a height of 2r and the X/Z scale of r gives
    // the same footprint as the sphere and cube.
    getScale: (): [number, number, number] =>
      isCone ? [radius, radius * 2, radius] : [radius, radius, radius],
    ...(isCone ? { getOrientation: (): [number, number, number] => [0, 0, 90] } : {}),
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

export default build3dLosTrackSymbolLayer;

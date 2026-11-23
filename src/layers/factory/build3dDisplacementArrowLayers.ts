import { COORDINATE_SYSTEM } from '@deck.gl/core';
import type { Color, LayerExtension } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';
import { DISPLACEMENT_SYMBOL_MATERIAL } from '../displacementMaterial';
import { headingOffset, headingToOrientation } from '../../maps/ArrowLODStream_3D/arrow3dSymbols';

/**
 * Gallery material shared by the stem and head so the streamed arrows shade like
 * the Arrow Gallery preview.
 */
const MATERIAL = DISPLACEMENT_SYMBOL_MATERIAL;

/** Row indices into the owning table; accessors read the table by index. */
type ArrowRow = number;

export interface Build3dDisplacementArrowLayersProps {
  /** Stable prefix for the stem/head sublayer ids. */
  idPrefix: string;
  /** Row indices of the arrows (near-zero rows are drawn as spheres). */
  data: ArrowRow[];
  /**
   * Anchor accessor `[lon, lat, z]`. z is a **meters offset above the anchor's
   * local surface** when the layer uses `TerrainExtension` offset mode; the
   * caller adds `getRaiseMeters(pen)` here.
   */
  getPosition: (rowIndex: ArrowRow) => [number, number, number];
  /** Shared selection-aware colour accessor applied to both parts. */
  getColor: (rowIndex: ArrowRow) => Color;
  /** Compass heading accessor in degrees (see `getArrowHeading`). */
  getHeading: (rowIndex: ArrowRow) => number;
  /** Data-driven stem length accessor in map meters. */
  getStemMeters: (rowIndex: ArrowRow) => number;
  /** Gallery pen (stroke) width in map meters. */
  penMeters: number;
  /** `arrow_tail_unit.obj` URL (imported by the map as a Vite asset). */
  stemMesh: string;
  /** `arrow_head_round_cap.obj` URL (imported by the map as a Vite asset). */
  headMesh: string;
  /** Extra update triggers, e.g. `{ getColor: [selectedId, hoveredId] }`. */
  updateTriggers?: Record<string, unknown[]>;
  /**
   * Layer extensions applied to both sublayers. Add
   * `new TerrainExtension()` together with `terrainDrawMode: 'offset'` to
   * anchor the arrows on the terrain height map.
   */
  extensions?: LayerExtension[];
  /** Terrain draw mode provided by `TerrainExtension`. */
  terrainDrawMode?: 'offset' | 'drape';
}

/**
 * Builds the two `SimpleMeshLayer`s of a split round-cap 3D arrow: the unit stem
 * stretched along the heading, and the round-cap head translated to the stem tip.
 *
 * The meshes are the Arrow Gallery's sharp meshes, both authored at pen 1.0 and
 * extending along **negative Z** from a base origin. The stem gets
 * `getScale [pen, pen, stemMeters]`, the head `getScale [pen, pen, pen]` and a
 * `getTranslation` of `stemMeters` along the heading, so the head's socket sits
 * exactly on the stem tip.
 *
 * @param props - Builder props (see {@link Build3dDisplacementArrowLayersProps}).
 * @returns The stem and head sublayers, in draw order.
 */
export const build3dDisplacementArrowLayers = ({
  idPrefix,
  data,
  getPosition,
  getColor,
  getHeading,
  getStemMeters,
  penMeters,
  stemMesh,
  headMesh,
  updateTriggers,
  extensions,
  terrainDrawMode,
}: Build3dDisplacementArrowLayersProps): SimpleMeshLayer<ArrowRow>[] => {
  const triggers = updateTriggers ?? {};

  const sharedProps = {
    data,
    // Arrows never receive selection clicks: this keeps Map3D's terrain
    // `onClick` (which drives the drawing gesture) flowing through them.
    pickable: false,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    loaders: [OBJLoader],
    getPosition,
    getColor,
    material: MATERIAL,
    ...(extensions ? { extensions, terrainDrawMode } : {}),
  };

  const stem = new SimpleMeshLayer<ArrowRow>({
    ...sharedProps,
    id: `${idPrefix}-stem`,
    mesh: stemMesh,
    getScale: (rowIndex) => [penMeters, penMeters, getStemMeters(rowIndex)],
    getOrientation: (rowIndex) => headingToOrientation(getHeading(rowIndex)),
    updateTriggers: {
      ...triggers,
      getColor: [...(triggers.getColor ?? [])],
      getPosition: [...(triggers.getPosition ?? [])],
      getScale: [...(triggers.getScale ?? []), penMeters],
      getOrientation: [...(triggers.getOrientation ?? [])],
    },
  });

  const head = new SimpleMeshLayer<ArrowRow>({
    ...sharedProps,
    id: `${idPrefix}-head`,
    mesh: headMesh,
    getScale: () => [penMeters, penMeters, penMeters],
    getOrientation: (rowIndex) => headingToOrientation(getHeading(rowIndex)),
    // The head socket sits at the stem tip.
    getTranslation: (rowIndex) => headingOffset(getHeading(rowIndex), getStemMeters(rowIndex)),
    updateTriggers: {
      ...triggers,
      getColor: [...(triggers.getColor ?? [])],
      getPosition: [...(triggers.getPosition ?? [])],
      getScale: [...(triggers.getScale ?? []), penMeters],
      getOrientation: [...(triggers.getOrientation ?? [])],
      getTranslation: [...(triggers.getTranslation ?? [])],
    },
  });

  return [stem, head];
};

export default build3dDisplacementArrowLayers;

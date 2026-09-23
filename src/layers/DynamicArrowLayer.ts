import { ScatterplotLayer } from '@deck.gl/layers';
import type { ScatterplotLayerProps } from '@deck.gl/layers';
import type { Accessor, DefaultProps } from '@deck.gl/core';

import { getArrowShaderInjections, type ArrowGlyph } from './DynamicArrowLayer.shader';

/**
 * Props supported by the {@link DynamicArrowLayer}.
 *
 * Extends the ScatterplotLayer props with per-instance arrow geometry accessors.
 * All geometry accessors return normalized values (fractions of the point quad
 * half-side): the fragment shader rasterizes the arrow shape inside the quad
 * using an SDF.
 */
export interface DynamicArrowLayerProps<DataT = any> extends ScatterplotLayerProps<DataT> {
  /** Arrow rotation in degrees, counter-clockwise. 0 = pointing up. */
  getAngle?: Accessor<DataT, number>;
  /**
   * Normalized stem length (fraction of the point quad half-side). The stem
   * spans from the arrow tail (the anchor unless `anchorCentered` is set) to
   * `getStemLength`.
   */
  getStemLength?: Accessor<DataT, number>;
  /**
   * Normalized stem thickness, full width (fraction of the point quad
   * half-side); the shader halves it to get the half-width.
   */
  getStemThickness?: Accessor<DataT, number>;
  /**
   * Normalized arrow head length (fraction of the point quad half-side). The
   * head spans from the stem tip to `getStemLength + getHeadSize`.
   */
  getHeadSize?: Accessor<DataT, number>;
  /**
   * Normalized arrow head base width, full width (fraction of the point quad
   * half-side); the shader halves it to get the half-width.
   */
  getHeadWidth?: Accessor<DataT, number>;
  /**
   * When true the arrow is centered on its anchor: the tail starts half the
   * total arrow length before the anchor and the head tip ends half after it.
   * When false (default) the arrow tail sits on the anchor. Resolved at
   * shader-compile time — it is not a per-instance attribute, to stay within
   * the WebGL instanced-attribute limit.
   */
  anchorCentered?: boolean;
  /**
   * Arrow head glyph rasterized by the shader: `triangle` (default), `barbed`,
   * `dart` or `open`. Resolved at shader-compile time — it is not a per-instance
   * attribute, to stay within the WebGL instanced-attribute limit.
   */
  glyph?: ArrowGlyph;
  /**
   * When true the unselected arrow drops the default 1px transparent stroke and
   * renders only a smaller soft fringe. Selection and hover strokes are
   * unaffected. Resolved at shader-compile time (not a per-instance attribute,
   * to stay within the WebGL instanced-attribute limit).
   */
  thinEdge?: boolean;
}

const defaultProps: DefaultProps<DynamicArrowLayerProps> = {
  ...ScatterplotLayer.defaultProps,
  getAngle: { type: 'accessor', value: 0 },
  getStemLength: { type: 'accessor', value: 0.3 },
  getStemThickness: { type: 'accessor', value: 0.05 },
  getHeadSize: { type: 'accessor', value: 0.15 },
  getHeadWidth: { type: 'accessor', value: 0.1 },
  anchorCentered: false,
  glyph: 'triangle',
  thinEdge: false,
  // The shader treats a non-zero line alpha as "selected" and paints the
  // selection stroke, so default the line color to fully transparent. Without
  // this, a standalone instance (no `getLineColor` accessor) would inherit the
  // ScatterplotLayer's opaque default and render every arrow as selected.
  getLineColor: { type: 'accessor', value: [0, 0, 0, 0] }
};

/**
 * A ScatterplotLayer subclass that renders each point as a flat arrow (stem +
 * flared head), rasterized in the fragment shader with a signed-distance field.
 *
 * The arrow geometry accessors are fractions of the quad half-side, so the
 * rendered arrow matches the on-map meters exactly. The visible stroke widths
 * come from `./selectionConstants`: unselected arrows render a soft transparent
 * edge, selected features render a solid stroke of `SELECTED_FEATURE_LINE_WIDTH`
 * + 1px feather in the selection color. `getLineColor` carries the per-feature
 * selection border color with alpha `0` for unselected features, which the
 * shader reads to detect selection (`vArrowLine.a > 0`); it defaults to
 * transparent so an unconfigured instance does not render as selected.
 *
 * Mirrors `app-damStabilityInspector/src/lib/layers/factory/DynamicArrowLayer.ts`
 * (deck.gl 9).
 *
 * @typeParam DataT - Feature type consumed by the accessors.
 * @typeParam ExtraPropsT - Additional props mixed into the layer's resolved props.
 */
export class DynamicArrowLayer<DataT = any, ExtraPropsT extends object = object> extends ScatterplotLayer<
  DataT,
  Required<DynamicArrowLayerProps<DataT>> & ExtraPropsT
> {
  static layerName = 'DynamicArrowLayer';
  static defaultProps = defaultProps;

  /**
   * Extends the ScatterplotLayer shaders with the arrow SDF rasterization
   * (defined in `DynamicArrowLayer.shader.ts`).
   *
   * @returns The merged shader descriptors (vertex + fragment with injections).
   */
  getShaders() {
    const shaders = super.getShaders();
    shaders.inject = getArrowShaderInjections({
      anchorCentered: Boolean(this.props.anchorCentered),
      glyph: this.props.glyph ?? 'triangle',
      thinEdge: Boolean(this.props.thinEdge)
    });
    return shaders;
  }

  /**
   * Registers the per-instance arrow geometry attributes.
   *
   * Only the arrow-specific geometry is registered here. Fill/line colors and
   * the line width reuse the attributes the base ScatterplotLayer already
   * registers (`instanceFillColors`, `instanceLineColors`, `instanceLineWidths`)
   * instead of a second copy of the same colors, which keeps the layer within
   * the WebGL instanced-attribute budget; the shader forwards them as the
   * `vArrowFill`/`vArrowLine` varyings.
   */
  initializeState() {
    super.initializeState();

    this.getAttributeManager()!.addInstanced({
      instanceAngles: {
        size: 1,
        accessor: 'getAngle',
        defaultValue: 0
      },
      instanceStemLengths: {
        size: 1,
        accessor: 'getStemLength',
        defaultValue: 0.3
      },
      instanceStemThicknesses: {
        size: 1,
        accessor: 'getStemThickness',
        defaultValue: 0.05
      },
      instanceHeadSizes: {
        size: 1,
        accessor: 'getHeadSize',
        defaultValue: 0.15
      },
      instanceHeadWidths: {
        size: 1,
        accessor: 'getHeadWidth',
        defaultValue: 0.1
      }
    });
  }
}

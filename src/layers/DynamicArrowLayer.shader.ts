/**
 * GLSL injections that rasterize a flat arrow glyph inside the ScatterplotLayer
 * point quad using a signed-distance field.
 *
 * The arrow geometry accessors (`getStemLength`, `getStemThickness`,
 * `getHeadSize`, `getHeadWidth`, `getAngle`) feed per-instance attributes read
 * by the vertex shader and forwarded as varyings to the fragment shader. All
 * geometry values are fractions of the point quad half-side; the fragment
 * shader maps them back to pixels so the rendered arrow matches the on-map
 * meters exactly.
 *
 * Four glyph heads are supported and selected at shader-compile time via
 * {@link ArrowGlyph}:
 * - `triangle` — rectangle stem + straight triangular head (legacy default).
 * - `barbed`   — swept-back barbed head (the "standard" SVG arrow).
 * - `dart`     — forward-flared kite/dart head (the "bold" SVG arrow).
 * - `open`     — rounded stem + open V head made of two capsule strokes (the
 *   "open V" SVG arrow).
 *
 * Every non-`triangle` glyph is given a minimum stem length that keeps the tail
 * behind the head "wings", then the data-driven stem length is added on top.
 * The minimum reserves a shared bare-stem distance in front of the glyph's own
 * wing sweep, so all presets show the same visible stem from the tail to the
 * wings even though their wings sweep back by different amounts. Without it a
 * head that sweeps back further than the stem leaves no visible tail and the
 * glyph reads as a bare chevron. The minimum is applied in the vertex shader so
 * the centered-anchor offset uses the same stem length as the fragment geometry.
 *
 * Whether the arrow is centered on its anchor or starts at it is resolved at
 * shader-compile time from a per-layer flag — deliberately NOT a per-instance
 * attribute, because ScatterplotLayer already sits close to the WebGL
 * instanced-attribute limit.
 *
 * The stroke widths are hardcoded in pixels, expressed in CSS pixels via the
 * device pixel ratio (passed from the vertex shader as a varying, because
 * `dFdx` measures per device pixel and the `project` uniform block is only
 * declared in the vertex shader).
 *
 * Ported from `app-damStabilityInspector/src/lib/layers/factory/DynamicArrowLayer.shader.ts`
 * (which imports the shared selection constant from its own constants module).
 * The sandbox has no shared selection-constants module, so the value is inlined
 * here; it must stay in sync with the factory's `SELECTED_FEATURE_LINE_WIDTH`.
 */

/** Identifies the arrow head glyph rasterized by the fragment shader. */
export type ArrowGlyph = 'triangle' | 'barbed' | 'dart' | 'open';

/**
 * Line width (CSS pixels) applied to selected features. Mirrors the factory
 * `SELECTED_FEATURE_LINE_WIDTH`.
 */
const SELECTED_FEATURE_LINE_WIDTH = 3;

/**
 * Head outlines for the solid polygon glyphs, expressed as GLSL vertex
 * expressions in terms of `thick` (stem half thickness), `headHalfWidth` (w),
 * `headBaseY` (L) and `vHeadSize` (H).
 *
 * Each glyph is a list of full, both-halves simple polygons; the arrow SDF is
 * the union of those polygons. Along offsets are relative to the stem end
 * `headBaseY`, positive toward the tip.
 *
 * `triangle` and `barbed` are traced as ONE combined polygon that already
 * includes the stem: unioning a stem rectangle with the head as two separate
 * shapes leaves a coincident boundary along their seam, where the SDF is 0 and
 * the stroke logic paints a false internal line. `dart` keeps its two
 * overlapping quads plus an explicit stem rectangle — its quads genuinely
 * overlap (no coincident boundary), so no seam line appears.
 */
const HEAD_POLYGONS: Record<Exclude<ArrowGlyph, 'open'>, string[][]> = {
  triangle: [
    [
      'vec2(thick, 0.0)',
      'vec2(thick, headBaseY)',
      'vec2(headHalfWidth, headBaseY)',
      'vec2(0.0, headTipY)',
      'vec2(-headHalfWidth, headBaseY)',
      'vec2(-thick, headBaseY)',
      'vec2(-thick, 0.0)'
    ]
  ],
  barbed: [
    [
      'vec2(thick, 0.0)',
      'vec2(thick, headBaseY)',
      'vec2(headHalfWidth, headBaseY - 0.646 * vHeadSize)',
      'vec2(headHalfWidth, headBaseY + 0.077 * vHeadSize)',
      'vec2(0.0, headTipY)',
      'vec2(-headHalfWidth, headBaseY + 0.077 * vHeadSize)',
      'vec2(-headHalfWidth, headBaseY - 0.646 * vHeadSize)',
      'vec2(-thick, headBaseY)',
      'vec2(-thick, 0.0)'
    ]
  ],
  dart: [
    [
      'vec2(-headHalfWidth, headBaseY - 0.567 * vHeadSize)',
      'vec2(-0.712 * headHalfWidth, headBaseY - 0.784 * vHeadSize)',
      'vec2(0.144 * headHalfWidth, headBaseY - 0.109 * vHeadSize)',
      'vec2(0.0, headBaseY + 0.216 * vHeadSize)'
    ],
    [
      'vec2(-0.144 * headHalfWidth, headBaseY - 0.109 * vHeadSize)',
      'vec2(0.712 * headHalfWidth, headBaseY - 0.784 * vHeadSize)',
      'vec2(headHalfWidth, headBaseY - 0.567 * vHeadSize)',
      'vec2(0.0, headBaseY + 0.216 * vHeadSize)'
    ],
    [
      'vec2(-thick, 0.0)',
      'vec2(thick, 0.0)',
      'vec2(thick, headBaseY)',
      'vec2(-thick, headBaseY)'
    ]
  ]
};

/**
 * Rear-most along-axis extent of each glyph's head "wings" behind the head
 * base, as a multiple of `vHeadSize`. `triangle` wings sit on the base (0);
 * `barbed`/`dart` sweep back; the `open` arms sweep back a full head length and
 * additionally add their capsule cap radius (`+ thick`, handled in the min stem
 * expression). Used to equalize the *visible* stem across glyphs.
 */
const WING_BACK_EXTENT_FACTOR: Record<ArrowGlyph, number> = {
  triangle: 0,
  barbed: 0.646,
  dart: 0.784,
  open: 1
};

/**
 * Visible bare stem kept in front of the wings, in pen widths, for every glyph.
 * The minimum stem reserves this much beyond the glyph's own wing sweep, so all
 * presets show the same stem length from the tail to the wings (the head base
 * itself sits further forward for glyphs whose wings sweep back less).
 */
const MIN_BARE_STEM_RATIO = 1;

const ARROW_VS_DECL: string = `
    in float instanceAngles;
    in float instanceStemLengths;
    in float instanceStemThicknesses;
    in float instanceHeadSizes;
    in float instanceHeadWidths;
    in vec4 instanceArrowFillColors;
    in vec4 instanceArrowLineColors;

    out float vAngle;
    out float vStemLength;
    out float vStemThickness;
    out float vHeadSize;
    out float vHeadWidth;
    out float vAnchorOffset;
    out vec4 vArrowFill;
    out vec4 vArrowLine;

    // Capture local geometry position to replace gl_PointCoord
    out vec2 vLocalPos;

    // Device pixel ratio (only available in the vertex shader) — passed to the
    // fragment shader so dFdx-based pixel sizes can be expressed in CSS pixels.
    out float vPixelRatio;
  `;

const ARROW_FS_DECL: string = `
    in float vAngle;
    in float vStemLength;
    in float vStemThickness;
    in float vHeadSize;
    in float vHeadWidth;
    in float vAnchorOffset;
    in vec4 vArrowFill;
    in vec4 vArrowLine;
    in float vPixelRatio;

    // Receive local position from vertex shader
    in vec2 vLocalPos;

    // Rotation matrix helper
    vec2 rotate(vec2 v, float a) {
      float s = sin(a);
      float c = cos(a);
      mat2 m = mat2(c, -s, s, c);
      return m * v;
    }

    // SDF helper: Exact distance to a line segment
    float sdSegment(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      float h = clamp( dot(pa,ba)/dot(ba,ba), 0.0, 1.0 );
      return length( pa - ba*h );
    }

    // SDF helper: distance to a capsule (a segment thickened by radius r)
    float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
      return sdSegment(p, a, b) - r;
    }

    // Winding-number contributor for one polygon edge (division-free isLeft)
    float windingEdge(vec2 pt, vec2 a, vec2 b) {
      if (a.y <= pt.y) {
        if (b.y > pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) > 0.0) {
          return 1.0;
        }
      } else {
        if (b.y <= pt.y && (b.x - a.x) * (pt.y - a.y) - (pt.x - a.x) * (b.y - a.y) < 0.0) {
          return -1.0;
        }
      }
      return 0.0;
    }
  `;

/**
 * Builds the glyph-specific geometry GLSL. The snippet must define a
 * `signedDist` float (negative inside the arrow, positive outside), operating
 * on the local point computed by the shared preamble.
 *
 * @param glyph - Selected arrow head glyph.
 * @returns GLSL statements that compute `signedDist`.
 */
const buildGeometryGLSL = (glyph: ArrowGlyph): string => {
  const preamble = `
    // Map vLocalPos (-1.0 to +1.0) down to our -0.5 to +0.5 math range
    vec2 p = vLocalPos * 0.5;

    // Rotate counter-clockwise (deck.gl uses degrees, GLSL needs radians)
    float radAngle = radians(vAngle);
    p = rotate(p, -radAngle);

    // Per-instance geometry, all fractions of the point quad half-side.
    float thick = vStemThickness * 0.5;
    float headHalfWidth = vHeadWidth * 0.5;
    float headBaseY = vStemLength;
    float headTipY = vStemLength + vHeadSize;
    float y = p.y + vAnchorOffset;

    // Full local point (the arrow axis is x == 0)
    vec2 pt = vec2(p.x, y);
  `;

  if (glyph === 'open') {
    return `${preamble}
    // Rounded stem + two capsule strokes forming an open V head that sweeps
    // back from the tip. headWidth is the full V span, headSize the along-axis
    // arm length. The stem capsule starts at thick (not 0) so its rounded
    // tail cap is tangent to the measurement point (y == 0) instead of
    // overshooting it by half the stroke width. Fold x for the symmetric arms.
    vec2 pa = vec2(abs(pt.x), pt.y);
    float sStem = sdCapsule(pa, vec2(0.0, thick), vec2(0.0, headBaseY), thick);
    float sArm = sdCapsule(pa, vec2(0.0, headBaseY), vec2(headHalfWidth, headBaseY - vHeadSize), thick);
    float signedDist = min(sStem, sArm);
  `;
  }

  const polygons = HEAD_POLYGONS[glyph];
  const headBlocks: string[] = [];
  const headNames: string[] = [];

  polygons.forEach((vertices, polygonIndex) => {
    const vertexDecls = vertices
      .map((vertex, index) => `vec2 g${polygonIndex}_${index} = ${vertex};`)
      .join('\n    ');
    const edgeExprs = vertices.map(
      (_, index) => `sdSegment(pt, g${polygonIndex}_${index}, g${polygonIndex}_${(index + 1) % vertices.length})`
    );
    const dHeadExpr = edgeExprs.reduce((acc, edge) => (acc ? `min(${acc}, ${edge})` : edge), '');
    const wnExpr = vertices
      .map((_, index) => `windingEdge(pt, g${polygonIndex}_${index}, g${polygonIndex}_${(index + 1) % vertices.length})`)
      .join(' + ');

    headBlocks.push(`${vertexDecls}
    float dHead${polygonIndex} = ${dHeadExpr};
    float wn${polygonIndex} = ${wnExpr};
    float sdfHead${polygonIndex} = (wn${polygonIndex} != 0.0) ? -dHead${polygonIndex} : dHead${polygonIndex};`);
    headNames.push(`sdfHead${polygonIndex}`);
  });

  const headUnion = headNames.reduce((acc, name) => (acc ? `min(${acc}, ${name})` : name), '');

  return `${preamble}
    // Arrow: union of the traced full outline polygons. triangle and barbed
    // are authored as a single stem+head polygon; the dart unions two
    // overlapping quads with an explicit stem rectangle. Unioning full
    // polygons avoids the false SDF boundary (and internal stroke line) that a
    // separate stem+head split produces along their shared seam.
    ${headBlocks.join('\n    ')}

    float signedDist = ${headUnion};
  `;
};

/**
 * Builds the arrow GLSL injections for a `DynamicArrowLayer`.
 *
 * @param options - Injection options.
 * @param options.anchorCentered - When true the arrow is centered on the anchor
 * (tail starts half its total length before the anchor and the head tip ends
 * half after it). When false the tail stays on the anchor.
 * @param options.glyph - Arrow head glyph to rasterize. Defaults to `triangle`.
 * @returns The merged shader injections (vertex + fragment).
 */
export const getArrowShaderInjections = ({
  anchorCentered,
  glyph = 'triangle'
}: {
  anchorCentered: boolean;
  glyph?: ArrowGlyph;
}): Record<string, string> => {
  // Minimum stem length. It reserves a shared bare-stem distance (`MIN_BARE_STEM_RATIO`
  // pen widths) *in front of the glyph's own wing sweep*, so the visible stem is
  // the same for every preset even though the head base sits at a different
  // distance (the wings sweep back by different amounts per glyph). The legacy
  // `triangle` head keeps the pure data-driven stem.
  const wingBackExpr =
    glyph === 'open'
      ? '(instanceHeadSizes + instanceStemThicknesses * 0.5)'
      : `${WING_BACK_EXTENT_FACTOR[glyph]} * instanceHeadSizes`;
  const minStemExpr =
    glyph === 'triangle'
      ? '0.0'
      : `${MIN_BARE_STEM_RATIO.toFixed(1)} * instanceStemThicknesses + ${wingBackExpr}`;

  const vsMainEnd: string = `
    vAngle = instanceAngles;
    vStemThickness = instanceStemThicknesses;
    vHeadSize = instanceHeadSizes;
    vHeadWidth = instanceHeadWidths;
    // Keep the tail behind the wings: a stem shorter than the head's backward
    // sweep leaves no bare stem, so the glyph reads as a bare chevron. Reserve
    // the shared bare-stem distance, then ADD the data-driven stem length so any
    // scaling grows the arrow while preserving its shape.
    float minStemLength = ${minStemExpr};
    vStemLength = minStemLength + instanceStemLengths;
    // Centered arrows shift by half their total length so the anchor lands in
    // the middle of the glyph; tail-anchored arrows keep the anchor at the tail (0).
    vAnchorOffset = ${anchorCentered ? '(vStemLength + vHeadSize) * 0.5' : '0.0'};

    // Use straight (unpremultiplied) alpha to match deck.gl's SRC_ALPHA / ONE_MINUS_SRC_ALPHA blending
    vec3 fillRGB = instanceArrowFillColors.rgb;
    float fillA = instanceArrowFillColors.a * layer.opacity;
    vArrowFill = vec4(fillRGB, fillA);

    vec3 lineRGB = instanceArrowLineColors.rgb;
    float lineA = instanceArrowLineColors.a * layer.opacity;
    vArrowLine = vec4(lineRGB, lineA);

    // Use the base shader's unitPosition (edgePadding * positions) so the SDF
    // coordinate space matches the actually-rendered quad; the raw positions
    // attribute ignores the edgePadding antialiasing inflation, which would
    // scale every arrow dimension by edgePadding and break the meter-for-meter
    // match with the 3D arrows at low zoom (see deck.gl ScatterplotLayer vertex
    // shader: edgePadding = (outerRadiusPixels + SMOOTH_EDGE_RADIUS) / outerRadiusPixels).
    vLocalPos = unitPosition;

    vPixelRatio = project.devicePixelRatio;
  `;

  const filterColor: string = `
    ${buildGeometryGLSL(glyph)}

    // Anti-aliasing and Outward Stroke logic
    // dFdx measures per DEVICE pixel, while deck.gl's pixel units (and the
    // circle stroke widths) are CSS pixels. Multiplying by the device pixel
    // ratio (passed from the vertex shader) makes the hardcoded stroke widths
    // render at the intended CSS-pixel size on any display (e.g. retina DPR 2),
    // so the arrow's selection stroke matches the circles' 3px ring instead of
    // rendering at half width.
    float pixelSize = length(vec2(dFdx(p.x), dFdy(p.x))) * vPixelRatio;

    // Detect if the arrow is selected based on the transparent alpha
    // Check for > 0.0 so selection works perfectly regardless of the overall layer.opacity scale
    bool isSelected = vArrowLine.a > 0.0;

    // Unselected arrows render a soft transparent edge like the circles'
    // stroke: a fully transparent-black stroke whose only visible effect is a
    // wider AA gradient (see innerFeather below) that fades the fill to
    // transparent — mirroring the ScatterplotLayer's invisible 1px ring
    // instead of a hard line. Selected features use the shared selection line
    // width (3px) plus the 1px outer feather, so the SOLID part of the stroke
    // is exactly 3px — visually matching the crisp 3px selection ring of the
    // circle points.
    float activeStrokeW = (isSelected ? (${SELECTED_FEATURE_LINE_WIDTH}.0 + 1.0) : 1.0) * pixelSize;

    // Use a standard soft feather for the outer boundary to smooth it against the map background
    float outerFeather = 1.0 * pixelSize;

    // The inner fill/stroke transition. Selected features keep the razor-sharp
    // feather so the 3px ring stays crisp; unselected arrows widen it so the
    // transparent-black stroke reads as a soft ~1px fade-to-transparent edge
    // (like the circles' invisible stroke) instead of a barely-visible thin
    // line.
    float innerFeather = (isSelected ? 0.15 : 0.5) * pixelSize;

    // Discard pixels far outside the stroke buffer
    if (signedDist > activeStrokeW + outerFeather) {
      discard;
    }

    // 1. Calculate the outer edge anti-aliasing (fade to transparent)
    float outerAlpha = 1.0 - smoothstep(activeStrokeW - outerFeather, activeStrokeW + outerFeather, signedDist);

    // 2. Mix the Fill and Line colors using the (un)selected feather width
    float fillMix = 1.0 - smoothstep(-innerFeather, innerFeather, signedDist);

    // Selected features stroke with the selection color. Unselected arrows use
    // a fully transparent-black stroke — the soft transparent edge is produced
    // by the widened AA gradient above (mixing toward transparent black lowers
    // alpha only; it does not darken the fill), exactly like the circle
    // sublayer's transparent stroke.
    vec4 finalStrokeColor = isSelected ? vArrowLine : vec4(0.0, 0.0, 0.0, 0.0);

    // Apply the final colors
    color = mix(finalStrokeColor, vArrowFill, fillMix);
    // Straight alpha: fade only the alpha for coverage, not the RGB
    color.a *= outerAlpha;
  `;

  return {
    'vs:#decl': ARROW_VS_DECL,
    'vs:#main-end': vsMainEnd,
    'fs:#decl': ARROW_FS_DECL,
    'fs:DECKGL_FILTER_COLOR': filterColor
  };
};

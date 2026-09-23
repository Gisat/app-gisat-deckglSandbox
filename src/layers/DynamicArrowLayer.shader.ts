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
 * Glyph shapes are selected at shader-compile time via {@link ArrowGlyph}:
 * - `triangle` — filled rectangle stem + triangular head (the legacy / data
 *   path).
 * - `open`, `dart`, `barbed` — one and the same stroked open-V arrow: a stem
 *   plus two barbs drawn with a single pen, so the head's stroke always equals
 *   the stem's. They differ only in their caps, per {@link STROKED_ARROW_CAP}:
 *   round ends and apex (`open`), flat/perpendicular ends with a mitered point
 *   (`dart`), or flat/vertical ends with a mitered point (`barbed`).
 *
 * Every stroked glyph is given a minimum stem length that keeps the tail behind
 * the head barbs, then the data-driven stem length is added on top. The minimum
 * reserves a shared bare-stem distance in front of the barbs, so all glyphs show
 * the same visible stem from the tail to the barbs. Without it a head whose barbs
 * sweep back further than the stem leaves no visible tail and the glyph reads as
 * a bare chevron. The minimum is applied in the vertex shader so the
 * centered-anchor offset uses the same stem length as the fragment geometry.
 *
 * Whether the arrow is centered on its anchor or starts at it is resolved at
 * shader-compile time from a per-layer flag — deliberately NOT a per-instance
 * attribute, because ScatterplotLayer already sits close to the WebGL
 * instanced-attribute limit.
 *
 * The stroke widths are fixed values taken from the dependency-free
 * `./selectionConstants` module, expressed in CSS pixels via the device pixel
 * ratio (passed from the vertex shader as a varying, because `dFdx` measures
 * per device pixel and the `project` uniform block is only declared in the
 * vertex shader). The compile-time `thinEdge` flag sets the unselected width to 0
 * so the arrow renders a smaller soft fringe instead of its default 1px edge.
 *
 * Ported from `app-damStabilityInspector/src/lib/layers/factory/DynamicArrowLayer.shader.ts`.
 * There the widths come from a shared `@lib/symbologies/constants/selection`
 * module; the sandbox equivalent is `./selectionConstants`, so the shader and
 * the symbology accessors share one source of truth.
 */

import {
  NON_SELECTED_FEATURE_LINE_WIDTH,
  SELECTED_FEATURE_LINE_WIDTH
} from './selectionConstants';

/** Identifies the arrow head glyph rasterized by the fragment shader. */
export type ArrowGlyph = 'triangle' | 'barbed' | 'dart' | 'open';

/**
 * Cap treatment of a stroked glyph's ends. The three stroked glyphs (`open`,
 * `dart`, `barbed`) share one centerline — a stem plus an open-V head drawn with
 * the same pen, so the head's stroke always equals the stem's — and differ only
 * in their caps:
 * - `round`    — line-cap `round` (capsule ends), rounded apex.
 * - `butt`     — free ends cut flat perpendicular to each segment, apex mitered
 *   to a point.
 * - `vertical` — free ends cut flat parallel to the arrow axis, apex mitered to
 *   a point.
 */
export type ArrowCap = 'round' | 'butt' | 'vertical';

/** Free-end cap treatment of each stroked glyph. */
export const STROKED_ARROW_CAP: Record<Exclude<ArrowGlyph, 'triangle'>, ArrowCap> = {
  open: 'round',
  dart: 'butt',
  barbed: 'vertical'
};

/**
 * Head outline of the filled `triangle` glyph (the data-driven fill head),
 * expressed as GLSL vertex expressions in terms of `thick` (stem half
 * thickness), `headHalfWidth` (w), `headBaseY` (L) and `headTipY`.
 *
 * Authored as ONE combined polygon that already includes the stem: unioning a
 * stem rectangle with the head as two separate shapes leaves a coincident
 * boundary along their seam, where the SDF is 0 and the stroke logic paints a
 * false internal line.
 */
const TRIANGLE_HEAD_POLYGON: string[] = [
  'vec2(thick, 0.0)',
  'vec2(thick, headBaseY)',
  'vec2(headHalfWidth, headBaseY)',
  'vec2(0.0, headTipY)',
  'vec2(-headHalfWidth, headBaseY)',
  'vec2(-thick, headBaseY)',
  'vec2(-thick, 0.0)'
];

/**
 * Visible bare stem kept in front of the wings, in pen widths, for every glyph.
 * The minimum stem reserves this much beyond the glyph's own wing sweep, so all
 * presets show the same stem length from the tail to the wings (the head base
 * itself sits further forward for glyphs whose wings sweep back less).
 */
const MIN_BARE_STEM_RATIO = 1;

/**
 * Renders a JS number as a GLSL float literal without precision loss (an
 * integer gets a `.0` suffix; anything else is emitted verbatim), unlike
 * `toFixed`, which would silently round a value such as `0.25` to `0.2`.
 *
 * @param value - Numeric literal to emit.
 * @returns A valid GLSL float literal for `value`.
 */
const glslFloat = (value: number): string => (Number.isInteger(value) ? `${value}.0` : `${value}`);

const ARROW_VS_DECL: string = `
    in float instanceAngles;
    in float instanceStemLengths;
    in float instanceStemThicknesses;
    in float instanceHeadSizes;
    in float instanceHeadWidths;

    out float vAngle;
    out float vStemLength;
    out float vStemThickness;
    out float vHeadSize;
    out float vHeadWidth;
    out float vAnchorOffset;

    // Colors forwarded from the base ScatterplotLayer attributes. They need
    // their own varyings because the injection is emitted before the base
    // shader's own varyings are declared, so the fragment hook cannot see
    // vFillColor/vLineColor directly.
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

    // SDF helper: exact distance to a triangle
    float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
      vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
      vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
      vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
      vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
      vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
      float s = sign(e0.x * e2.y - e0.y * e2.x);
      vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                       vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                       vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
      return -sqrt(d.x) * sign(d.y);
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
 * Builds the stroked open-V arrow body for a cap treatment: a stem from the tail
 * to the apex plus one barb (the other is its mirror through `pa`), both stroked
 * with `thick`. Defines `signedDist`.
 *
 * `round` keeps the capsule's rounded apex; the flat-capped variants (`butt`,
 * `vertical`) add a miter wedge that runs the barbs' outer edges to their
 * intersection, so the tip comes to a point instead of a round cap.
 *
 * @param cap - Free-end cap treatment.
 * @returns GLSL statements defining `signedDist`.
 */
const buildStrokedArrowGLSL = (cap: ArrowCap): string => {
  const stem =
    cap === 'round'
      ? 'sdCapsule(pa, vec2(0.0, thick), vec2(0.0, headBaseY), thick)'
      : 'max(sdCapsule(pa, vec2(0.0, 0.0), vec2(0.0, headBaseY), thick), -pa.y)';
  const armBase = 'sdCapsule(pa, vec2(0.0, headBaseY), vec2(headHalfWidth, headBaseY - vHeadSize), thick)';
  const arm =
    cap === 'round'
      ? armBase
      : cap === 'butt'
        ? `max(${armBase}, dot(pa - vec2(headHalfWidth, headBaseY - vHeadSize), normalize(vec2(headHalfWidth, -vHeadSize))))`
        : `max(${armBase}, pa.x - headHalfWidth)`;

  if (cap === 'round') {
    return `float sStem = ${stem};
    float sArm = ${arm};
    float signedDist = min(sStem, sArm);`;
  }

  // Pointed tip: the miter wedge between the two barbs' outer edges. Both edges
  // are tangent to the apex's capsule cap at the barb's outer corner, so the
  // union stays smooth and only the forward tip is sharpened to a point.
  return `float sStem = ${stem};
    float sArm = ${arm};
    float armLength = length(vec2(headHalfWidth, -vHeadSize));
    float miterExtend = thick * armLength / headHalfWidth;
    float miterShoulderY = headBaseY + headHalfWidth * thick / armLength;
    float sTip = sdTriangle(
      pa,
      vec2(0.0, headBaseY + miterExtend),
      vec2(0.0, miterShoulderY),
      vec2(vHeadSize * thick / armLength, miterShoulderY)
    );
    float signedDist = min(sStem, min(sArm, sTip));`;
};

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
    float y = p.y + vAnchorOffset;

    // Full local point (the arrow axis is x == 0)
    vec2 pt = vec2(p.x, y);
  `;

  if (glyph !== 'triangle') {
    return `${preamble}
    // Stroked open-V arrow: one pen (thick) draws the stem and both barbs, so
    // the head's stroke always equals the stem's. headWidth is the full V span,
    // headSize the along-axis arm length. Only the cap treatment differs between
    // the stroked glyphs (see STROKED_ARROW_CAP). Fold x for the symmetric barbs.
    vec2 pa = vec2(abs(pt.x), pt.y);
    ${buildStrokedArrowGLSL(STROKED_ARROW_CAP[glyph])}
  `;
  }

  // Filled data-driven head: SDF of the single traced outline polygon.
  const vertices = TRIANGLE_HEAD_POLYGON;
  const vertexDecls = vertices.map((vertex, index) => `vec2 g${index} = ${vertex};`).join('\n    ');
  const edgeExprs = vertices.map((_, index) => `sdSegment(pt, g${index}, g${(index + 1) % vertices.length})`);
  const dHeadExpr = edgeExprs.reduce((acc, edge) => (acc ? `min(${acc}, ${edge})` : edge), '');
  const wnExpr = vertices
    .map((_, index) => `windingEdge(pt, g${index}, g${(index + 1) % vertices.length})`)
    .join(' + ');

  return `${preamble}
    // Arrow: the filled data-driven head, authored as one stem+head polygon with
    // no internal seam (a separate stem rectangle would leave a coincident
    // boundary where the SDF is 0 and a false internal stroke line is painted).
    float headTipY = vStemLength + vHeadSize;
    ${vertexDecls}
    float dHead = ${dHeadExpr};
    float wn = ${wnExpr};
    float signedDist = (wn != 0.0) ? -dHead : dHead;
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
 * @param options.thinEdge - When true the unselected stroke width drops to 0, so
 * the arrow keeps only a smaller soft fringe instead of the default 1px
 * transparent edge. Selection / hover strokes are unaffected. Defaults to false.
 * @returns The merged shader injections (vertex + fragment).
 */
export const getArrowShaderInjections = ({
  anchorCentered,
  glyph = 'triangle',
  thinEdge = false
}: {
  anchorCentered: boolean;
  glyph?: ArrowGlyph;
  thinEdge?: boolean;
}): Record<string, string> => {
  // Minimum stem length. The stroked glyphs' barbs sweep back a full head length
  // plus their capsule cap radius, so the reserve keeps the bare stem visible;
  // the filled `triangle` head keeps the pure data-driven stem.
  const wingBackExpr = '(instanceHeadSizes + instanceStemThicknesses * 0.5)';
  const minStemExpr =
    glyph === 'triangle'
      ? '0.0'
      : `${glslFloat(MIN_BARE_STEM_RATIO)} * instanceStemThicknesses + ${wingBackExpr}`;

  // Unselected arrows default to a 1px transparent stroke (a soft fade-to-
  // transparent edge). `thinEdge` drops it to 0 so the fill meets the stroke
  // band directly, leaving a smaller fringe. The selected stroke is unchanged.
  const unselectedStrokeWidth = thinEdge ? 0 : NON_SELECTED_FEATURE_LINE_WIDTH;

  const vsMainEnd: string = `
    vAngle = instanceAngles;
    vStemThickness = instanceStemThicknesses;
    vHeadSize = instanceHeadSizes;
    vHeadWidth = instanceHeadWidths;
    // Keep the tail behind the wings: a stem shorter than the head's backward
    // sweep leaves no bare stem, so the glyph reads as a bare chevron. Reserve
    // the shared bare-stem distance, then ADD the data-driven (vel_rel) stem
    // length so the arrow grows from the tail while its shape is preserved.
    float minStemLength = ${minStemExpr};
    vStemLength = minStemLength + instanceStemLengths;
    // Centered arrows shift by half their total length so the anchor lands in
    // the middle of the glyph; tail-anchored arrows keep the anchor at the tail (0).
    vAnchorOffset = ${anchorCentered ? '(vStemLength + vHeadSize) * 0.5' : '0.0'};

    // Forward the per-instance colors from the base ScatterplotLayer attributes
    // (registered by the parent, so no second copy of the same colors is needed).
    // Use straight (unpremultiplied) alpha to match deck.gl's SRC_ALPHA /
    // ONE_MINUS_SRC_ALPHA blending.
    vArrowFill = vec4(instanceFillColors.rgb, instanceFillColors.a * layer.opacity);
    vArrowLine = vec4(instanceLineColors.rgb, instanceLineColors.a * layer.opacity);

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
    // ratio (passed from the vertex shader) makes the fixed stroke widths
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
    // width plus the 1px outer feather, so the SOLID part of the stroke is
    // exactly the selection width — visually matching the crisp selection ring
    // of the circle points.
    float activeStrokeW = (isSelected
      ? (${glslFloat(SELECTED_FEATURE_LINE_WIDTH)} + 1.0)
      : ${glslFloat(unselectedStrokeWidth)}) * pixelSize;

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

    // Apply the final colors. The fill/line colors were forwarded from the base
    // ScatterplotLayer color attributes in the vertex shader.
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

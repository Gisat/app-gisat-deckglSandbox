/**
 * GLSL injections that rasterize the flat arrow (stem + flared head) inside the
 * ScatterplotLayer point quad using a signed-distance field.
 *
 * The arrow geometry accessors (`getStemLength`, `getStemThickness`,
 * `getHeadSize`, `getHeadWidth`, `getAngle`) feed per-instance attributes read
 * by the vertex shader and forwarded as varyings to the fragment shader. All
 * geometry values are fractions of the point quad half-side; the fragment
 * shader maps them back to pixels so the rendered arrow matches the on-map
 * meters exactly.
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

/**
 * Line width (CSS pixels) applied to selected features. Mirrors the factory
 * `SELECTED_FEATURE_LINE_WIDTH`.
 */
const SELECTED_FEATURE_LINE_WIDTH = 3;

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
  `;

const ARROW_FILTER_COLOR: string = `
    // Map vLocalPos (-1.0 to +1.0) down to our -0.5 to +0.5 math range
    vec2 p = vLocalPos * 0.5;

    // Rotate counter-clockwise (deck.gl uses degrees, GLSL needs radians)
    float radAngle = radians(vAngle);
    p = rotate(p, -radAngle);

    // Geometry: the stem is a rectangle anchored at the geographic position
    // (p.y == 0.0) extending to the head base; the head is a triangle flaring
    // from the stem tip. Stem and head are independent (like the 3D arrows), so
    // the head may be longer than the stem. All values are fractions of the
    // point quad half-side.
    //
    // An optional along-axis shift (vAnchorOffset) offsets the whole arrow so
    // its tail no longer sits on the anchor: with vAnchorOffset = totalLength /
    // 2 the arrow is centered on the anchor, while 0 keeps the anchor at the
    // tail.
    float thick = vStemThickness * 0.5;
    float headHalfWidth = vHeadWidth * 0.5;
    float headBaseY = vStemLength;
    float headTipY = vStemLength + vHeadSize;
    float y = p.y + vAnchorOffset;

    // Fold X for symmetry (we only need to calculate the right side of the arrow)
    vec2 p_abs = vec2(abs(p.x), y);

    // 1. Boolean inside check (defines the fill area)
    bool inStem = p_abs.x <= thick && y >= 0.0 && y <= headBaseY;
    float currentHeadWidth = headHalfWidth * (headTipY - y) / max(vHeadSize, 0.0001);
    // FIX: Changed '>' to '>=' to guarantee no microscopic floating-point gaps at the exact joint
    bool inHead = y >= headBaseY && y <= headTipY && p_abs.x <= currentHeadWidth;
    bool isInside = inStem || inHead;

    // 2. Exact Euclidean distance to the arrow boundary (4 line segments)
    vec2 v1 = vec2(0.0, 0.0);              // Bottom center (arrow tail)
    vec2 v2 = vec2(thick, 0.0);            // Bottom right corner
    vec2 v3 = vec2(thick, headBaseY);      // Inner corner (stem meets head)
    vec2 v4 = vec2(headHalfWidth, headBaseY); // Outer corner (head overhang)
    vec2 v5 = vec2(0.0, headTipY);         // Top tip

    float d1 = sdSegment(p_abs, v1, v2); // Bottom base
    float d2 = sdSegment(p_abs, v2, v3); // Outer stem side
    float d3 = sdSegment(p_abs, v3, v4); // Head overhang
    float d4 = sdSegment(p_abs, v4, v5); // Head slope

    // Minimum distance to the closest boundary line
    float dist = min(min(d1, d2), min(d3, d4));

    // 3. Anti-aliasing and Outward Stroke logic
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

    // Create a true Signed Distance Field: negative inside, positive outside
    float signedDist = isInside ? -dist : dist;

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

/**
 * Builds the arrow GLSL injections for a `DynamicArrowLayer`.
 *
 * @param options - Injection options.
 * @param options.anchorCentered - When true the arrow is centered on the anchor
 * (tail starts half its total length before the anchor and the head tip ends
 * half after it). When false the tail stays on the anchor.
 * @returns The merged shader injections (vertex + fragment).
 */
export const getArrowShaderInjections = ({ anchorCentered }: { anchorCentered: boolean }): Record<string, string> => {
  const vsMainEnd: string = `
    vAngle = instanceAngles;
    vStemLength = instanceStemLengths;
    vStemThickness = instanceStemThicknesses;
    vHeadSize = instanceHeadSizes;
    vHeadWidth = instanceHeadWidths;
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

  return {
    'vs:#decl': ARROW_VS_DECL,
    'vs:#main-end': vsMainEnd,
    'fs:#decl': ARROW_FS_DECL,
    'fs:DECKGL_FILTER_COLOR': ARROW_FILTER_COLOR
  };
};

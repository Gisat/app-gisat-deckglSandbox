import {ScatterplotLayer} from '@deck.gl/layers';
import type {ScatterplotLayerProps} from '@deck.gl/layers';
import type {Accessor, DefaultProps} from '@deck.gl/core';

export interface DynamicArrowLayerProps<DataT = any> extends ScatterplotLayerProps<DataT> {
  /** Arrow rotation in degrees, counter-clockwise. */
  getAngle?: Accessor<DataT, number>;
  /** Normalized stem length, e.g. between 0.2 and 0.8. */
  getStemLength?: Accessor<DataT, number>;
  /** Normalized stem thickness, e.g. between 0.05 and 0.2. */
  getStemThickness?: Accessor<DataT, number>;
  /** Normalized arrow head size, e.g. 0.3. */
  getHeadSize?: Accessor<DataT, number>;
}

const defaultProps: DefaultProps<DynamicArrowLayerProps> = {
  ...ScatterplotLayer.defaultProps,
  getAngle: {type: 'accessor', value: 0},
  getStemLength: {type: 'accessor', value: 0.5},
  getStemThickness: {type: 'accessor', value: 0.1},
  getHeadSize: {type: 'accessor', value: 0.3}
};

export default class DynamicArrowLayer<DataT = any, ExtraPropsT extends {} = {}> extends ScatterplotLayer<
  DataT,
  Required<DynamicArrowLayerProps<DataT>> & ExtraPropsT
> {
  static layerName = 'DynamicArrowLayer';
  static defaultProps = defaultProps;

  getShaders() {
    const shaders = super.getShaders();

    shaders.inject = {
      'vs:#decl': `
    in float instanceAngles;
    in float instanceStemLengths;
    in float instanceStemThicknesses;
    in float instanceHeadSizes;
    in vec4 instanceArrowFillColors;
    in vec4 instanceArrowLineColors;
    
    out float vAngle;
    out float vStemLength;
    out float vStemThickness;
    out float vHeadSize;
    out float vLineWidth;
    out vec4 vArrowFill;
    out vec4 vArrowLine;
    
    // Capture local geometry position to replace gl_PointCoord
    out vec2 vLocalPos;
  `,
      'vs:#main-end': `
    vAngle = instanceAngles;
    vStemLength = instanceStemLengths;
    vStemThickness = instanceStemThicknesses;
    vHeadSize = instanceHeadSizes;
    vLineWidth = instanceLineWidths;
    
    // Use straight (unpremultiplied) alpha to match deck.gl's SRC_ALPHA / ONE_MINUS_SRC_ALPHA blending
    vec3 fillRGB = instanceArrowFillColors.rgb;
    float fillA = instanceArrowFillColors.a * layer.opacity;
    vArrowFill = vec4(fillRGB, fillA);
    
    vec3 lineRGB = instanceArrowLineColors.rgb;
    float lineA = instanceArrowLineColors.a * layer.opacity;
    vArrowLine = vec4(lineRGB, lineA);
    
    // 'positions' is a built-in deck.gl attribute for the base mesh geometry (-1.0 to +1.0)
    vLocalPos = positions.xy;
  `,
      'fs:#decl': `
    in float vAngle;
    in float vStemLength;
    in float vStemThickness;
    in float vHeadSize;
    in float vLineWidth;
    in vec4 vArrowFill;
    in vec4 vArrowLine;
    
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
  `,
      'fs:DECKGL_FILTER_COLOR': `
    // Map vLocalPos (-1.0 to +1.0) down to our -0.5 to +0.5 math range
    vec2 p = vLocalPos * 0.5;
    
    // Rotate counter-clockwise (deck.gl uses degrees, GLSL needs radians)
    float radAngle = radians(vAngle);
    p = rotate(p, -radAngle);
    
    float thick = vStemThickness * 0.5;
    float head = vHeadSize * 0.5;
    // Arrow starts at the geographic position (p.y == 0.0) and extends in the rotated direction.
    // Scaled to half of vStemLength so the head tip plus the outward halo stays inside the point quad/circle.
    float arrowLen = max(vStemLength * 0.5, head);
    
    float headBaseY = arrowLen - head;
    float headTipY = arrowLen;
    
    // Fold X for symmetry (we only need to calculate the right side of the arrow)
    vec2 p_abs = vec2(abs(p.x), p.y);
    
    // 1. Boolean inside check (defines the fill area)
    bool inStem = p_abs.x <= thick && p.y >= 0.0 && p.y <= headBaseY;
    float currentHeadWidth = head * (headTipY - p.y) / max(head, 0.0001);
    // FIX: Changed '>' to '>=' to guarantee no microscopic floating-point gaps at the exact joint
    bool inHead = p.y >= headBaseY && p.y <= headTipY && p_abs.x <= currentHeadWidth;
    bool isInside = inStem || inHead;
    
    // 2. Exact Euclidean distance to the arrow boundary (4 line segments)
    vec2 v1 = vec2(0.0, 0.0);              // Bottom center (anchor = geographic position)
    vec2 v2 = vec2(thick, 0.0);            // Bottom right corner
    vec2 v3 = vec2(thick, headBaseY);      // Inner corner (stem meets head)
    vec2 v4 = vec2(head, headBaseY);       // Outer corner (head overhang)
    vec2 v5 = vec2(0.0, headTipY);         // Top tip
    
    float d1 = sdSegment(p_abs, v1, v2); // Bottom base
    float d2 = sdSegment(p_abs, v2, v3); // Outer stem side
    float d3 = sdSegment(p_abs, v3, v4); // Head overhang
    float d4 = sdSegment(p_abs, v4, v5); // Head slope
    
    // Minimum distance to the closest boundary line
    float dist = min(min(d1, d2), min(d3, d4));
    
    // 3. Anti-aliasing and Outward Stroke logic
    float pixelSize = length(vec2(dFdx(p.x), dFdy(p.x))); 
    
    // Detect if the arrow is selected based on the transparent alpha
    bool isSelected = vArrowLine.a > 0.1;
    
    // Reduce unselected stroke width to 0.5 pixels for a softer look
    float activeStrokeW = (isSelected ? vLineWidth : 0.5) * pixelSize; 
    
    // Use a standard soft feather for the outer boundary to smooth it against the map background
    float outerFeather = 1.0 * pixelSize; 
    
    // FIX: Use a razor-sharp feather for the inner boundary between Fill and Stroke. 
    // A wide feather linearly mixes complementary colors (like Red + Cyan), creating a muddy Dark Gray ring.
    float innerFeather = 0.15 * pixelSize; 
    
    // Create a true Signed Distance Field: negative inside, positive outside
    float signedDist = isInside ? -dist : dist;
    
    // Discard pixels far outside the stroke buffer
    if (signedDist > activeStrokeW + outerFeather) {
      discard;
    }
    
    // 1. Calculate the outer edge anti-aliasing (fade to transparent)
    float outerAlpha = 1.0 - smoothstep(activeStrokeW - outerFeather, activeStrokeW + outerFeather, signedDist);
    
    // 2. Mix the Fill and Line colors perfectly using the sharp inner feather
    float fillMix = 1.0 - smoothstep(-innerFeather, innerFeather, signedDist);
    
    // 3. Explicitly use a black stroke for unselected arrows, and the Cyan color for selected
    // Drop the opacity of the unselected black stroke to 50% so it feels less harsh
    vec4 finalStrokeColor = isSelected ? vArrowLine : vec4(0.0, 0.0, 0.0, vArrowFill.a * 0.5); 
    
    // Apply the final colors
    color = mix(finalStrokeColor, vArrowFill, fillMix);
    // Straight alpha: fade only the alpha for coverage, not the RGB
    color.a *= outerAlpha; 
  `
    };

    return shaders;
  }

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
        defaultValue: 0.5
      },
      instanceStemThicknesses: {
        size: 1,
        accessor: 'getStemThickness',
        defaultValue: 0.1
      },
      instanceHeadSizes: {
        size: 1,
        accessor: 'getHeadSize',
        defaultValue: 0.3
      },
      instanceLineWidths: {
        size: 1,
        accessor: 'getLineWidth',
        defaultValue: 1.5
      },
      instanceArrowFillColors: {
        size: 4,
        type: 'unorm8',
        accessor: 'getFillColor',
        defaultValue: [0, 0, 0, 255]
      },
      instanceArrowLineColors: {
        size: 4,
        type: 'unorm8',
        accessor: 'getLineColor',
        defaultValue: [0, 0, 0, 255]
      }
    });
  }
}

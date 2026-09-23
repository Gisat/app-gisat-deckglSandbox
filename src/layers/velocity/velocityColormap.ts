/**
 * Discrete velocity color ramp ported from
 * `app-damStabilityInspector/src/lib/symbologies/colormaps/velocityColormap.ts`
 * (and its `velocityColors` / `colorStops` / `colorRamp` dependencies).
 *
 * The ramp maps a velocity value (mm/yr) to an RGBA tuple using eleven classes
 * split by `VELOCITY_CLASS_BOUNDS`, with a single green near-zero class. The
 * descending-orbit palette is the ascending palette reversed.
 */

export type RgbaColor = [number, number, number, number];

/**
 * Velocity class colors, ordered from the lowest open-ended class (`< -5`,
 * dark red) through the near-zero green centre to the highest open-ended class
 * (`>= 5`, dark blue).
 */
const VELOCITY_CLASS_COLORS: readonly string[] = [
  '#B1001DFF',
  '#D3512CFF',
  '#F18831FF',
  '#FBC423FF',
  '#FFFF00FF',
  '#70E000FF',
  '#58D3F0FF',
  '#44ABDDFF',
  '#2D84C8FF',
  '#1960AAFF',
  '#003E8AFF'
];

/** Descending-orbit palette: the ascending palette reversed. */
const VELOCITY_DESCENDING_CLASS_COLORS: readonly string[] = [...VELOCITY_CLASS_COLORS].reverse();

/**
 * Velocity class boundaries (mm/year). The near-zero interval `[-1, 1)` is one
 * class rendered with a single green; `1` belongs to the first positive class.
 */
const VELOCITY_CLASS_BOUNDS: readonly number[] = [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5];

/** Fallback fill color used when a feature has no velocity value. */
export const DEFAULT_FEATURE_FILL_COLOR = '#A0A0A0A0';

/**
 * Converts a hex color string into the RGBA tuple expected by Deck.gl.
 *
 * Supports 6-digit `#RRGGBB` (alpha defaults to 255) and 8-digit `#RRGGBBAA`.
 *
 * @param color - Hex color.
 * @returns RGBA tuple, or [0, 0, 0, 0] when invalid.
 */
export const getRgbaColorFromHex = (color: string): RgbaColor => {
  const match8 = /^#([0-9a-f]{8})$/i.exec(color);
  if (match8) {
    const hex = match8[1];
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      Number.parseInt(hex.slice(6, 8), 16)
    ];
  }

  const match6 = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match6) {
    return [0, 0, 0, 0];
  }

  const hex = match6[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    255
  ];
};

const DEFAULT_FILL_RGBA = getRgbaColorFromHex(DEFAULT_FEATURE_FILL_COLOR);

/**
 * Creates a discrete color-ramp function from class boundaries and a palette.
 *
 * @param upperBounds - Ascending upper bounds of the closed classes.
 * @param classColors - Palette in class order, one entry longer than `upperBounds`.
 * @returns A pure function mapping a numeric value (or null) to an RGBA tuple.
 */
const createVelocityRamp = (upperBounds: readonly number[], classColors: readonly string[]) => {
  const stops = upperBounds.map((upperBound, index) => ({
    upperBound,
    rgba: getRgbaColorFromHex(classColors[index])
  }));
  const overflow = getRgbaColorFromHex(classColors[classColors.length - 1]);

  return (value: number | null): RgbaColor => {
    if (value === null || !Number.isFinite(value)) {
      return DEFAULT_FILL_RGBA;
    }
    for (const stop of stops) {
      if (value < stop.upperBound) {
        return stop.rgba;
      }
    }
    return overflow;
  };
};

/** Ascending-orbit velocity color ramp. */
export const VELOCITY_COLORMAP = createVelocityRamp(VELOCITY_CLASS_BOUNDS, VELOCITY_CLASS_COLORS);

/** Descending-orbit velocity color ramp. */
export const VELOCITY_DESCENDING_COLORMAP = createVelocityRamp(VELOCITY_CLASS_BOUNDS, VELOCITY_DESCENDING_CLASS_COLORS);

/** Fill color of the highest open-ended ascending class. */
export const VELOCITY_COLOR_OVERFLOW = VELOCITY_CLASS_COLORS[VELOCITY_CLASS_COLORS.length - 1];

/** Fill color of the highest open-ended descending class. */
export const VELOCITY_DESCENDING_COLOR_OVERFLOW =
  VELOCITY_DESCENDING_CLASS_COLORS[VELOCITY_DESCENDING_CLASS_COLORS.length - 1];

/** Default (no-data / non-dominant-orbit) fill color as an RGBA tuple. */
export const DEFAULT_FEATURE_FILL_RGBA = DEFAULT_FILL_RGBA;

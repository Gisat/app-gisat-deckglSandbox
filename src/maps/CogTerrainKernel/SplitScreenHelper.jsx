import { MapView } from '@deck.gl/core';

/**
 * Creates two side-by-side deck.gl MapViews with a configurable split position
 * @param {number} dividerPos - Position of divider as percentage (0-100)
 * @param {number} width - Total container width in pixels
 * @param {number} height - Total container height in pixels
 * @returns {Array<MapView>} Array of two MapView objects for deck.gl
 */
export function createSplitViews(dividerPos, width, height) {
  const leftWidth = (width * dividerPos) / 100;
  const rightWidth = width - leftWidth;

  return [
    new MapView({
      id: 'left',
      x: 0,
      y: 0,
      width: leftWidth,
      height: height,
      clear: true,
    }),
    new MapView({
      id: 'right',
      x: leftWidth,
      y: 0,
      width: rightWidth,
      height: height,
      clear: true,
    }),
  ];
}

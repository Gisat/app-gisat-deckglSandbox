import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { PolygonLayer } from '@deck.gl/layers';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { compute3dVelocitySizeZoomScale } from '../../layers/velocity/velocityZoom';

const RING_VERTEX_COUNT = 32;
const RING_LINE_WIDTH_METERS = 1;
const RING_LINE_WIDTH_MIN_PIXELS = 2;
const SHAPE_RING_RADIUS_METERS = 3;
const ARROW_RING_RADIUS_METERS = 10.5;
const METERS_PER_DEGREE_LAT = 110540;

const metersOffsetToDegrees = (lat, eastMeters, northMeters) => {
  const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((lat * Math.PI) / 180);
  return [eastMeters / metersPerDegreeLon, northMeters / METERS_PER_DEGREE_LAT];
};

const buildCircleRingPolygon = (lon, lat, z, radiusMeters) => {
  const polygon = [];
  for (let index = 0; index < RING_VERTEX_COUNT; index++) {
    const angle = (index / RING_VERTEX_COUNT) * 2 * Math.PI;
    const [lonOffset, latOffset] = metersOffsetToDegrees(
      lat,
      radiusMeters * Math.cos(angle),
      radiusMeters * Math.sin(angle),
    );
    polygon.push([lon + lonOffset, lat + latOffset, z]);
  }
  return polygon;
};

/**
 * Builds the cyan selection ring around one selected InSAR point.
 *
 * `kind` matches the rendered symbol: `'arrow'` uses a radius large enough to
 * enclose the fixed 3D LOS arrow from its anchor; `'shape'` uses the smaller
 * sphere/cube/cone ring. `centerOffsetMeters` is the symbol's half-height above
 * the anchor, so the horizontal ring sits at the symbol's vertical centre. The
 * radius is scaled by the same floor-only 3D zoom band as the symbols.
 */
export const buildSelectionRingLayer = ({
  id,
  feature,
  getAnchorPosition,
  zoom,
  kind = 'shape',
  centerOffsetMeters = 0,
  useTerrainOffset = false,
  color = [66, 212, 244, 255],
}) => {
  const [longitude, latitude, baseHeight] = getAnchorPosition(feature);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;

  const baseRadius = kind === 'arrow'
    ? ARROW_RING_RADIUS_METERS
    : SHAPE_RING_RADIUS_METERS;
  const radiusMeters = baseRadius * compute3dVelocitySizeZoomScale(zoom);
  // Raise the horizontal ring from the anchor to the symbol's vertical centre.
  const z = (Number.isFinite(baseHeight) ? baseHeight : 0) + centerOffsetMeters;

  return new PolygonLayer({
    id,
    data: [buildCircleRingPolygon(longitude, latitude, z, radiusMeters)],
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    pickable: false,
    stroked: true,
    filled: false,
    lineWidthUnits: 'meters',
    lineWidthMinPixels: RING_LINE_WIDTH_MIN_PIXELS,
    getPolygon: (polygon) => polygon,
    getLineWidth: () => RING_LINE_WIDTH_METERS,
    getLineColor: () => color,
    ...(useTerrainOffset
      ? { extensions: [new TerrainExtension()], terrainDrawMode: 'offset' }
      : {}),
  });
};

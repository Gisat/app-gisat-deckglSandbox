import {MVTLayer} from '@deck.gl/geo-layers';
import type {Accessor, Color} from '@deck.gl/core';
import chroma from 'chroma-js';
import DynamicArrowLayer from '../DynamicArrowLayer';

export interface BuildDeckGLLayerWithSymbologyProps<DataT = any> {
  id: string;
  data: string;
  minZoom?: number;
  maxZoom?: number;
  visible?: boolean;
  pickable?: boolean;
  autoHighlight?: boolean;
  highlightColor?: Color;
  getLineWidth?: Accessor<DataT, number>;
  getLineColor?: Accessor<DataT, Color>;
  radiusUnits?: 'meters' | 'common' | 'pixels';
  getFillColor?: Accessor<DataT, Color>;
  getAngle?: Accessor<DataT, number>;
  getStemLength?: Accessor<DataT, number>;
  getStemThickness?: Accessor<DataT, number>;
  getHeadSize?: Accessor<DataT, number>;
  getRadius?: Accessor<DataT, number>;
  updateTriggers?: Record<string, unknown[]>;
}

type Feature = {geometry: {coordinates: number[]}; properties: Record<string, any>};

const colorScale = chroma
  .scale([
    '#b1001d',
    '#ca2d2f',
    '#e25b40',
    '#ffaa00',
    '#ffff00',
    '#a0f000',
    '#4ce600',
    '#50d48e',
    '#00c3ff',
    '#0f80d1',
    '#004ca8',
    '#003e8a'
  ])
  .domain([-5, 5]);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalize = (
  value: number,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number
) => {
  if (!Number.isFinite(value)) {
    return rangeMin;
  }
  const t = clamp((value - domainMin) / (domainMax - domainMin), 0, 1);
  return rangeMin + t * (rangeMax - rangeMin);
};

const getFeatureColor = (f: Feature): Color => [
  ...colorScale(f.properties.vel_avg ?? 0).rgb(),
  255
];

const getIconAngle = (f: Feature): number => {
  const azAng = Number(f.properties.az_ang);
  if (Number.isFinite(azAng)) {
    return 180 + azAng;
  }
  const isDesc = f.properties.orbit === 'D';
  return (Number(f.properties.vel_avg) || 0) < 0 ? (isDesc ? 280 : 80) : (isDesc ? 100 : 260);
};

const getIconSizeFromAttribute = (value: number | null | undefined): number =>
  normalize(Math.abs(value ?? 0), 0, 30, 10, 40);

/**
 * Zoom-adaptive radius units: below the threshold the size is in geographic meters
 * (screen size grows/shrinks with zoom), at/above it the size is in pixels (fixed screen size).
 */
export const getRadiusUnits = (zoom: number, threshold: number = 14): 'meters' | 'pixels' =>
  zoom >= threshold ? 'pixels' : 'meters';

const buildDeckGLLayerWithSymbology = <DataT = any>({
  id,
  data,
  minZoom = 0,
  maxZoom = 14,
  visible = true,
  pickable = true,
  autoHighlight = true,
  highlightColor = [255, 255, 0, 255],
  getLineWidth = 2,
  getLineColor = [0, 0, 0, 255],
  radiusUnits = 'pixels',
  getFillColor,
  getAngle,
  getStemLength,
  getStemThickness,
  getHeadSize,
  getRadius,
  updateTriggers
}: BuildDeckGLLayerWithSymbologyProps<DataT>) => {
  return new MVTLayer({
    id,
    data,
    binary: false,
    minZoom,
    maxZoom,
    visible,
    pickable,
    autoHighlight,
    highlightColor,
    updateTriggers,
    renderSubLayers: (props: any) => {
      if (!props.data) {
        return null;
      }

      return new DynamicArrowLayer({
        ...props,
        id: `${props.id}-arrows`,
        getPosition: (f: Feature) => f.geometry.coordinates,
        getFillColor: getFillColor ?? getFeatureColor,
        getAngle: getAngle ?? getIconAngle,
        getStemLength:
          getStemLength ??
          ((f: Feature) => normalize(Math.abs(f.properties.vel_rel ?? 0), 0, 10, 0.2, 0.8)),
        getStemThickness:
          getStemThickness ??
          ((f: Feature) => normalize(f.properties.rel_len ?? 0, 0.4, 1, 0.05, 0.2)),
        getHeadSize:
          getHeadSize ??
          ((f: Feature) => normalize(f.properties.coh ?? 0, 0.4, 1, 0.15, 0.3)),
        getRadius: getRadius ?? ((f: Feature) => getIconSizeFromAttribute(f.properties.vel_last)),
        radiusUnits,
        pickable,
        autoHighlight,
        highlightColor,
        stroked: true,
        getLineWidth,
        getLineColor,
        updateTriggers
      });
    }
  });
};

export default buildDeckGLLayerWithSymbology;

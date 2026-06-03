import React, { useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { TileLayer, MVTLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, IconLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import chroma from 'chroma-js';

const INITIAL_VIEW_STATE = {
  longitude: 14.015511800867504,
  latitude: 50.571906640192161,
  zoom: 13,
  pitch: 20,
  bearing: 0,
};

const colorScale = chroma
  .scale([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
  .domain([-5, 5]);

const baseCircleSvg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
    <svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
        <circle cx="64" cy="64" r="58.5" fill="#ffffff" />
    </svg>
`);

const shadingOverlaySvg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`
    <svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <radialGradient id="mainHighlight" cx="35%" cy="30%" r="55%" fx="25%" fy="25%">
                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.7"/>
                <stop offset="80%" stop-color="#ffffff" stop-opacity="0"/>
            </radialGradient>
            
            <radialGradient id="edgeShadow" cx="50%" cy="50%" r="50%">
                <stop offset="75%" stop-color="#222222" stop-opacity="0"/>
                <stop offset="100%" stop-color="#222222" stop-opacity="0.3"/>
            </radialGradient>

            <radialGradient id="bounceLight" cx="75%" cy="75%" r="40%">
                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.2"/>
                <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
            </radialGradient>
        </defs>
        
        <circle cx="64" cy="64" r="60" fill="url(#edgeShadow)" />
        <circle cx="64" cy="64" r="60" fill="url(#bounceLight)" />
        <circle cx="64" cy="64" r="60" fill="url(#mainHighlight)" />
    </svg>
`);

const sphereGeometry = new SphereGeometry();

// Helper: create icon sublayers (base + shading)
const createIconSublayers = (props, getPosition) => {
  if (!props.data) return null;
  return [
    new IconLayer({
      ...props,
      id: `${props.id}-baseIcon`,
      iconAtlas: baseCircleSvg,
      iconMapping: {
        marker: {
          x: 0,
          y: 0,
          width: 128,
          height: 128,
          anchorX: 64,
          anchorY: 64,
          mask: true,
        },
      },
      getIcon: () => 'marker',
      getPosition,
      getSize: 20,
      getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
      billboard: true,
      depthTest: true,
      sizeMinPixels: 12,
      sizeMaxPixels: 40,
    }),
    new IconLayer({
      ...props,
      id: `${props.id}-shadingIcon`,
      iconAtlas: shadingOverlaySvg,
      iconMapping: {
        marker: {
          x: 0,
          y: 0,
          width: 128,
          height: 128,
          anchorX: 64,
          anchorY: 64,
          mask: false,
        },
      },
      getIcon: () => 'marker',
      getPosition,
      getSize: 20,
      billboard: true,
      depthTest: true,
      sizeMinPixels: 12,
      sizeMaxPixels: 40,
    }),
  ];
};

// Helper: create latlon sphere sublayer with LNGLAT coordinate system
const createLatlonSphereSublayer = (props) => {
  if (!props.data) return null;
  const { modelMatrix, coordinateOrigin, _offset, ...safeProps } = props;
  return new SimpleMeshLayer({
    ...safeProps,
    id: `${props.id}-spheres`,
    mesh: sphereGeometry,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    extensions: [],
    getPosition: (d) => [d.properties.lon, d.properties.lat, d.properties.h_dtm || 0],
    getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
    sizeScale: 8,
  });
};

// Layer configuration
const LAYER_CONFIGS = [
  {
    id: 'mvt-2d-points-ds',
    name: '2D MVT points (data service)',
    type: 'mvt-points',
    source: 'ds',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    visible: false,
  },
  {
    id: 'mvt-2d-points-s3',
    name: '2D MVT points (s3)',
    type: 'mvt-points',
    source: 's3',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3_latlon/{z}/{x}/{y}.pbf',
    visible: false,
  },
  {
    id: 'mesh-3d-spheres-s3',
    name: '3D json spheres (s3)',
    type: 'mesh-spheres-simple',
    source: 's3',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3.json',
    visible: false,
  },
  {
    id: 'mvt-3d-icons-ds',
    name: '3D MVT icons (data service)',
    type: 'mvt-icons',
    source: 'ds',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    visible: false,
  },
  {
    id: 'mvt-3d-icons-s3',
    name: '3D MVT icons (s3)',
    type: 'mvt-icons',
    source: 's3',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3_latlon/{z}/{x}/{y}.pbf',
    visible: true,
  },
  {
    id: 'mvt-3d-spheres-ds',
    name: '3D MVT spheres (data service)',
    type: 'mvt-spheres',
    source: 'ds',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    visible: false,
  },
  {
    id: 'mvt-3d-latlon-spheres-ds',
    name: '3D MVT latlon spheres (data service)',
    type: 'mvt-latlon-spheres',
    source: 'ds',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height-latlon/{z}/{x}/{y}',
    visible: false,
  },
  {
    id: 'mvt-3d-latlon-spheres-s3',
    name: '3D MVT latlon spheres (s3)',
    type: 'mvt-latlon-spheres',
    source: 's3',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3_latlon/{z}/{x}/{y}.pbf',
    visible: false,
  },
];

// Create layer from config
const createLayer = (config, visible) => {
  const baseProps = {
    id: config.id,
    data: config.data,
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible,
  };

  if (config.type === 'mvt-points') {
    return new MVTLayer({
      ...baseProps,
      getFillColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
      pointRadiusMinPixels: 4,
      getLineWidth: 1,
    });
  }

  if (config.type === 'mesh-spheres-simple') {
    return new SimpleMeshLayer({
      ...baseProps,
      mesh: sphereGeometry,
      sizeScale: 5,
      getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
      getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
    });
  }

  if (config.type === 'mvt-icons') {
    const getPosition = (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm];

    return new MVTLayer({
      ...baseProps,
      pickable: true,
      onClick: (info) => {
        if (info.picked) {
          console.log(`Clicked on ${config.id}:`, info);
        }
      },
      renderSubLayers: (props) => createIconSublayers(props, getPosition),
    });
  }

  if (config.type === 'mvt-spheres') {
    return new MVTLayer({
      ...baseProps,
      renderSubLayers: (props) => {
        if (props.data) {
          return new SimpleMeshLayer({
            ...props,
            id: `${props.id}-spheres`,
            mesh: sphereGeometry,
            getScale: [0.005, 0.005, 5],
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
          });
        }
        return null;
      },
    });
  }

  if (config.type === 'mvt-latlon-spheres') {
    return new MVTLayer({
      ...baseProps,
      renderSubLayers: (props) => createLatlonSphereSublayer(props),
    });
  }

  return null;
};

export default function GisatDataService() {
  const [layerVisibility, setLayerVisibility] = useState(() => {
    const initial = {};
    LAYER_CONFIGS.forEach((config) => {
      initial[config.id] = config.visible;
    });
    return initial;
  });

  const toggleLayer = (layerId) => {
    setLayerVisibility((prev) => ({
      ...prev,
      [layerId]: !prev[layerId],
    }));
  };

  const baseMapLayer = new TileLayer({
    id: 'tile-layer',
    data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: (props) => {
      const { west, south, east, north } = props.tile.bbox;
      return new BitmapLayer(props, {
        data: null,
        image: props.data,
        bounds: [west, south, east, north],
      });
    },
  });

  const dataLayers = LAYER_CONFIGS.map((config) =>
    createLayer(config, layerVisibility[config.id])
  );
  const layers = [baseMapLayer, ...dataLayers];

  return (
    <>
      <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 10, background: 'rgba(255, 255, 255, 0.95)', padding: '11px', borderRadius: '8px', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)', fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#333', width: '260px' }}>
        {LAYER_CONFIGS.map((config) => (
          <label key={config.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: config === LAYER_CONFIGS[0] ? '0 0 8px 0' : '8px 0 0 0', fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={layerVisibility[config.id]}
              onChange={() => toggleLayer(config.id)}
            />
            <span>{config.name}</span>
          </label>
        ))}
      </div>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        pickingRadius={20}
        className="deckgl-map"
      />
    </>
  );
}

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

export default function LargeVectorData() {
  const [mvtVisible, setMvtVisible] = useState(false);
  const [meshVisible, setMeshVisible] = useState(false);
  const [iconsVisible, setIconsVisible] = useState(false);
  const [mvtSpheresVisible, setMvtSpheresVisible] = useState(false);
  const [mvtLatlonSpheresVisible, setMvtLatlonSpheresVisible] = useState(true);

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

  const pointsLayer = new MVTLayer({
    id: '2d-mvt-points',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible: mvtVisible,
    getFillColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
    pointRadiusMinPixels: 4,
    getLineWidth: 1
  });

  const sphereMeshLayer = new SimpleMeshLayer({
    id: '3d-json-spheres',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_ASC_upd3_psd_los_4326_height_mesh_v3.json',
    mesh: sphereGeometry,
    sizeScale: 5,
    getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
    getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
    visible: meshVisible,
  });

  const iconsLayer = new MVTLayer({
    id: '3d-mvt-icons',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible: iconsVisible,
    renderSubLayers: (props) => {
      if (props.data) {
        return [
          new IconLayer({
            ...props,
            id: `${props.id}-baseIcon`,
            iconAtlas: baseCircleSvg,
            iconMapping: { marker: { x: 0, y: 0, width: 128, height: 128, mask: true } },
            getIcon: () => 'marker',
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            getSize: 20,
            getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
            billboard: true,
          }),
          new IconLayer({
            ...props,
            id: `${props.id}-shadingIcon`,
            iconAtlas: shadingOverlaySvg,
            iconMapping: { marker: { x: 0, y: 0, width: 128, height: 128, mask: false } },
            getIcon: () => 'marker',
            getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
            getSize: 20,
            billboard: true,
          }),
        ];
      }
      return null;
    },
  });

  const mvtSpheresLayer = new MVTLayer({
    id: '3d-mvt-spheres',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height/{z}/{x}/{y}',
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible: mvtSpheresVisible,
    renderSubLayers: (props) => {
      if (props.data) {
        return new SimpleMeshLayer({
          ...props,
          id: `${props.id}-spheres`,
          mesh: sphereGeometry,
          getScale: [0.005,0.005,5],
          getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.h_dtm],
          getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],
        });
      }
      return null;
    },
  });

 const mvtLatlonSpheresLayer = new MVTLayer({
    id: '3d-mvt-latlon-spheres',
    data: 'https://pantherdocs-dev.gisat.cz/be-gisdata/query/mvt-attributes/insar-points-d8-asc-height-latlon/{z}/{x}/{y}',
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible: mvtLatlonSpheresVisible,
    renderSubLayers: (props) => {
      if (props.data) {
        const { 
          modelMatrix, 
          coordinateOrigin, 
          _offset, 
          ...safeProps 
        } = props;
        return new SimpleMeshLayer({
          ...safeProps,
          id: `${props.id}-spheres`,
          mesh: new SphereGeometry(),
          coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
          extensions: [], 
          getPosition: (d) => [d.properties.lon, d.properties.lat, d.properties.h_dtm || 0],
          getColor: (d) => [...colorScale(d.properties.vel_rel || 0).rgb(), 255],  
          sizeScale: 8, 
        });
      }
      return null;
    },
  });

  const layers = [baseMapLayer, pointsLayer, sphereMeshLayer, iconsLayer, mvtSpheresLayer, mvtLatlonSpheresLayer];

  return (
    <>
      <div style={{ position: 'absolute', top: '10px', left: '10px', zIndex: 10, backgroundColor: '#f0f0f0', padding: '10px', borderRadius: '4px', boxShadow: '0 0 0 2px rgba(0,0,0,0.1)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px 0', fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={mvtVisible}
            onChange={(e) => setMvtVisible(e.target.checked)}
          />
          <span>2D MVT points</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: 0, fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={meshVisible}
            onChange={(e) => setMeshVisible(e.target.checked)}
          />
          <span>3D json spheres</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0 0 0', fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={iconsVisible}
            onChange={(e) => setIconsVisible(e.target.checked)}
          />
          <span>3D MVT icons</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0 0 0', fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={mvtSpheresVisible}
            onChange={(e) => setMvtSpheresVisible(e.target.checked)}
          />
          <span>3D MVT spheres</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0 0 0', fontSize: '14px' }}>
          <input
            type="checkbox"
            checked={mvtLatlonSpheresVisible}
            onChange={(e) => setMvtLatlonSpheresVisible(e.target.checked)}
          />
          <span>3D MVT latlon spheres</span>
        </label>
      </div>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        className="deckgl-map"
      />
    </>
  );
}

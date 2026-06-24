import { useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { TileLayer, MVTLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import chroma from 'chroma-js';

const INITIAL_VIEW_STATE = {
  longitude: 14.437713740781064,
  latitude: 50.05105178409062,
  zoom: 13,
  pitch: 40,
  bearing: 0,
};

const colorScale = chroma
  .scale([[65, 182, 196], [254, 254, 191], [215, 25, 28]])
  .domain([-5, 5]);

const sphereGeometry = new SphereGeometry();

const createLatlonSphereSublayer = (props, selectedPoint) => {
  if (!props.data) return null;
  const { modelMatrix, coordinateOrigin, _offset, ...safeProps } = props;
  return new SimpleMeshLayer({
    ...safeProps,
    id: `${props.id}-spheres`,
    mesh: sphereGeometry,
    coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
    extensions: [],
    getPosition: (d) => [d.properties.lon, d.properties.lat, d.properties.h_dtm || 0],
    getColor: (d) => {
      const isSelected =
        selectedPoint &&
        selectedPoint.properties &&
        d.properties.lon === selectedPoint.properties.lon &&
        d.properties.lat === selectedPoint.properties.lat;

      if (isSelected) {
        return [0, 255, 255, 255];
      }
      return [...colorScale(d.properties.vel_rel || 0).rgb(), 255];
    },
    sizeScale: 8,
    updateTriggers: {
      getColor: selectedPoint,
    },
  });
};

const LAYER_CONFIGS = [
  {
    id: 'dem-terrain',
    name: 'DEM Terrain',
    type: 'dem',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-esa3DFlusMetroD/dev/rasters/dtm1m_4326_cog_nodata.tif',
    visible: true,
  },
  {
    id: 'mvt-3d-latlon-spheres',
    name: '3D MVT latlon spheres',
    type: 'mvt-latlon-spheres',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-esa3DFlusMetroD/dev/vectors/insarPointsTiled/{z}/{x}/{y}.pbf',
    visible: true,
  },
];

const createLayer = (config, visible, selectedPoint, setSelectedPoint, extraProps = {}) => {
  const baseProps = {
    id: config.id,
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible,
  };

  if (config.type === 'dem') {
    return new CogTerrainLayer({
      ...baseProps,
      elevationData: config.data,
      isTiled: true,
      useChannel: null,
      tileSize: 256,
      meshMaxError: 1,
      operation: 'terrain+draw',
      terrainOptions: {
        type: 'terrain',
        noDataValue: 0,
        multiplier: 1,
        terrainSkirtHeight: 1,
      },
      ...extraProps,
    });
  }

  if (config.type === 'mvt-latlon-spheres') {
    return new MVTLayer({
      ...baseProps,
      data: config.data,
      pickable: true,
      zRange: extraProps.zRange,
      onClick: ({ object }) => {
        if (!setSelectedPoint) return;

        const isCurrentlySelected =
          selectedPoint && object &&
          selectedPoint.properties.lon === object.properties.lon &&
          selectedPoint.properties.lat === object.properties.lat;

        if (isCurrentlySelected) {
          setSelectedPoint(null);
        } else {
          setSelectedPoint(object);
        }
      },
      renderSubLayers: (props) => createLatlonSphereSublayer(props, selectedPoint),
      updateTriggers: {
        renderSubLayers: selectedPoint,
      },
    });
  }

  return null;
};

export default function Insar3DDEM() {
  const [layerVisibility, setLayerVisibility] = useState(() => {
    const initial = {};
    LAYER_CONFIGS.forEach((config) => {
      initial[config.id] = config.visible;
    });
    return initial;
  });
  const [selectedPoint, setSelectedPoint] = useState(null);
  const { zRange, onZRangeUpdate } = useTerrainZRange();

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
    zRange: zRange,
    extensions: [new TerrainExtension()],
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
    createLayer(config, layerVisibility[config.id], selectedPoint, setSelectedPoint, {
      ...(config.type === 'dem' ? { onZRangeUpdate } : {}),
      zRange,
    })
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

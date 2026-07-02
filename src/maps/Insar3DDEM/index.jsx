import { useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { TileLayer, MVTLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { COORDINATE_SYSTEM, FlyToInterpolator } from '@deck.gl/core';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { CogTerrainLayer, CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import chroma from 'chroma-js';

const INITIAL_VIEW_STATE = {
  longitude: 14.437713740781064,
  latitude: 50.05105178409062,
  zoom: 13,
  pitch: 0,
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
    id: 'tile-layer',
    name: 'Tile Layer',
    type: 'tile',
    data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    visible: true,
  },
  {
    id: 'relief-glaze',
    name: 'Glaze Overlay',
    type: 'glaze',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-esa3DFlusMetroD/dev/rasters/dtm1m_4326_cog_nodata.tif',
    visible: false,
  },
  {
    id: 'dem-terrain',
    name: 'DEM',
    type: 'dem',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-esa3DFlusMetroD/dev/rasters/dtm1m_4326_cog_nodata.tif',
    visible: true,
  },
  {
    id: 'insar-points',
    name: 'InSAR Points',
    type: 'insar',
    data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-esa3DFlusMetroD/dev/vectors/insarPointsTiled/{z}/{x}/{y}.pbf',
    visible: true,
  },
];

const RENDER_ORDER = ['dem-terrain', 'tile-layer', 'relief-glaze', 'insar-points'];

const createLayer = (config, visible, isDemOn, selectedPoint, setSelectedPoint, extraProps = {}) => {
  const baseProps = {
    id: config.id,
    binary: false,
    minZoom: 0,
    maxZoom: 14,
    visible,
  };

  if (config.type === 'dem') {
    if (!visible) return null;
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
        disableLighting: true,
        noDataValue: 0,
        multiplier: 1,
        terrainSkirtHeight: 1,
      },
      ...extraProps,
    });
  }

  if (config.type === 'tile') {
    return new TileLayer({
      ...baseProps,
      id: isDemOn ? config.id : `${config.id}-flat`,
      data: config.data,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      zRange: extraProps.zRange,
      extensions: isDemOn ? [new TerrainExtension()] : [],
      renderSubLayers: (props) => {
        const { west, south, east, north } = props.tile.bbox;
        return new BitmapLayer(props, {
          data: null,
          image: props.data,
          bounds: [west, south, east, north],
        });
      },
    });
  }

  if (config.type === 'glaze') {
    return new CogBitmapLayer({
      ...baseProps,
      id: isDemOn ? config.id : `${config.id}-flat`,
      rasterData: config.data,
      isTiled: true,
      tileSize: 256,
      clampToTerrain: isDemOn,
      extensions: isDemOn ? [new TerrainExtension()] : [],
      zRange: extraProps.zRange,
      cogBitmapOptions: {
        type: 'image',
        useReliefGlaze: true,
        noDataValue: 0,
        useChannel: 1,
        swissSlopeWeight: 0.3,
        zFactor: 10,
        maxGlazeAlpha: 50,
      },
    });
  }

  if (config.type === 'insar') {
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
  const [mode, setMode] = useState('2d');
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

  const toggleLayer = (layerId) => {
    setLayerVisibility((prev) => ({
      ...prev,
      [layerId]: !prev[layerId],
    }));
  };

  const toggleMode = () => {
    if (mode === '2d') {
      setMode('3d');
      setViewState({
        ...viewState,
        pitch: 40,
        transitionDuration: 1000,
        transitionInterpolator: new FlyToInterpolator(),
      });
    } else {
      setMode('2d');
      setViewState((prev) => ({
        ...prev,
        pitch: 0,
        bearing: 0,
        transitionDuration: 1000,
        transitionInterpolator: new FlyToInterpolator(),
      }));
    }
  };

  const handleViewStateChange = ({ viewState: vs, interactionState }) => {
    if (interactionState?.inTransition) {
      setViewState(vs);
      return;
    }

    const constrained = { ...vs };
    if (mode === '2d') {
      constrained.pitch = 0;
      constrained.bearing = 0;
    } else if (constrained.pitch > 60) {
      constrained.pitch = 60;
    }
    setViewState(constrained);
  };

  const isDemOn = layerVisibility['dem-terrain'];

  const layers = RENDER_ORDER
    .map(id => LAYER_CONFIGS.find(c => c.id === id))
    .filter(Boolean)
    .map(config => createLayer(
      config,
      layerVisibility[config.id],
      isDemOn,
      selectedPoint,
      setSelectedPoint,
      config.type === 'dem'
        ? { onZRangeUpdate, zRange }
        : { zRange: isDemOn ? zRange : null }
    ))
    .filter(Boolean);

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
        <div style={{ borderTop: '1px solid #ddd', margin: '8px 0 0 0', padding: '8px 0 0 0' }}>
          <button
            onClick={toggleMode}
            style={{ width: '100%', padding: '8px', backgroundColor: mode === '3d' ? '#4CAF50' : '#555', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: '500' }}
          >
            {mode === '2d' ? 'Switch to 3D' : 'Switch to 2D'}
          </button>
        </div>
      </div>
      <DeckGL
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        controller={true}
        layers={layers}
        pickingRadius={20}
        className="deckgl-map"
      />
    </>
  );
}

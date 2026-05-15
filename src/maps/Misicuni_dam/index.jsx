import { useState, useCallback, useMemo, useEffect } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CogTerrainLayer, CogTiles } from '@gisatcz/deckgl-geolib';
import { MaskExtension } from '@deck.gl/extensions';
import { SphereGeometry, CubeGeometry } from '@luma.gl/engine';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';
const MULTIBAND_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/test/Misicuni_100_10x10_intermediate_cog.tif';

const VECTOR_POINT_DATA = [  
  {
    id: 'mesh-layer-dam',
    name: 'GDA-AID-WR IADB',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni-dam_v1_elev_mesh.json',
    color: [255, 100, 0],
    useVelReUpColor: true,
    useVelRelColor: false,
    scale: 10,
    propertyName: 'VEL_RE_UP',
  },
  {
    id: 'mesh-layer-003a',
    name: 'WLT-LOS-003A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-003A_v1.0_20240601_elev_selected_mesh_v2.json',
    color: [0, 150, 200],
    useVelRelColor: true,
  },
  {
    id: 'mesh-layer-076a',
    name: 'WLT-LOS-076A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-076A_v1_elev_selected_mesh.json',
    color: [150, 255, 0],
    useVelRelColor: true,
  },
  {
    id: 'mesh-layer-156d',
    name: 'WLT-LOS-156D',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-156D_v1.0_20240601_elev_selected_mesh.json',
    color: [0, 255, 255],
    useVelRelColor: true,
  },
  {
    id: 'mesh-layer-geodetic-points',
    name: 'Geodetic Points',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/geodetic_points_elev_4326_mesh.json',
    color: [80, 80, 80],
    useVelRelColor: false,
    geometryType: 'cube',
    scale: 4.5,
  },
  {
    id: 'mesh-layer-geodetic-red',
    name: 'Geodetic Red MGD PRM',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/point_geodetic_red_mgd_prm_4326_elev_mesh.json',
    color: [130, 100, 70],
    useVelRelColor: false,
    geometryType: 'cube',
    scale: 4.5,
  },
];

const INITIAL_VIEW_STATE = {
  longitude: -66.3,
  latitude: -17.12,
  zoom: 12,
  pitch: 40,
  bearing: 90,
  minZoom: 11,
  maxZoom: 13.8,
  maxPitch: 50
};

// Velocity color scale: subsidence (red) to uplift (blue)
// Used for both VEL_REL (horizontal) and VEL_RE_UP (vertical) components
const VELOCITY_COLOR_SCALE = [
  { range: [-100, -5], color: [139, 0, 0], label: '< -5 (Subsidence)' },
  { range: [-5, -4], color: [205, 51, 51], label: '-5 - -4' },
  { range: [-4, -3], color: [220, 100, 80], label: '-4 - -3' },
  { range: [-3, -2], color: [240, 150, 120], label: '-3 - -2' },
  { range: [-2, -1], color: [255, 200, 150], label: '-2 - -1' },
  { range: [-1, 0], color: [255, 250, 200], label: '-1 - 0' },
  { range: [0, 1], color: [200, 250, 150], label: '0 - 1' },
  { range: [1, 2], color: [150, 255, 100], label: '1 - 2' },
  { range: [2, 3], color: [100, 255, 100], label: '2 - 3' },
  { range: [3, 4], color: [50, 200, 150], label: '3 - 4' },
  { range: [4, 5], color: [30, 150, 200], label: '4 - 5' },
  { range: [5, 100], color: [0, 100, 200], label: '> 5 (Uplift)' },
];



function getColorForVelRel(value) {
  for (const entry of VELOCITY_COLOR_SCALE) {
    if (value >= entry.range[0] && value <= entry.range[1]) {
      return entry.color;
    }
  }
  return [128, 128, 128];
}

function getColorForVelReUp(value) {
  for (const entry of VELOCITY_COLOR_SCALE) {
    if (value >= entry.range[0] && value <= entry.range[1]) {
      return entry.color;
    }
  }
  return [128, 128, 128];
}


function getScaleForVelRel(value) {
  const absValue = Math.abs(value);
  // Base scale of 4, increases with absolute magnitude
  const scale = 4 + (absValue * 0);
  return [scale, scale, scale];
}

function getScaleForVelReUp(value) {
  const absValue = Math.abs(value);
  // Direct scaling: larger absolute values = larger spheres
  // scale = 5 + (0.5 * |VEL_RE_UP|)
  const scale = 5 + (0.5 * absValue);
  return [scale, scale, scale];
}

function getElevationAtInfo(info) {
  const tileResult = info.tile?.content?.[0];
  if (!tileResult?.raw) return null;
  const { raw, width, height } = tileResult;

  let u, v;
  if (info.uv) {
    [u, v] = info.uv;
  } else if (info.coordinate && info.tile?._bbox) {
    const { west, south, east, north } = info.tile._bbox;
    u = (info.coordinate[0] - west) / (east - west);
    v = (north - info.coordinate[1]) / (north - south);
  }
  if (u === undefined || v === undefined) return null;

  const x = Math.min(width - 1, Math.max(0, Math.floor(u * (width - 1))));
  const y = Math.min(height - 1, Math.max(0, Math.floor(v * (height - 1))));
  return raw[y * width + x];
}

function formatDate(dateString) {
  if (!dateString) return '';
  const str = String(dateString).trim();
  
  // Handle YYYYMMDD format (e.g., "20170101")
  if (/^\d{8}$/.test(str)) {
    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    const day = str.substring(6, 8);
    return `${year}-${month}-${day}`;
  }
  
  // Try standard date parsing as fallback
  const date = new Date(str);
  if (!isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  
  return str;
}

function MisicuniDam() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [cogInstance, setCogInstance] = useState(null);
  const [currentBandIndex, setCurrentBandIndex] = useState(0);
  const [isFetched, setIsFetched] = useState(false);
  const [layerVisibility, setLayerVisibility] = useState(
    Object.fromEntries(VECTOR_POINT_DATA.map(layer => [layer.id, layer.id === 'mesh-layer-dam']))
  );
  const [showLegend, setShowLegend] = useState(false);
  
  const totalBands = cogInstance?.getNumChannels?.() || 30;
  const bandDescriptions = cogInstance?.getBandDescriptions?.() ?? [];
  const currentDescription = formatDate(bandDescriptions[currentBandIndex]) || '';

  // Initialize the CogTiles instance to read metadata
  useEffect(() => {
    if (!cogInstance) {
      const cog = new CogTiles({
        type: 'terrain',
        terrainSkirtHeight: 0,
        useChannel: 1,
        useSingleColor: true,
        color: [0, 105, 148, 180],
        cacheAllBands: false,
      });
      
      cog.initializeCog(MULTIBAND_COG_URL).then(() => {
        setCogInstance(cog);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const layers = useMemo(() => {
    const maskLayer = new GeoJsonLayer({
      id: 'water-mask',
      data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/misicuni_max_mask.geojson',
      operation: 'mask',
      maskInverted: true,
      pickable: false,
    });

    const backgroundDem = new CogTerrainLayer({
      id: 'dem-cog-layer',
      elevationData: DEM_COG_URL,
      isTiled: true,
      tileSize: 256,
      terrainOptions: {
        type: 'terrain',
        useSwissRelief: true,
        useHeatMap: true,
        useChannel: 1,
        colorScale: ["#016656", "#80cdc1", "#f5f5f4", "#dfc27d", "#b9823c"],
        colorScaleValueRange: [3500, 4054],
        // colorScaleValueRange: [3600, 4100],
      },
      pickable: false,
    });

    const multibandDem = new CogTerrainLayer({
      id: 'cog-multiband-layer',
      elevationData: MULTIBAND_COG_URL,
      isTiled: true,
      tileSize: 256,
      cogTiles: cogInstance || undefined,
      terrainOptions: {
        type: 'terrain',
        terrainSkirtHeight: 0,
        useChannel: currentBandIndex + 1,
        useSingleColor: true,
        color: [0, 105, 148, 180],
        cacheAllBands: isFetched,
      },
      pickable: true,
      extensions: [new MaskExtension()],
      maskId: 'water-mask',
      updateTriggers: {
        getTileData: [currentBandIndex, isFetched]
      }
    });

    const meshLayers = VECTOR_POINT_DATA
      .filter(config => layerVisibility[config.id])
      .map(config => new SimpleMeshLayer({
        id: config.id,
        data: config.url,
        mesh: config.geometryType === 'cube' ? new CubeGeometry() : new SphereGeometry(),
        getPosition: (d) => [d.geometry.coordinates[0], d.geometry.coordinates[1], d.properties.elev_1+10],
        getColor: (d) => {
          if (config.useVelReUpColor && d.properties.VEL_RE_UP !== undefined) {
            const color = getColorForVelReUp(d.properties.VEL_RE_UP);
            return [...color, 255];
          }
          if (config.useVelRelColor && d.properties.VEL_REL !== undefined) {
            const color = getColorForVelRel(d.properties.VEL_REL);
            return [...color, 255];
          }
          return [...config.color, 255];
        },
        getScale: (d) => {
          if (config.useVelReUpColor && d.properties.VEL_RE_UP !== undefined) {
            return getScaleForVelReUp(d.properties.VEL_RE_UP);
          }
          if (config.useVelRelColor && d.properties.VEL_REL !== undefined) {
            return getScaleForVelRel(d.properties.VEL_REL);
          }
          const baseScale = config.scale ?? 10;
          return [baseScale, baseScale, baseScale];
        },
        pickable: true,
        updateTriggers: {
          getColor: [config.useVelRelColor, config.useVelReUpColor],
          getScale: [config.useVelRelColor, config.useVelReUpColor]
        }
      }));

    return [maskLayer, backgroundDem, ...meshLayers, multibandDem];
  }, [currentBandIndex, cogInstance, isFetched, layerVisibility]);

  const getTooltip = useCallback((info) => {
    const elevation = getElevationAtInfo(info);
    if (elevation === null) return null;
    return { text: `Elevation: ${elevation.toFixed(1)} m` };
  }, []);

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState }) => setViewState(viewState)}
        controller={true}
        layers={layers}
        getCursor={() => 'crosshair'}
          getTooltip={getTooltip}
        views={new MapView({ repeat: true })}
      />

      {/* Control Panel */}
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 20,
          background: 'rgba(255, 255, 255, 0.95)',
          padding: '12px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '14px',
          color: '#333',
          width: '220px',
          zIndex: 1000,
        }}
      >
        {/* Layer Visibility - Checkboxes FIRST */}
        <div style={{ marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #ddd' }}>
          {VECTOR_POINT_DATA.map((layer) => (
            <div key={layer.id} style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id={layer.id}
                checked={layerVisibility[layer.id]}
                onChange={(e) => setLayerVisibility(prev => ({ ...prev, [layer.id]: e.target.checked }))}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor={layer.id} style={{ cursor: 'pointer', fontSize: '12px', flex: 1, userSelect: 'none' }}>
                {layer.name}
              </label>
            </div>
          ))}
        </div>

        {/* Band Selection Slider - SECOND */}
        <div style={{ marginBottom: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>
              Dam Water Level
            </div>
            <button
              onClick={() => setIsFetched(true)}
              disabled={isFetched}
              style={{
                padding: '4px 8px',
                cursor: isFetched ? 'default' : 'pointer',
                backgroundColor: isFetched ? '#e0e0e0' : '#4CAF50',
                color: isFetched ? '#999' : 'white',
                border: 'none',
                borderRadius: '3px',
                fontWeight: 'normal',
                fontSize: '10px',
              }}
            >
              {isFetched ? '✅ Ready' : '⬇️ Load data'}
            </button>
          </div>
          {currentDescription && (
            <div style={{ marginBottom: '8px', fontSize: '13px', fontWeight: '500', color: '#555' }}>
              Date: {currentDescription} ({currentBandIndex + 1}/{totalBands})
            </div>
          )}
          <input
            type="range"
            min={0}
            max={totalBands - 1}
            value={currentBandIndex}
            disabled={!isFetched}
            onMouseUp={(e) => setCurrentBandIndex(parseInt(e.currentTarget.value, 10))}
            onTouchEnd={(e) => setCurrentBandIndex(parseInt(e.currentTarget.value, 10))}
            onChange={(e) => setCurrentBandIndex(parseInt(e.currentTarget.value, 10))}
            style={{ width: '100%', cursor: isFetched ? 'pointer' : 'not-allowed', opacity: isFetched ? 1 : 0.5 }}
          />
        </div>

        {/* Velocity Color Legend - THIRD */}
        <div style={{ marginBottom: '0px', paddingTop: '8px', borderTop: '1px solid #ddd' }}>
          <button
            onClick={() => setShowLegend(!showLegend)}
            style={{
              width: '100%',
              padding: '6px 8px',
              marginBottom: showLegend ? '8px' : '0',
              backgroundColor: showLegend ? '#f0f0f0' : '#fff',
              border: '1px solid #ddd',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: '500',
              textAlign: 'left',
              color: '#333',
            }}
          >
            {showLegend ? '▼ Velocity legend' : '▶ Velocity legend'}
          </button>
          {showLegend && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {VELOCITY_COLOR_SCALE.map((entry, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px' }}>
                  <span 
                    style={{ 
                      display: 'inline-block', 
                      width: '12px', 
                      height: '12px', 
                      backgroundColor: `rgb(${entry.color.join(',')})`, 
                      borderRadius: '1px',
                      border: '1px solid #999',
                      flexShrink: 0
                    }}
                  ></span>
                  <span style={{ whiteSpace: 'nowrap' }}>{entry.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MisicuniDam;
import { useState, useCallback, useMemo, useEffect } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CogTerrainLayer, CogTiles } from '@gisatcz/deckgl-geolib';
import { MaskExtension } from '@deck.gl/extensions';
import { SphereGeometry } from '@luma.gl/engine';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';
const MULTIBAND_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/test/Misicuni_30_10x10_intermediate_cog.tif';

const INSAR_POINTS = [
  {
    id: 'mesh-layer-dam',
    name: 'GDA-AID-WR IADB',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni-dam_v1.0_mesh.json',
    color: [255, 100, 0],
  },
  {
    id: 'mesh-layer-003a',
    name: 'WLT-LOS-003A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-003A_v1.0_20240601_mesh.json',
    color: [0, 150, 200],
  },
  {
    id: 'mesh-layer-076a',
    name: 'WLT-LOS-076A',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-076A_v1.0_20240601_mesh.json',
    color: [150, 255, 0],
  },
  {
    id: 'mesh-layer-156d',
    name: 'WLT-LOS-156D',
    url: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/GISAT_GDA-AID-WR_IADB_001_Misicuni_Small_WLT-LOS-156D_v1.0_20240601_mesh.json',
    color: [0, 255, 255],
  },
];

const INITIAL_VIEW_STATE = {
  longitude: -66.30,
  latitude: -17.09,
  zoom: 12,
  pitch: 40,
  bearing: 0,
  minZoom: 11,
  maxZoom: 13.5,
  maxPitch: 60
};

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
    Object.fromEntries(INSAR_POINTS.map(layer => [layer.id, true]))
  );
  
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
        colorScale: [
          [0, 60, 48], [1, 102, 94], [90, 180, 172],
          [128, 205, 193], [245, 245, 245], [223, 194, 125],
          [166, 97, 26], [140, 81, 10], [84, 48, 5],
        ],
        colorScaleValueRange: [2500, 5000],
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

    const meshLayers = INSAR_POINTS
      .filter(config => layerVisibility[config.id])
      .map(config => new SimpleMeshLayer({
        id: config.id,
        data: config.url,
        mesh: new SphereGeometry(),
        getPosition: (d) => {
          const lon = d.properties.LON ?? d.geometry?.coordinates?.[0];
          const lat = d.properties.LAT ?? d.geometry?.coordinates?.[1];
          const h = d.properties.H ?? 0;
          return [lon, lat, h];
        },
        getColor: [...config.color, 255],
        getScale: [10, 10, 10],
        pickable: true,
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

      {/* Band Selection Control Panel */}
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          left: 20,
          background: 'rgba(255, 255, 255, 0.95)',
          padding: '16px',
          borderRadius: '8px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          fontFamily: 'system-ui, sans-serif',
          fontSize: '14px',
          color: '#333',
          width: '280px',
          zIndex: 1000,
        }}
      >
        <div style={{ marginBottom: '16px', fontWeight: 'bold', fontSize: '16px' }}>
          Band Selection
        </div>

        <div style={{ marginBottom: '12px' }}>
          <div style={{ marginBottom: '8px', fontSize: '13px', fontWeight: '500' }}>
            Band: {currentBandIndex + 1} / {totalBands}
            {currentDescription && (
              <span style={{ marginLeft: '8px', color: '#555', fontWeight: 'normal' }}>
                — {currentDescription}
              </span>
            )}
          </div>
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

        <button
          onClick={() => setIsFetched(true)}
          disabled={isFetched}
          style={{
            width: '100%',
            padding: '8px',
            cursor: isFetched ? 'default' : 'pointer',
            backgroundColor: isFetched ? '#e0e0e0' : '#4CAF50',
            color: isFetched ? '#999' : 'white',
            border: 'none',
            borderRadius: '4px',
            fontWeight: '500',
          }}
        >
          {isFetched ? '✅ All Bands Cached' : '⬇️ Fetch All Bands'}
        </button>
        
        <div style={{ fontSize: '12px', color: '#666', marginTop: '10px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #ddd' }}>
          {!isFetched ? 'Click "Fetch All Bands" to enable band selection.' : 'Use the slider to select bands!'}
        </div>

        {/* InSAR Points Layer Visibility */}
        <div style={{ marginBottom: '16px' }}>
          <div style={{ marginBottom: '8px', fontWeight: 'bold', fontSize: '14px' }}>
            InSAR Points
          </div>
          {INSAR_POINTS.map((layer) => (
            <div key={layer.id} style={{ marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="checkbox"
                id={layer.id}
                checked={layerVisibility[layer.id]}
                onChange={(e) => setLayerVisibility(prev => ({ ...prev, [layer.id]: e.target.checked }))}
                style={{ cursor: 'pointer', width: '16px', height: '16px' }}
              />
              <label htmlFor={layer.id} style={{ cursor: 'pointer', fontSize: '12px', flex: 1, userSelect: 'none', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ display: 'inline-block', width: '12px', height: '12px', backgroundColor: `rgb(${layer.color.join(',')})`, borderRadius: '2px' }}></span>
                {layer.name}
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default MisicuniDam;
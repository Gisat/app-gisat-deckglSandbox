// Adapted from deck.gl-geotiff CogTerrainKernelExample
import { useState, useEffect, useMemo, useCallback } from 'react';
import { DeckGL, TileLayer, BitmapLayer } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { CogTerrainLayer, CogTiles, CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const INITIAL_VIEW_STATE = {
  longitude: -66.33,
  latitude: -17.09,
  zoom: 12,
  pitch: 40,
  bearing: 0,
  minZoom: 8,
  maxZoom: 13.5,
  maxPitch: 60
};
const MODES = [
  { key: 'elevation', label: 'Elevation' },
  { key: 'slope', label: 'Slope' },
  { key: 'hillshade', label: 'Hillshade' },
  { key: 'elevation-swiss', label: 'Shaded Elevation (Swiss Relief)' },
  { key: 'satellite-clamped', label: 'Satellite (Clamped to Terrain)' },
  { key: 'satellite-glaze', label: 'Satellite with Relief Glaze' },
];

const MODE_OPTIONS = {
  elevation: {
    useSwissRelief: false,
    useHeatMap: true,
    colorScale: [
      [0, 60, 48],    // #003c30 (2500)
      [1, 102, 94],   // #01665e (3100)
      [90, 180, 172], // #5ab4ac (3730)
      [128, 205, 193],// #80cdc1 (3755)
      [245, 245, 245],// #f5f5f5 (3780)
      [223, 194, 125],// #dfc27d (3805)
      [166, 97, 26],  // #a6611a (3830)
      [140, 81, 10],  // #8c510a (4410)
      [84, 48, 5],    // #543005 (5000)
    ],
    colorScaleValueRange: [2500, 5000],
    // colorScaleValueRange: [2500, 3100, 3730, 3755, 3780, 3805, 3830, 4410, 5000],
  },
  'elevation-swiss': {
    useSwissRelief: true,
    useHeatMap: true,
    colorScale: [
      [0, 60, 48],    // #003c30 (2500)
      [1, 102, 94],   // #01665e (3100)
      [90, 180, 172], // #5ab4ac (3730)
      [128, 205, 193],// #80cdc1 (3755)
      [245, 245, 245],// #f5f5f5 (3780)
      [223, 194, 125],// #dfc27d (3805)
      [166, 97, 26],  // #a6611a (3830)
      [140, 81, 10],  // #8c510a (4410)
      [84, 48, 5],    // #543005 (5000)
    ],
    colorScaleValueRange: [2500, 5000],
  },
  slope: {
    useSlope: true,
    useHeatMap: true,
    colorScale: [
      [255, 255, 255], [235, 200, 150], [200, 80, 50], [100, 40, 30],
    ],
    colorScaleValueRange: [0, 90],
  },
  hillshade: {
    useHillshade: true,
    useHeatMap: true,
    colorScale: [
      [52, 38, 35], [255, 250, 245],
    ],
    colorScaleValueRange: [0, 255],
    hillshadeAzimuth: 315,
    hillshadeAltitude: 45,
  },
  'satellite-clamped': {
    // No terrain texture - satellite will be draped via separate layer
    useSingleColor: true,
    color: [200, 200, 200, 255],
  },
  'satellite-glaze': {
    // For glaze mode: render terrain mesh only (no texture)
    disableLighting: true,
    useSingleColor: true,
    color: [200, 200, 200, 255],
  },
};

function buildTerrainOptions(mode) {
  return {
    type: 'terrain',
    useChannel: 1,
    noDataValue: 0,
    ...MODE_OPTIONS[mode],
  };
}

function getElevationAtInfo(info){
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

function getDerivedAtInfo(info){
  const tileResult = info.tile?.content?.[0];
  if (!tileResult?.rawDerived) return null;
  const { rawDerived } = tileResult;
  const width = 256;
  const height = 256;

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
  return rawDerived[y * width + x];
}

function CogTerrainKernel() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [mode, setMode] = useState('elevation');
  const [cogState, setCogState] = useState({ cog: null, mode: 'elevation' });

  // Initialize CogTiles ONCE on mount
  useEffect(() => {
    const cogInstance = new CogTiles(buildTerrainOptions('elevation'));
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      setCogState({ cog: cogInstance, mode: 'elevation' });
    });
  }, []);

  // Reinitialize CogTiles when mode changes (needed for kernel computation)
  useEffect(() => {
    if (!cogState.cog || mode === cogState.mode) return;
    
    const newCog = new CogTiles(buildTerrainOptions(mode));
    newCog.initializeCog(DEM_COG_URL).then(() => {
      setCogState({ cog: newCog, mode });
    });
  }, [mode, cogState.cog, cogState.mode]);

  const layers = useMemo(() => {
    if (!cogState.cog) return [];

    const terrainLayers = [
      new CogTerrainLayer({
        id: 'cog-terrain-kernel',
        elevationData: DEM_COG_URL,
        cogTiles: cogState.cog,
        isTiled: true,
        tileSize: 256,
        operation: cogState.mode === 'satellite-glaze' ? 'terrain' : 'terrain+draw',
        terrainOptions: buildTerrainOptions(cogState.mode),
        pickable: cogState.mode !== 'satellite-clamped' && cogState.mode !== 'satellite-glaze',
      }),
    ];

    // Add satellite base layer for satellite modes
    if (cogState.mode === 'satellite-clamped' || cogState.mode === 'satellite-glaze') {
      terrainLayers.push(
        new TileLayer({
          data: SATELLITE_TILE_URL,
          id: 'satellite-base',
          minZoom: 0,
          maxZoom: 19,
          tileSize: 256,
          extensions: [new TerrainExtension()],
          /* eslint-disable react/prop-types */
          renderSubLayers: (props) => {
            const { bbox } = props.tile;
            const { west, south, east, north } = bbox;
            return new BitmapLayer(props, {
              data: undefined,
              image: props.data,
              bounds: [west, south, east, north],
            });
          },
          /* eslint-enable react/prop-types */
        })
      );
    }

    // Add relief glaze overlay for glaze mode
    if (cogState.mode === 'satellite-glaze') {
      terrainLayers.push(
        new CogBitmapLayer({
          id: 'relief-glaze-overlay',
          rasterData: DEM_COG_URL,
          isTiled: true,
          tileSize: 256,
          clampToTerrain: true,
          extensions: [new TerrainExtension()],
          cogBitmapOptions: {
            type: 'image',
            useReliefGlaze: true,
            noDataValue: 0,
            useChannel: 1,
            swissSlopeWeight: 0.3,
            zFactor: 20,
            maxGlazeAlpha: 130,
          },
        })
      );
    }

    return terrainLayers;
  }, [cogState]);

  const isTransitioning = cogState.mode !== mode;

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <div style={{ position: 'absolute', zIndex: 1, left: 10, top: 10 }}>
        {MODES.map(m => (
          <button key={m.key} onClick={() => setMode(m.key)} disabled={mode === m.key || isTransitioning}>
            {m.label}
          </button>
        ))}
      </div>
      <DeckGL
          getCursor={() => 'crosshair'}
          viewState={viewState}
          onViewStateChange={({ viewState }) => setViewState(viewState)}
          controller={true}
          layers={layers}
          views={new MapView({ 
            repeat: true,
            minZoom: 2,
            maxZoom: 2,
            maxPitch: 60
          })}
          getTooltip={useCallback((info) => {
            const elevation = getElevationAtInfo(info);
            const derived = getDerivedAtInfo(info);
            if (elevation === null) return null;
            const lines = [`Elevation: ${elevation.toFixed(1)} m`];
            if (derived !== null) {
              if (cogState.mode === 'slope') lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
              if (cogState.mode === 'hillshade') lines.push(`Hillshade: ${derived.toFixed(0)}`);
            }
            return { text: lines.join('\n') };
          }, [cogState.mode])}
      />
    </div>
  );
}

export default CogTerrainKernel;

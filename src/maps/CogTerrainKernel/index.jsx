// Adapted from deck.gl-geotiff CogTerrainKernelExample
import React, { useState, useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { BitmapLayer } from '@deck.gl/layers';
import { TileLayer } from '@deck.gl/geo-layers';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_terrain/DEM_COP30_float32_wgs84_deflate_cog_float32.tif';
const INITIAL_VIEW_STATE = {
  longitude: 86,
  latitude: 28,
  zoom: 8,
  pitch: 40,
  bearing: 0,
};
const MODES = [
  { key: 'elevation', label: 'Elevation' },
  { key: 'slope', label: 'Slope' },
  { key: 'hillshade', label: 'Hillshade' },
];

const MODE_OPTIONS = {
  elevation: {
    useHeatMap: true,
    colorScale: [
      [75, 120, 90], [100, 145, 100], [130, 170, 110], [185, 210, 145],
      [235, 235, 185], [225, 195, 160], [195, 160, 130], [170, 155, 150],
      [245, 245, 240], [255, 255, 255],
    ],
    colorScaleValueRange: [1000, 6500],
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

import { CogTiles } from '@gisatcz/deckgl-geolib';

function CogTerrainKernel() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [mode, setMode] = useState('elevation');
  const [cogState, setCogState] = useState({ cog: null, mode: 'elevation' });
  const [isTransitioning, setIsTransitioning] = useState(false);

  // Initial load
  React.useEffect(() => {
    let mounted = true;
    const cog = new CogTiles(buildTerrainOptions(mode));
    cog.initializeCog(DEM_COG_URL).then(() => {
      if (mounted) setCogState({ cog, mode });
    });
    return () => { mounted = false; };
  }, []);

  // Mode change
  React.useEffect(() => {
    if (!cogState.cog || cogState.mode === mode) return;
    setIsTransitioning(true);
    const cog = new CogTiles(buildTerrainOptions(mode));
    cog.initializeCog(DEM_COG_URL).then(() => {
      setCogState({ cog, mode });
      setIsTransitioning(false);
    });
  }, [mode]);

  const layers = useMemo(() => {
    if (!cogState.cog) return [];
    return [
      new TileLayer({
        id: 'osm',
        data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,
        pickable: false,
        renderSubLayers: (props) => {
          const { bbox } = props.tile;
          const { west, south, east, north } = bbox;
          return new BitmapLayer(props, {
            data: undefined,
            image: props.data,
            bounds: [west, south, east, north],
          });
        },
      }),
      new CogTerrainLayer({
        id: 'cog-terrain-kernel',
        elevationData: DEM_COG_URL,
        cogTiles: cogState.cog,
        isTiled: true,
        tileSize: 256,
        operation: 'terrain+draw',
        terrainOptions: buildTerrainOptions(cogState.mode),
        pickable: true,
      }),
    ];
  }, [viewState, cogState]);

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
          views={new MapView({ repeat: true })}
          getTooltip={(info) => {
            const elevation = getElevationAtInfo(info);
            const derived = getDerivedAtInfo(info);
            if (elevation === null) return null;
            // const displayMode = cogState?.mode ?? mode;
            const lines = [`Elevation: ${elevation.toFixed(1)} m`];
if (derived !== null) {
  if (mode === 'slope') lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
  if (mode === 'hillshade') lines.push(`Hillshade: ${derived.toFixed(0)}`);
}
            // lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
            // if (derived !== null) {
            //   if (displayMode === 'slope') lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
              // if (displayMode === 'hillshade') lines.push(`Hillshade: ${derived.toFixed(0)}`);
            // }
            return { text: lines.join('\n') };
          }}

      />
    </div>
  );
}

export default CogTerrainKernel;

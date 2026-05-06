// Adapted from deck.gl-geotiff CogTerrainKernelExample
import { useState, useEffect, useMemo, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { GeoJsonLayer } from '@deck.gl/layers';

import { CogTerrainLayer, CogTiles } from '@gisatcz/deckgl-geolib';
import { MaskExtension } from '@deck.gl/extensions';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_UTM19N_geodetic_points_CL_MS_MR_GST_merge_update_cog_bilinear.tif';
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

function MisicuniDam() {
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [cog, setCog] = useState(null);

  // Initialize CogTiles ONCE on mount
  useEffect(() => {
    const cogInstance = new CogTiles({
      type: 'terrain',
      useChannel: 1,
      noDataValue: 0,
      useSwissRelief: true,
      meshMaxError: 10,
      useHeatMap: true,
      colorScale: [
        [0, 60, 48],
        [1, 102, 94],
        [90, 180, 172],
        [128, 205, 193],
        [245, 245, 245],
        [223, 194, 125],
        [166, 97, 26],
        [140, 81, 10],
        [84, 48, 5],
      ],
      colorScaleValueRange: [2500, 5000],
    });
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      setCog(cogInstance);
    });
  }, []);



  const layers = useMemo(() => {
    if (!cog) return [];

    // The "Stencil" - defines the high-res shape of the water
    const maskLayer = new GeoJsonLayer({
      id: 'water-mask',
      data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/misicuni_max_mask.geojson',
      operation: 'mask',
      maskInverted: true,
    });

    return [
      maskLayer,
      new CogTerrainLayer({
        id: 'cog-terrain-kernel',
        elevationData: DEM_COG_URL,
        cogTiles: cog,
        isTiled: true,
        tileSize: 256,
        operation: 'terrain+draw',
        terrainOptions: {
          type: 'terrain',
          useChannel: 1,
          noDataValue: 0,
          useSwissRelief: true,
          meshMaxError: 10,
          useHeatMap: true,
          colorScale: [
            [0, 60, 48],
            [1, 102, 94],
            [90, 180, 172],
            [128, 205, 193],
            [245, 245, 245],
            [223, 194, 125],
            [166, 97, 26],
            [140, 81, 10],
            [84, 48, 5],
          ],
          colorScaleValueRange: [2500, 5000],
        },

        pickable: true,
      }),
      new CogTerrainLayer({
        id: 'cog-terrain-kernel-dam-surface',
        elevationData: "https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/test/Misicuni_30_10x10_intermediate_cog.tif",
        isTiled: true,
        tileSize: 256,
        extensions: [new MaskExtension()],
        maskId: 'water-mask',
        operation: 'terrain+draw',
        terrainOptions: {
          type: 'terrain',
          terrainSkirtHeight: 0,
          useChannel: 1,
          meshMaxError: 650,
          useSingleColor: true,
          color: [0, 105, 148, 180],
        },
        pickable: true,
      }),
    ];
  }, [cog]);


  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>

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
            if (elevation === null) return null;
            return { text: `Elevation: ${elevation.toFixed(1)} m` };
          }, [])}
      />
    </div>
  );
}

export default MisicuniDam;

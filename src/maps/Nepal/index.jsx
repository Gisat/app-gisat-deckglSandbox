import { useMemo } from 'react';
import { DeckGL } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { CogTerrainLayer, CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_terrain/DEM_COP30_float32_wgs84_deflate_cog_float32.tif';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

const INITIAL_VIEW_STATE = {
  longitude: 85.547,
  latitude: 28.104,
  zoom: 11,
  pitch: 50,
  bearing: 0,
  minZoom: 4,
  maxZoom: 13,
  maxPitch: 70,
};

function NepalMap() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();

  const layers = useMemo(() => [
    new CogTerrainLayer({
      id: 'nepal-terrain',
      elevationData: DEM_COG_URL,
      isTiled: true,
      tileSize: 256,
      operation: 'terrain',
      terrainOptions: {
        type: 'terrain',
        useChannel: 1,
        noDataValue: 0,
        disableLighting: true,
        useSingleColor: true,
        color: [200, 200, 200, 255],
      },
      onZRangeUpdate,
    }),
    new TileLayer({
      data: SATELLITE_TILE_URL,
      id: 'satellite-base',
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      zRange,
      extensions: [new TerrainExtension()],
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
        zFactor: 10,
        maxGlazeAlpha: 80,
      },
    }),
  ], [zRange, onZRangeUpdate]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        deviceProps={{ waitForPageLoad: false }}
      />
    </div>
  );
}

export default NepalMap;

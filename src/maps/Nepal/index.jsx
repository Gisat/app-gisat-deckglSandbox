import { useEffect, useMemo, useState } from 'react';
import { DeckGL } from 'deck.gl';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { CogTerrainLayer, CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';

const sphereGeometry = new SphereGeometry();

const DEM_COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/deck.gl-geotiff/examples/dataSources/cog_terrain/DEM_COP30_float32_wgs84_deflate_cog_float32.tif';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const INSAR_URLS = {
  asc: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/nepal_insar_asc.geojson',
  dsc: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/nepal_insar_dsc.geojson',
};

// vel range (mm/yr) → color, half-open [low, high) except last which is inclusive.
// Alpha = 0.85 × 255 ≈ 217; missing/null vel → #cccccc.
const VEL_COLOR_BANDS = [
  { min: -1000, max: -13, color: [177, 0, 29] },
  { min: -13, max: -10, color: [202, 45, 47] },
  { min: -10, max: -7, color: [226, 91, 64] },
  { min: -7, max: -5, color: [255, 170, 0] },
  { min: -5, max: -3, color: [255, 255, 0] },
  { min: -3, max: 3, color: [76, 230, 0] },
  { min: 3, max: 5, color: [80, 212, 142] },
  { min: 5, max: 7, color: [0, 195, 255] },
  { min: 7, max: 10, color: [15, 128, 209] },
  { min: 10, max: 13, color: [0, 76, 168] },
  { min: 13, max: 1000, color: [0, 62, 138] },
];

function getVelFillColor(vel) {
  if (vel == null || !Number.isFinite(Number(vel))) {
    return [204, 204, 204, 217];
  }
  const value = Number(vel);
  const last = VEL_COLOR_BANDS[VEL_COLOR_BANDS.length - 1];
  const band = VEL_COLOR_BANDS.find(b => value >= b.min && (b === last ? value <= b.max : value < b.max));
  return [...(band ? band.color : [204, 204, 204]), 217];
}

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

// Radius of the InSAR marker spheres, in meters
const SPHERE_RADIUS = 15;

function NepalMap() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();
  const [track, setTrack] = useState('asc');
  const [features, setFeatures] = useState([]);

  // SimpleMeshLayer needs a flat feature array (the GeoJSON is a FeatureCollection)
  useEffect(() => {
    let cancelled = false;
    setFeatures([]);
    fetch(INSAR_URLS[track])
      .then(res => res.json())
      .then(fc => {
        if (!cancelled) setFeatures(fc.features || []);
      })
      .catch(err => console.error(`Nepal InSAR ${track} load error:`, err));
    return () => {
      cancelled = true;
    };
  }, [track]);

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
    new SimpleMeshLayer({
      id: `insar-${track}`,
      data: features,
      mesh: sphereGeometry,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      // Anchor at lon/lat, z=0; TerrainExtension offset lifts the anchor onto the
      // COG terrain surface, then the translation raises the sphere to sit on it.
      getPosition: d => [d.properties.lon, d.properties.lat, 0],
      getTranslation: [0, 0, SPHERE_RADIUS],
      sizeScale: SPHERE_RADIUS,
      getColor: d => getVelFillColor(d.properties?.vel),
      pickable: true,
      extensions: [new TerrainExtension()],
      terrainDrawMode: 'offset',
    }),
  ], [zRange, onZRangeUpdate, track, features]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        deviceProps={{ waitForPageLoad: false }}
      />
      <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10, display: 'flex', gap: 4 }}>
        {Object.keys(INSAR_URLS).map(key => (
          <button
            key={key}
            onClick={() => setTrack(key)}
            disabled={track === key}
            style={{
              padding: '6px 10px',
              fontSize: '13px',
              fontFamily: 'system-ui, sans-serif',
              border: track === key ? '2px solid #0066cc' : '1px solid #ccc',
              borderRadius: '4px',
              background: track === key ? '#e6f0ff' : '#fff',
              color: '#333',
              fontWeight: track === key ? 600 : 400,
              cursor: track === key ? 'default' : 'pointer',
            }}
          >
            {key.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

export default NepalMap;

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

// Sentinel-2 SWIR RGB composites (pre/post GLOF)
const SWIR_LAYERS = [
  { key: 'swir2020', label: 'SWIR 2020 (pre-GLOF)', url: 'https://gisat-gis.eu-central-1.linodeobjects.com/esaGdaAdbNepal23/rasters/sentinel_cog/2020-10-29-00_00_2020-10-29-23_59_Sentinel-2_L1C_SWIR_cog_nodata.tif', cogBitmapOptions: { type: 'image', useChannel: null } },
  { key: 'swir2021', label: 'SWIR 2021 (post-GLOF)', url: 'https://gisat-gis.eu-central-1.linodeobjects.com/esaGdaAdbNepal23/rasters/sentinel_cog/2021-10-12-00_00_2021-10-12-23_59_Sentinel-2_L1C_SWIR_cog_nodata.tif', cogBitmapOptions: { type: 'image', useChannel: null } },
];

// Snow cover / wet snow: multi-channel COG (5 bands, 2017–2021). Values are day-of-year;
// channel 4 (2021) is used for now. Heatmap: continuous chroma ramp over days.
const SNOW_COG_BITMAP_OPTIONS = {
  type: 'image',
  useChannel: 4,
  useHeatMap: true,
  noDataValue: 0,
  blurredTexture: false,
  colorScale: ['#fde725', '#5dc962', '#20908d', '#3a528b', '#440154'],
  colorScaleValueRange: [1, 100, 200, 300, 366],
};

const SNOW_LAYERS = [
  { key: 'snow2021', label: 'Snow cover 2021', url: 'https://gisat-gis.eu-central-1.linodeobjects.com/esaGdaAdbNepal23/rasters/snow_cover_cog/SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif', cogBitmapOptions: SNOW_COG_BITMAP_OPTIONS },
  { key: 'wetsnow2021', label: 'Wet snow 2021', url: 'https://gisat-gis.eu-central-1.linodeobjects.com/esaGdaAdbNepal23/rasters/snow_cover_cog/WET_SNOW_3857_2017-2021_cog_deflate_in16_zoom16_levels8.tif', cogBitmapOptions: SNOW_COG_BITMAP_OPTIONS },
];

const SLOPE_COG_BITMAP_OPTIONS = {
  type: 'image',
  useChannel: 1,
  useHeatMap: true,
  noDataValue: -9999,
  colorScale: ['#ffffff', '#feff51', '#fd8c3b', '#ff0037'],
  colorScaleValueRange: [0, 45],
};

const ELEVATION_COG_BITMAP_OPTIONS = {
  type: 'image',
  useChannel: 1,
  useHeatMap: true,
  noDataValue: 0,
  colorScale: [
    '#00883f', '#109435', '#20a02a', '#31ac1f',
    '#92b118', '#fab014', '#c88723', '#ac692c',
    '#af5a2d', '#c8846c', '#ffffff',
  ],
  colorScaleValueRange: [900, 5800],
};

const TERRAIN_LAYERS = [
  { key: 'slope', label: 'Slope', url: 'https://gisat-gis.eu-central-1.linodeobjects.com/esaGdaAdbNepal23/rasters/copdem_cog/copdem_slope_cog_deflate_float32_levels8.tif', cogBitmapOptions: SLOPE_COG_BITMAP_OPTIONS },
  { key: 'elevation', label: 'Elevation', url: DEM_COG_URL, cogBitmapOptions: ELEVATION_COG_BITMAP_OPTIONS },
];

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
  const [visibility, setVisibility] = useState({
    asc: true,
    dsc: false,
    swir2020: false,
    swir2021: false,
    snow2021: false,
    wetsnow2021: false,
    slope: false,
    elevation: false,
  });
  const [featuresByTrack, setFeaturesByTrack] = useState({ asc: [], dsc: [] });

  // SimpleMeshLayer needs a flat feature array (the GeoJSON is a FeatureCollection)
  useEffect(() => {
    let cancelled = false;
    Object.keys(INSAR_URLS).forEach(track => {
      fetch(INSAR_URLS[track])
        .then(res => res.json())
        .then(fc => {
          if (!cancelled) {
            setFeaturesByTrack(prev => ({ ...prev, [track]: fc.features || [] }));
          }
        })
        .catch(err => console.error(`Nepal InSAR ${track} load error:`, err));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const layers = useMemo(() => {
    const insarLayers = Object.keys(INSAR_URLS).map(track => (
      new SimpleMeshLayer({
        id: `insar-${track}`,
        data: featuresByTrack[track],
        visible: visibility[track],
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
      })
    ));

    // Render in reverse of UI order so the first listed layer draws on top.
    const cogOverlayLayers = [...SWIR_LAYERS, ...SNOW_LAYERS, ...TERRAIN_LAYERS].reverse().map(layer => (
      new CogBitmapLayer({
        id: layer.key,
        rasterData: layer.url,
        visible: visibility[layer.key],
        isTiled: true,
        tileSize: 256,
        clampToTerrain: true,
        extensions: [new TerrainExtension()],
        // CogBitmapLayer does not forward zRange itself; push it into its inner
        // TileLayer so draped tiles are not frustum-culled in tilted 3D view.
        _subLayerProps: {
          tiles: { zRange },
        },
        cogBitmapOptions: layer.cogBitmapOptions,
      })
    ));

    return [
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
      // Imagery overlays (sentinels + snow) render under the relief glaze below
      ...cogOverlayLayers,
      new CogBitmapLayer({
        id: 'relief-glaze-overlay',
        rasterData: DEM_COG_URL,
        isTiled: true,
        tileSize: 256,
        clampToTerrain: true,
        extensions: [new TerrainExtension()],
        _subLayerProps: {
          tiles: { zRange },
        },
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
      ...insarLayers,
    ];
  }, [zRange, onZRangeUpdate, visibility, featuresByTrack]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={true}
        layers={layers}
        deviceProps={{ waitForPageLoad: false }}
      />
      <div style={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: 'rgba(255, 255, 255, 0.9)',
        padding: '8px 10px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '13px',
        color: '#333',
      }}>
        {Object.keys(INSAR_URLS).map(key => (
          <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={visibility[key]}
              onChange={(e) => setVisibility(prev => ({ ...prev, [key]: e.target.checked }))}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {key.toUpperCase()}
          </label>
        ))}
        <div style={{ height: 1, background: '#ddd', margin: '4px 0' }} />
        {SWIR_LAYERS.map(layer => (
          <label key={layer.key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={visibility[layer.key]}
              onChange={(e) => setVisibility(prev => ({ ...prev, [layer.key]: e.target.checked }))}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {layer.label}
          </label>
        ))}
        <div style={{ height: 1, background: '#ddd', margin: '4px 0' }} />
        {SNOW_LAYERS.map(layer => (
          <label key={layer.key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={visibility[layer.key]}
              onChange={(e) => setVisibility(prev => ({ ...prev, [layer.key]: e.target.checked }))}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {layer.label}
          </label>
        ))}
        <div style={{ height: 1, background: '#ddd', margin: '4px 0' }} />
        {TERRAIN_LAYERS.map(layer => (
          <label key={layer.key} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={visibility[layer.key]}
              onChange={(e) => setVisibility(prev => ({ ...prev, [layer.key]: e.target.checked }))}
              style={{ cursor: 'pointer', width: 15, height: 15 }}
            />
            {layer.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export default NepalMap;

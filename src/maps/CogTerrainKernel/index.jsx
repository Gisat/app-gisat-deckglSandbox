import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { DeckGL, TileLayer, BitmapLayer } from 'deck.gl';
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
  { key: 'elevation-swiss', label: 'Shaded Elevation' },
  { key: 'satellite-clamped', label: 'Satellite' },
  { key: 'satellite-glaze', label: 'Shaded Satellite' },
];

const MODE_OPTIONS = {
  elevation: {
    useSwissRelief: false,
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
  'elevation-swiss': {
    useSwissRelief: true,
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
    useSingleColor: true,
    color: [200, 200, 200, 255],
  },
  'satellite-glaze': {
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

function getDerivedAtInfo(info) {
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
  const [baseMode, setBaseMode] = useState('elevation');
  const [compareMode, setCompareMode] = useState('elevation-swiss');
  const [baseCogState, setBaseCogState] = useState({ cog: null, mode: 'elevation' });
  const [compareCogState, setCompareCogState] = useState({ cog: null, mode: 'elevation-swiss' });
  const [sliderPosition, setSliderPosition] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const containerRef = useRef(null);

  // Initialize base CogTiles
  useEffect(() => {
    const cogInstance = new CogTiles(buildTerrainOptions('elevation'));
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      setBaseCogState({ cog: cogInstance, mode: 'elevation' });
    }).catch(err => console.error('Base CogTiles init error:', err));
  }, []);

  // Initialize compare CogTiles
  useEffect(() => {
    const cogInstance = new CogTiles(buildTerrainOptions('elevation-swiss'));
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      setCompareCogState({ cog: cogInstance, mode: 'elevation-swiss' });
    }).catch(err => console.error('Compare CogTiles init error:', err));
  }, []);

  // Track container size for proper pixel-based positioning
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Update base CogTiles when mode changes
  useEffect(() => {
    if (!baseCogState.cog || baseMode === baseCogState.mode) return;
    const newCog = new CogTiles(buildTerrainOptions(baseMode));
    newCog.initializeCog(DEM_COG_URL).then(() => {
      setBaseCogState({ cog: newCog, mode: baseMode });
    }).catch(err => console.error('Base mode update error:', err));
  }, [baseMode, baseCogState.cog, baseCogState.mode]);

  // Update compare CogTiles when mode changes
  useEffect(() => {
    if (!compareCogState.cog || compareMode === compareCogState.mode) return;
    const newCog = new CogTiles(buildTerrainOptions(compareMode));
    newCog.initializeCog(DEM_COG_URL).then(() => {
      setCompareCogState({ cog: newCog, mode: compareMode });
    }).catch(err => console.error('Compare mode update error:', err));
  }, [compareMode, compareCogState.cog, compareCogState.mode]);

  // Create layers
  const baseLayers = useMemo(() => {
    if (!baseCogState.cog) return [];
    const terrainLayers = [new CogTerrainLayer({
      id: 'cog-terrain-base',
      elevationData: DEM_COG_URL,
      cogTiles: baseCogState.cog,
      isTiled: true,
      tileSize: 256,
      operation: baseCogState.mode === 'satellite-glaze' ? 'terrain' : 'terrain+draw',
      terrainOptions: buildTerrainOptions(baseCogState.mode),
      pickable: baseCogState.mode !== 'satellite-clamped' && baseCogState.mode !== 'satellite-glaze',
    })];

    // Add satellite base layer for satellite modes
    if (baseCogState.mode === 'satellite-clamped' || baseCogState.mode === 'satellite-glaze') {
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
    if (baseCogState.mode === 'satellite-glaze') {
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
  }, [baseCogState]);

  const compareLayers = useMemo(() => {
    if (!compareCogState.cog) return [];
    const terrainLayers = [new CogTerrainLayer({
      id: 'cog-terrain-compare',
      elevationData: DEM_COG_URL,
      cogTiles: compareCogState.cog,
      isTiled: true,
      tileSize: 256,
      operation: compareCogState.mode === 'satellite-glaze' ? 'terrain' : 'terrain+draw',
      terrainOptions: buildTerrainOptions(compareCogState.mode),
      pickable: compareCogState.mode !== 'satellite-clamped' && compareCogState.mode !== 'satellite-glaze',
    })];

    // Add satellite base layer for satellite modes
    if (compareCogState.mode === 'satellite-clamped' || compareCogState.mode === 'satellite-glaze') {
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
    if (compareCogState.mode === 'satellite-glaze') {
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
  }, [compareCogState]);

  const handleViewStateChange = useCallback(({ viewState: newViewState }) => {
    setViewState(newViewState);
  }, []);

  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newPosition = (e.clientX - rect.left) / rect.width;
      setSliderPosition(Math.max(0, Math.min(1, newPosition)));
    };
    const handleMouseUp = () => {
      setIsDragging(false);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const getTooltip = useCallback((info) => {
    const elevation = getElevationAtInfo(info);
    const derived = getDerivedAtInfo(info);
    if (elevation === null) return null;
    const lines = [`Elevation: ${elevation.toFixed(1)} m`];
    if (derived !== null) {
      const mode = info.object?.id?.includes('compare') ? compareCogState.mode : baseCogState.mode;
      if (mode === 'slope') lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
      if (mode === 'hillshade') lines.push(`Hillshade: ${derived.toFixed(0)}`);
    }
    return { text: lines.join('\n') };
  }, [baseCogState.mode, compareCogState.mode]);

  const baseIsTransitioning = baseCogState.mode !== baseMode;
  const compareIsTransitioning = compareCogState.mode !== compareMode;

  // Use pixel-based positioning for proper alignment
  const sliderPixels = sliderPosition * containerSize.width;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        userSelect: isDragging ? 'none' : 'auto',
      }}
    >
      {/* Base layer - always fully visible */}
      <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' }}>
        <DeckGL
          viewState={viewState}
          onViewStateChange={handleViewStateChange}
          controller={true}
          layers={baseLayers}
          getTooltip={getTooltip}
          getCursor={() => 'crosshair'}
          deviceProps={{ waitForPageLoad: false }}
        />
      </div>

      {/* Compare layer - clipped on the right side using pixel-based positioning */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: `${sliderPixels}px`,
          width: `${containerSize.width - sliderPixels}px`,
          height: '100%',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: `${-sliderPixels}px`,
            width: `${containerSize.width}px`,
            height: '100%',
          }}
        >
          <DeckGL
            viewState={viewState}
            onViewStateChange={handleViewStateChange}
            controller={false}
            layers={compareLayers}
            getTooltip={getTooltip}
            getCursor={() => 'crosshair'}
            deviceProps={{ waitForPageLoad: false }}
          />
        </div>
      </div>

      {/* Base layer controls */}
      <div style={{ position: 'absolute', zIndex: 10, top: 10, left: 10, pointerEvents: 'auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {MODES.map(m => (
            <button
              key={m.key}
              onClick={() => setBaseMode(m.key)}
              disabled={baseMode === m.key || baseIsTransitioning}
              style={{
                padding: '6px 10px',
                fontSize: 11,
                backgroundColor: baseMode === m.key ? '#2196F3' : '#666',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: baseMode === m.key || baseIsTransitioning ? 'default' : 'pointer',
                opacity: baseIsTransitioning ? 0.6 : 1,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Compare layer controls */}
      <div style={{ position: 'absolute', zIndex: 10, top: 10, right: 10, pointerEvents: 'auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'flex-end' }}>
          {MODES.map(m => (
            <button
              key={m.key}
              onClick={() => setCompareMode(m.key)}
              disabled={compareMode === m.key || compareIsTransitioning}
              style={{
                padding: '6px 10px',
                fontSize: 11,
                backgroundColor: compareMode === m.key ? '#2196F3' : '#666',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: compareMode === m.key || compareIsTransitioning ? 'default' : 'pointer',
                opacity: compareIsTransitioning ? 0.6 : 1,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Slider divider with indicator */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: 'absolute',
          left: `${sliderPixels}px`,
          top: '50%',
          transform: 'translate(-50%, -50%)',
          width: 60,
          height: 60,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'col-resize',
          userSelect: 'none',
          zIndex: 30,
          pointerEvents: 'auto',
        }}
      >
        {/* White vertical line */}
        <div
          style={{
            position: 'absolute',
            width: 4,
            height: '150vh',
            backgroundColor: '#fff',
            opacity: isDragging ? 1 : 0.8,
            boxShadow: '0 0 10px rgba(0, 0, 0, 0.6)',
            transition: isDragging ? 'none' : 'opacity 0.2s',
            pointerEvents: 'none',
          }}
        />
        {/* Circular indicator with arrows */}
        <div
          style={{
            position: 'absolute',
            width: 50,
            height: 50,
            borderRadius: '50%',
            backgroundColor: 'rgba(255, 255, 255, 0.2)',
            border: '2px solid rgba(255, 255, 255, 0.8)',
            boxShadow: '0 0 8px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            fontWeight: 'bold',
            color: 'rgba(255, 255, 255, 0.8)',
            pointerEvents: 'none',
          }}
        >
          ◀ ▶
        </div>
      </div>
    </div>
  );
}

export default CogTerrainKernel;

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import PropTypes from 'prop-types';
import { DeckGL } from 'deck.gl';
import { CogTerrainLayer, CogTiles } from '@gisatcz/deckgl-geolib';

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

const MODES = [
  { key: 'elevation', label: 'Elevation' },
  { key: 'slope', label: 'Slope' },
  { key: 'hillshade', label: 'Hillshade' },
  { key: 'elevation-swiss', label: 'Shaded Elevation' },
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

/**
 * MapPane — Independent DeckGL canvas, positioned absolutely
 * Each pane manages its own viewport and layer independently
 */
const MapPane = memo(function MapPane({ 
  mode, 
  cogState, 
  setMode, 
  viewState, 
  onViewStateChange, 
  isTransitioning, 
  side,
  splitRatio,
  containerWidth,
  containerHeight
}) {
  const layers = useMemo(() => {
    if (!cogState.cog) return [];
    
    return [
      new CogTerrainLayer({
        id: `cog-terrain-${side}`,
        elevationData: DEM_COG_URL,
        cogTiles: cogState.cog,
        isTiled: true,
        tileSize: 256,
        operation: 'terrain+draw',
        terrainOptions: buildTerrainOptions(cogState.mode),
        pickable: true,
      }),
    ];
  }, [cogState, side]);

  const getTooltip = useCallback((info) => {
    const elevation = getElevationAtInfo(info);
    const derived = getDerivedAtInfo(info);
    if (elevation === null) return null;
    const lines = [`Elevation: ${elevation.toFixed(1)} m`];
    if (derived !== null) {
      if (cogState.mode === 'slope') lines.push(`Slope: ${derived.toFixed(1)}\xB0`);
      if (cogState.mode === 'hillshade') lines.push(`Hillshade: ${derived.toFixed(0)}`);
    }
    return { text: lines.join('\n') };
  }, [cogState.mode]);

  const isLeft = side === 'left';
  const paneWidth = isLeft ? splitRatio * containerWidth : (1 - splitRatio) * containerWidth;
  const paneLeft = isLeft ? 0 : splitRatio * containerWidth + 4;

  return (
    <div 
      style={{ 
        position: 'absolute',
        top: 0,
        left: paneLeft,
        width: paneWidth,
        height: containerHeight,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <DeckGL
        viewState={viewState}
        onViewStateChange={onViewStateChange}
        controller={true}
        layers={layers}
        getTooltip={getTooltip}
        getCursor={() => 'crosshair'}
        deviceProps={{ waitForPageLoad: false }}
      />

      {/* Mode selection buttons for this pane only */}
      <div style={{ position: 'absolute', zIndex: 10, top: 10, left: 10, pointerEvents: 'auto' }}>
        <div style={{ fontSize: 12, fontWeight: 'bold', marginBottom: 8, color: '#fff', textShadow: '0 0 4px rgba(0,0,0,0.7)' }}>
          {isLeft ? 'Left Mode' : 'Right Mode'}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {MODES.map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              disabled={mode === m.key || isTransitioning}
              style={{
                padding: '6px 10px',
                fontSize: 11,
                backgroundColor: mode === m.key ? '#2196F3' : '#666',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                cursor: mode === m.key || isTransitioning ? 'default' : 'pointer',
                opacity: isTransitioning ? 0.6 : 1,
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.mode === nextProps.mode &&
    prevProps.cogState === nextProps.cogState &&
    prevProps.viewState === nextProps.viewState &&
    prevProps.isTransitioning === nextProps.isTransitioning &&
    prevProps.splitRatio === nextProps.splitRatio
  );
});

MapPane.propTypes = {
  mode: PropTypes.string.isRequired,
  cogState: PropTypes.shape({
    cog: PropTypes.object,
    mode: PropTypes.string,
  }).isRequired,
  setMode: PropTypes.func.isRequired,
  viewState: PropTypes.object.isRequired,
  onViewStateChange: PropTypes.func.isRequired,
  isTransitioning: PropTypes.bool.isRequired,
  side: PropTypes.string.isRequired,
  splitRatio: PropTypes.number.isRequired,
  containerWidth: PropTypes.number.isRequired,
  containerHeight: PropTypes.number.isRequired,
};

function CogTerrainKernel() {
  // Shared view state — both panes sync pan/zoom
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

  // Independent mode states per side
  const [leftMode, setLeftMode] = useState('elevation');
  const [rightMode, setRightMode] = useState('elevation-swiss');

  // CogTiles state per side
  const [leftCogState, setLeftCogState] = useState({ cog: null, mode: 'elevation' });
  const [rightCogState, setRightCogState] = useState({ cog: null, mode: 'elevation-swiss' });

  // Split ratio and dragging state
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef(null);
  const [containerDims, setContainerDims] = useState({ width: 1000, height: 800 });

  // Track container dimensions
  useEffect(() => {
    const updateDims = () => {
      if (containerRef.current) {
        setContainerDims({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    updateDims();
    window.addEventListener('resize', updateDims);
    return () => window.removeEventListener('resize', updateDims);
  }, []);

  // Initialize left CogTiles
  useEffect(() => {
    console.log('Initializing left CogTiles');
    const cogInstance = new CogTiles(buildTerrainOptions('elevation'));
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      console.log('Left CogTiles initialized');
      setLeftCogState({ cog: cogInstance, mode: 'elevation' });
    }).catch(err => console.error('Left CogTiles init error:', err));
  }, []);

  // Initialize right CogTiles
  useEffect(() => {
    console.log('Initializing right CogTiles');
    const cogInstance = new CogTiles(buildTerrainOptions('elevation-swiss'));
    cogInstance.initializeCog(DEM_COG_URL).then(() => {
      console.log('Right CogTiles initialized');
      setRightCogState({ cog: cogInstance, mode: 'elevation-swiss' });
    }).catch(err => console.error('Right CogTiles init error:', err));
  }, []);

  // Update left CogTiles when mode changes
  useEffect(() => {
    if (!leftCogState.cog || leftMode === leftCogState.mode) return;
    
    console.log(`Updating left mode to ${leftMode}`);
    const newCog = new CogTiles(buildTerrainOptions(leftMode));
    newCog.initializeCog(DEM_COG_URL).then(() => {
      setLeftCogState({ cog: newCog, mode: leftMode });
    }).catch(err => console.error('Left mode update error:', err));
  }, [leftMode, leftCogState.cog, leftCogState.mode]);

  // Update right CogTiles when mode changes
  useEffect(() => {
    if (!rightCogState.cog || rightMode === rightCogState.mode) return;
    
    console.log(`Updating right mode to ${rightMode}`);
    const newCog = new CogTiles(buildTerrainOptions(rightMode));
    newCog.initializeCog(DEM_COG_URL).then(() => {
      setRightCogState({ cog: newCog, mode: rightMode });
    }).catch(err => console.error('Right mode update error:', err));
  }, [rightMode, rightCogState.cog, rightCogState.mode]);

  // Handle view state changes from either pane
  const handleViewStateChange = useCallback(({ viewState: newViewState }) => {
    setViewState(newViewState);
  }, []);

  // Handle divider drag
  const handleMouseDown = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const newRatio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.max(0.15, Math.min(0.85, newRatio)));
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

  const leftIsTransitioning = leftCogState.mode !== leftMode;
  const rightIsTransitioning = rightCogState.mode !== rightMode;

  const dividerPx = splitRatio * 100;

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
      {/* Left pane - independent DeckGL */}
      <MapPane
        mode={leftMode}
        cogState={leftCogState}
        setMode={setLeftMode}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        isTransitioning={leftIsTransitioning}
        side="left"
        splitRatio={splitRatio}
        containerWidth={containerDims.width}
        containerHeight={containerDims.height}
      />

      {/* Right pane - independent DeckGL */}
      <MapPane
        mode={rightMode}
        cogState={rightCogState}
        setMode={setRightMode}
        viewState={viewState}
        onViewStateChange={handleViewStateChange}
        isTransitioning={rightIsTransitioning}
        side="right"
        splitRatio={splitRatio}
        containerWidth={containerDims.width}
        containerHeight={containerDims.height}
      />

      {/* Draggable divider slider */}
      <div
        onMouseDown={handleMouseDown}
        style={{
          position: 'absolute',
          left: `${dividerPx}%`,
          top: 0,
          width: 8,
          height: '100%',
          backgroundColor: '#fff',
          cursor: 'col-resize',
          userSelect: 'none',
          zIndex: 30,
          opacity: isDragging ? 1 : 0.8,
          boxShadow: '0 0 10px rgba(0, 0, 0, 0.6)',
          transform: 'translateX(-50%)',
          transition: isDragging ? 'none' : 'opacity 0.2s',
          pointerEvents: 'auto',
        }}
      />
    </div>
  );
}

export default CogTerrainKernel;

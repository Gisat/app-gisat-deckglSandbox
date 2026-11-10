import { useEffect, useMemo, useState } from 'react';
import { DeckGL } from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { SphereGeometry } from '@luma.gl/engine';
import { CogTerrainLayer } from '@gisatcz/deckgl-geolib';
import { useTerrainZRange } from '@gisatcz/deckgl-geolib/react';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import chroma from 'chroma-js';
import TimelineChart from './TimelineChart';

const DATA_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/polaky_95D_PS.geojson';
const TERRAIN_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/EL-GRID_COGeoN.tif';
const SATELLITE_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// Exact 3d-feature-charts ramp (red -> yellow -> teal) on the VEL_AVG domain.
const colorScale = chroma
  .scale([[215, 25, 28], [254, 254, 191], [65, 182, 196]])
  .domain([-1, 1]);

const sphereGeometry = new SphereGeometry();

// Sphere radius in metres (LNGLAT positions are world units, i.e. metres).
const SPHERE_RADIUS = 4;

const INITIAL_VIEW_STATE = {
  longitude: 13.3607,
  latitude: 50.33776,
  zoom: 15,
  pitch: 50,
  bearing: 0,
  minZoom: 8,
  maxZoom: 18,
  maxPitch: 70,
};

const TERRAIN_OPTIONS = {
  type: 'terrain',
  useChannel: 1,
  noDataValue: 0,
  disableLighting: true,
  useSingleColor: true,
  color: [200, 200, 200, 255],
};

// Spheres use the measured ellipsoidal height H as-is, with no datum conversion.
// H is 368.5-452.5 m across the site while the orthometric EL-GRID terrain is
// ~45 m lower, so spheres intentionally float above the draped surface.
function getElevation(feature) {
  const height = Number(feature?.properties?.H);
  return Number.isFinite(height) ? height : 0;
}

function getRgba(feature) {
  // chroma 2.x scales extrapolate outside the domain; clamp so the few stations
  // past ±1 stay at the ramp endpoints instead of producing bad channels.
  const value = Number(feature?.properties?.VEL_AVG ?? 0);
  const clamped = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  const [r, g, b] = colorScale(clamped).rgb();
  return [r, g, b, 255];
}

function formatNumber(value, digits) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(digits) : '–';
}

export default function PolakyHradec() {
  const { zRange, onZRangeUpdate } = useTerrainZRange();
  const [features, setFeatures] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      try {
        const res = await fetch(DATA_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${DATA_URL}`);
        const data = await res.json();
        // Handle both FeatureCollection and direct array formats
        const loaded = Array.isArray(data) ? data : (data.features || []);
        if (!cancelled) {
          setFeatures(loaded);
          setIsLoading(false);
        }
      } catch (err) {
        console.error('❌ Failed to load Poláky data:', err);
        if (!cancelled) {
          setError(err.message || String(err));
          setIsLoading(false);
        }
      }
    };

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedFeature = useMemo(() => {
    if (selectedId == null) return null;
    return features.find(f => String(f.properties?.ID) === String(selectedId)) ?? null;
  }, [features, selectedId]);

  const layers = useMemo(() => {
    const terrainLayer = new CogTerrainLayer({
      id: 'terrain-elevation',
      elevationData: TERRAIN_URL,
      isTiled: true,
      tileSize: 256,
      minZoom: 10,
      maxZoom: 15,
      operation: 'terrain+draw',
      onZRangeUpdate,
      pickable: false,
      terrainOptions: TERRAIN_OPTIONS,
    });

    // zRange keeps the draped tiles from being frustum-culled in tilted views.
    const satelliteLayer = new TileLayer({
      id: 'satellite-base',
      data: SATELLITE_TILE_URL,
      minZoom: 0,
      maxZoom: 19,
      tileSize: 256,
      zRange,
      extensions: [new TerrainExtension()],
      renderSubLayers: (props) => {
        const { west, south, east, north } = props.tile.bbox;
        return new BitmapLayer(props, {
          data: undefined,
          image: props.data,
          bounds: [west, south, east, north],
        });
      },
    });

    const sphereLayer = new SimpleMeshLayer({
      id: 'vel-avg-spheres',
      data: features,
      mesh: sphereGeometry,
      coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
      pickable: true,
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getColor: getRgba,
      // Constant size; selection is shown by the ring, not by scaling the mesh.
      getScale: () => [SPHERE_RADIUS, SPHERE_RADIUS, SPHERE_RADIUS],
    });

    // SimpleMeshLayer has no outline, so mark the selection with a billboard ring.
    const selectionRing = new ScatterplotLayer({
      id: 'selected-point-ring',
      data: selectedFeature ? [selectedFeature] : [],
      pickable: false,
      filled: false,
      stroked: true,
      billboard: true,
      radiusUnits: 'pixels',
      lineWidthUnits: 'pixels',
      getPosition: (d) => [
        d.geometry.coordinates[0],
        d.geometry.coordinates[1],
        getElevation(d),
      ],
      getRadius: 8,
      getLineWidth: 2,
      getLineColor: [66, 212, 244, 255],
    });

    return [terrainLayer, satelliteLayer, sphereLayer, selectionRing];
  }, [zRange, onZRangeUpdate, features, selectedFeature]);

  const legendGradient = `linear-gradient(to right, ${colorScale.colors(10).join(', ')})`;

  return (
    <div style={{
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      colorScheme: 'light',
      background: '#ffffff',
    }}>
      <DeckGL
        initialViewState={INITIAL_VIEW_STATE}
        controller={{
          dragRotate: true,
          touchRotate: true,
          dragPan: true,
          scrollZoom: true,
          keyboard: true,
        }}
        layers={layers}
        onClick={({ object }) => setSelectedId(object?.properties?.ID ?? null)}
        getTooltip={({ object }) => {
          const props = object?.properties;
          if (!props) return null;
          return {
            text: [
              `ID: ${props.ID ?? '–'}`,
              `VEL_AVG: ${formatNumber(props.VEL_AVG, 2)} mm/yr`,
              `H_dem: ${formatNumber(props.H_dem, 1)} m`,
            ].join('\n'),
          };
        }}
        deviceProps={{ waitForPageLoad: false }}
        className="deckgl-map"
      />

      {isLoading && (
        <div style={{ position: 'absolute', top: 10, left: 10, background: 'rgba(0,0,0,0.7)', color: 'white', padding: '10px', borderRadius: '4px' }}>
          Loading data...
        </div>
      )}

      {error && (
        <div style={{ position: 'absolute', top: 10, left: 10, maxWidth: '60%', background: 'rgba(160,0,0,0.85)', color: 'white', padding: '10px', borderRadius: '4px', fontFamily: 'system-ui, sans-serif', fontSize: '12px' }}>
          Failed to load Poláky data: {error}
        </div>
      )}

      <div style={{
        position: 'absolute',
        left: 12,
        bottom: 12,
        zIndex: 10,
        padding: '8px 10px',
        background: 'rgba(255, 255, 255, 0.9)',
        border: '1px solid #ddd',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '11px',
        color: '#333',
      }}
      >
        <div style={{ marginBottom: '4px', fontWeight: 600 }}>VEL_AVG (mm/yr)</div>
        <div style={{ width: '180px', height: '10px', borderRadius: '2px', background: legendGradient }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px', color: '#555' }}>
          <span>-1</span>
          <span>0</span>
          <span>+1</span>
        </div>
      </div>

      {selectedFeature && (
        <TimelineChart feature={selectedFeature} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

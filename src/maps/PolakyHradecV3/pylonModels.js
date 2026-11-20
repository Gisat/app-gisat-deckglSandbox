// Tower mesh metadata shared by the map's pylon layers and the inspector chart.
// It lives in its own module rather than `index.jsx` so the chart can read it
// without importing the map component (which would be a cycle).
import { PYLON_NATIVE_HEIGHTS } from './tracks';

const PYLON_ASSET_BASE = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets';

// Fallback bearing (degrees clockwise from north) for features without
// `azimuth`; the current GeoJSON provides it for every tower.
const PYLON_DEFAULT_AZIMUTH = 60;
// Compasses measure clockwise from north, deck.gl yaw rotates counter-clockwise
// from +X (east), hence yaw = 90 - azimuth. Adjust this offset if a model's
// local forward axis turns out not to be +X after checking it on the imagery.
const PYLON_OBJ_YAW_OFFSET = 0;

// Native heights come from the OBJ headers (metres, Z-up, base centre at origin),
// re-exported by `tracks.js` so the mesh scale and the rig fallback agree.
// Each instance is scaled to its GeoJSON `height`; see `getPylonHeight` in rigData.
export const PYLON_MODELS = [
  { typ: 'dunaj', nativeHeight: PYLON_NATIVE_HEIGHTS.dunaj, mesh: `${PYLON_ASSET_BASE}/dunaj.obj` },
  { typ: 'kocka', nativeHeight: PYLON_NATIVE_HEIGHTS.kocka, mesh: `${PYLON_ASSET_BASE}/kocka.obj` },
  { typ: 'portal', nativeHeight: PYLON_NATIVE_HEIGHTS.portal, mesh: `${PYLON_ASSET_BASE}/portal.obj` },
];

// Per-feature azimuth from the GeoJSON, normalised to 0-360; only features
// missing the value fall back to the default bearing.
function getPylonAzimuth(feature) {
  const raw = feature?.properties?.azimuth;
  if (raw === null || raw === undefined || raw === '') return PYLON_DEFAULT_AZIMUTH;
  const azimuth = Number(raw);
  return Number.isFinite(azimuth) ? ((azimuth % 360) + 360) % 360 : PYLON_DEFAULT_AZIMUTH;
}

// deck.gl orientation is [pitch, yaw, roll] in degrees, so the compass bearing
// only drives yaw.
export function getPylonOrientation(feature) {
  return [0, 90 - getPylonAzimuth(feature) + PYLON_OBJ_YAW_OFFSET, 0];
}

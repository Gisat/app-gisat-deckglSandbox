# Copilot Instructions for app-gisat-deckglSandbox

## Project Overview

A geospatial visualization sandbox application showcasing Deck.GL-based 3D and 2D map applications. The project serves as a collection of demos for various geospatial data visualization techniques including point clouds, 3D tiles, GeoParquet data processing with DuckDB, satellite/InSAR data, and terrain rendering.

## Build, Test, and Lint Commands

**Development server:**
```bash
npm run dev
```
Runs Vite dev server with HMR. Access at `http://localhost:5173/`.

**Production build:**
```bash
npm run build
```
Builds optimized bundle to `dist/` directory.

**Linting:**
```bash
npm run lint
```
Runs ESLint on JavaScript/JSX files with strict configuration (max-warnings: 0). The linter enforces React hooks rules and prevents unused disable directives.

**Preview production build:**
```bash
npm run preview
```

**Deployment:**
```bash
npm run deploy
```
Deploys built assets to GitHub Pages using gh-pages.

## High-Level Architecture

### Frontend Structure

**Entry Point (`src/main.jsx`):**
- Renders React App component to DOM root

**App Router (`src/App.jsx`):**
- Uses React Router for client-side navigation
- Maintains a sidebar navigation with links to all available map demos
- Routes defined dynamically from `src/maps/config.js`

**Map Applications (`src/maps/`):**
- Each map app is a standalone React component
- Imports in `config.js` define available demos with paths and display names
- Examples: `MetroD_DEM/index.jsx`, `GeoParquetDuckDBwasm/MinimalWasmMap.jsx`, etc.
- Most use Deck.GL + React for interactive 3D/2D visualization

**Layer System (`src/layers/DuckDBGeoParquetLayer.js`):**
- Custom Deck.GL layer implementations for specialized data formats
- Handles GeoParquet and DuckDB integration

**Backend (`src/backend/):**
- Flask application with CORS support
- Python services for data processing (DuckDB, PyArrow)
- Serves data APIs to frontend maps

### Core Dependencies

**Visualization:**
- **Deck.GL** (`@deck.gl/*` suite): Core 3D visualization engine
- **React Map GL** (`react-map-gl`): Mapbox integration for map controls
- **dat.gui**: Interactive GUI controls for layer properties

**Data Processing:**
- **DuckDB Wasm** (`@duckdb/duckdb-wasm`): In-browser SQL execution for GeoParquet
- **Apache Arrow** (`apache-arrow`): Columnar data format support
- **Parquet Wasm** (`parquet-wasm`): WebAssembly parquet file reading
- **Loaders.gl** (`@loaders.gl/*`): Various geospatial data format loaders (3D Tiles, GeoTIFF, OBJ, etc.)

**Geospatial:**
- **@gisatcz/deckgl-geolib**: Custom GISAT Deck.GL extensions (terrain, etc.)
- **@geoarrow/deck.gl-layers**: GeoArrow format support
- **geotiff** & **geotiff-geokeys-to-proj4**: GeoTIFF reading and CRS handling
- **proj4**: Coordinate system transformations
- **chroma-js** & **d3-scale**: Color scales and data visualization helpers

### Build Configuration

**Vite Config (`vite.config.js`):**
- React plugin with Fast Refresh
- WASM plugin for WebAssembly imports
- Top-level await support (required for DuckDB)
- CORS headers (`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`) for SharedArrayBuffer support
- Base path: `/` for dev, `/app-gisat-deckglSandbox/` for production (GitHub Pages)

**ESLint Config (`.eslintrc.cjs`):**
- Extends `eslint:recommended`, React recommended, React hooks rules
- React version 18.2
- Strict: no unused disable directives allowed

## Key Conventions

### Map App Creation

**Layer Configuration Pattern:**
Map applications typically use a `layerConfigs` array where each layer is defined with:
- `id`: Unique layer identifier
- `type`: Deck.GL layer class (e.g., `TileLayer`, `MVTLayer`, `SimpleMeshLayer`)
- `options`: Layer-specific rendering properties (data URL, colors, getters, extensions)
- `name`: Display name in UI controls
- `showVisibilityToggle`: Boolean to show in dat.gui UI
- Optional `controls`: Object defining dat.gui controls for layer properties

Layers are created dynamically in `createLayer()` function and rendered into a `DeckGL` component.

**Visibility & Property Management:**
- Use React state hooks (`useState`) for layer visibility and properties
- `useEffect` initializes dat.gui on mount and cleans up on unmount
- Layer getter functions (e.g., `getFillColor`, `getElevation`) use data properties

**Example Pattern:**
```jsx
const layerConfigs = [
  {
    id: 'terrain',
    type: CogTerrainLayer,
    options: {
      elevationData: 'https://...',
      minZoom: 12,
      maxZoom: 17,
      visible: true,
      // ...terrain options
    },
    name: 'Terrain',
    showVisibilityToggle: true,
  },
  // more configs...
];

const [layerVisibility, setLayerVisibility] = useState(/* initial state */);
const layers = layerConfigs.map(config => createLayer(config, layerVisibility[config.id], ...));

// In render:
<DeckGL
  initialViewState={INITIAL_VIEW_STATE}
  controller={true}
  layers={layers}
  className="deckgl-map"
/>
```

### Data Format Support

- **MVT (Mapbox Vector Tiles):** Use `MVTLayer` with `binary: true/false` option
- **GeoJSON:** Use `GeoJsonLayer` with GeoJSON data URLs
- **GeoTIFF/COG:** Use loaders from `@loaders.gl/` or custom `CogTerrainLayer`
- **GeoParquet:** Use custom layers or DuckDB Wasm for in-browser SQL queries
- **3D Tiles:** Use `@loaders.gl/3d-tiles` with appropriate layer type

### Map Initial View State

Typically defined as:
```jsx
const INITIAL_VIEW_STATE = {
  longitude: 14.437713740781064,
  latitude: 50.05105178409062,
  zoom: 15,
  pitch: 40,
  bearing: 0,
};
```

Adjust based on demo data's geographic location.

### Mesh and Asset Loading

- **OBJ Files:** Use `OBJLoader` from `@loaders.gl/obj`
- **Geometry:** Use Luma.GL geometries (e.g., `SphereGeometry` from `@luma.gl/engine`)
- **Rotation/Translation:** Use `getOrientation`, `getPosition`, `getScale`, `getTranslation` getter functions on `SimpleMeshLayer`

### Terrain Extensions

Many maps use the `_TerrainExtension` to drape layers over terrain:
```jsx
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";
// In layer options:
extensions: [new TerrainExtension()],
```

### Color Scaling

Use **chroma-js** for color scales and **d3-scale** for linear/log scaling:
```jsx
const colorScale = chroma.scale(['#red', '#blue']).domain([-5, 5]);
const sizeScale = scaleLinear([min, max], [outMin, outMax]).clamp(true);

// In layer:
getColor: (d) => [...colorScale(d.properties.value).rgb(), 255],
getScale: (d) => sizeScale(d.properties.size),
```

### Backend Integration

Python backend provides data processing APIs. Environment variables in `.env` and `.env.example` configure backend URLs. CORS is enabled on Flask app, and CORS headers are set in Vite config for SharedArrayBuffer support.

## Important Notes

- **SharedArrayBuffer requirement:** DuckDB Wasm requires CORS headers to enable SharedArrayBuffer. Ensure `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers are present (already configured in vite.config.js).
- **Large dependencies:** Deck.GL and DuckDB Wasm are substantial. Expect longer initial build times.
- **Hot Module Replacement (HMR):** Works well for component changes; full page reload may be needed for layer configuration changes in some cases.
- **Deployment:** App is deployed to GitHub Pages at `/app-gisat-deckglSandbox/`. Ensure base path in vite.config.js matches deployment URL.

## Recommended MCP Servers

**Playwright** would be valuable for browser-based testing of map interactions and ensuring Deck.GL visualizations render correctly. This could be configured in the Copilot cloud agent environment for future development sessions.

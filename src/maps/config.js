// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MetroD_Google3DTiles from "./MetroD_Google3DTiles/index.jsx";
import MetroD_DEM from "./MetroD_DEM/index.jsx";
import Google3DTiles from "./Google3DTiles/index.jsx";
import D8_iconArrows from "./D8_iconArrows/index.jsx";
import MapApp1 from './MapApp1';
import D8_filter from "./D8_filter/index.jsx";
import vertical_profile from "./vertical_profiles/index.jsx";
import building3D from './Buildings_3D/index.jsx';
import deck3DTiles from './Deck3DTiles/index.jsx';
import geoParquetGisat from './GeoParquetGisat/index.jsx';
import geoParquetDemo from './GeoParquetDemo/index.jsx';
import geoParquetLoaders from './GeoparquetLoaders/index.jsx';
import geoParquetLoadersBinary from './GeoparquetLoadersBinary/index.jsx';
import geoParquetDuckDB from './GeoParquetDuckDB/index.jsx';
import geoParquetDuckDB3D from './GeoParquetDuckDB_3D/frontend/Map3D.jsx';
import geoParquetDuckDB2D from './GeoParquetDuckDB_2D/frontend/Map2D.jsx';
import geoParquetDuckDBwasm from './GeoParquetDuckDBwasm/MinimalWasmMap.jsx';
import geoParquetTiled from './GeoParquetTiled/GeoParquetTiled.jsx';
import geoParquetVirtualTiles from './GeoParquetVirtualTile/VirtualTilesMap.jsx';
import geoParquetDuckDBpolygon from './GeoParquetDuckDB_polygon/PolygonMap3D.jsx';
import MetroDarrows3D from "./MetroD_arrows_3D/index.jsx";
import devSeedCOG from "./DevSeedCOG/CogMap.jsx";

const mapApps = [
    { name: 'P1 Metro D: buildings & DEM', path: '/metro-d-dem', component: MetroD_DEM },
    { name: 'P1 Metro D: Google 3D Tiles', path: '/metro-d-google-3d-tiles', component: MetroD_Google3DTiles },
    { name: 'P1 Metro D: 3D arrows', path: '/metro-d-3d-arrows', component: MetroDarrows3D },
    { name: 'P3 D8: points as spheres', path: '/d8-mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'P3 D8: 2D arrows', path: '/d8-icon-arrows', component: D8_iconArrows },
    { name: 'P3 D8: 3D arrows', path: '/d8-filter', component: D8_filter },
    { name: 'P3 D8: vertical profile', path: '/vertical_profile', component: vertical_profile },
    // { name: 'Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    { name: 'Test App', path: '/test-app', component: MapApp1 },
    { name: 'Buildings 3D', path: 'buildings-3D', component: building3D },
    { name: '3D Tiles Layer', path: '/deck-3d-tiles', component: deck3DTiles },
    { name: 'GeoParquet Gisat', path: '/geo-parquet-gisat', component: geoParquetGisat },
    { name: 'GeoParquet Demo', path: '/geo-parquet-demo', component: geoParquetDemo },
    { name: 'GeoParquet Loaders', path: '/geo-parquet-loaders', component: geoParquetLoaders },
    { name: 'GeoParquet Loaders v2', path: '/geo-parquet-loaders-binary', component: geoParquetLoadersBinary },
    // { name: 'GeoParquet DuckDB', path: '/geo-parquet-duckdb', component: geoParquetDuckDB },
    { name: 'GeoParquet DuckDB 2D', path: '/geoparquet-duckdb-2d', component: geoParquetDuckDB2D },
    { name: 'GeoParquet DuckDB 3D', path: '/geoparquet-duckdb-3d', component: geoParquetDuckDB3D },
    { name: 'GeoParquet DuckDB polygon', path: '/geoparquet-duckdb-polygon', component: geoParquetDuckDBpolygon },
    { name: 'GeoParquet DuckDB Wasm', path: '/geoparquet-duckdb-wasm', component: geoParquetDuckDBwasm },
    { name: 'GeoParquet Tiled', path: '/geoparquet-tiled', component: geoParquetTiled },
    { name: 'GeoParquet Virtual Tiles', path: '/geoparquet-virtual-tiles', component: geoParquetVirtualTiles },
    { name: 'Deck.gl-raster COG', path: '/deck.gl-raster', component: devSeedCOG },
];

export default mapApps;

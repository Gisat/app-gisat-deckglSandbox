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
import MetroDarrows3D from "./MetroD_arrows_3D/index.jsx";

const mapApps = [
    { name: 'P1 Metro D: buildings & DEM', path: '/metro-d-dem', component: MetroD_DEM },
    { name: 'P1 Metro D: Google 3D Tiles', path: '/metro-d-google-3d-tiles', component: MetroD_Google3DTiles },
    { name: 'P1 Metro D: 3D arrows', path: '/metro-d-3d-arrows', component: MetroDarrows3D },
    { name: 'P3 D8: points as spheres', path: '/d8-mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'P3 D8: 2D arrows', path: '/d8-icon-arrows', component: D8_iconArrows },
    { name: 'P3 D8: 3D arrows', path: '/d8-filter', component: D8_filter },
    { name: 'P3 D8: vertical profile', path: '/vertical_profile', component: vertical_profile },
    // { name: 'POC Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    { name: 'POC Test App', path: '/test-app', component: MapApp1 },
    { name: 'POC Buildings 3D', path: 'buildings-3D', component: building3D },
    { name: 'POC 3D Tiles Layer', path: '/deck-3d-tiles', component: deck3DTiles },
    { name: 'POC GeoParquet Gisat', path: '/geo-parquet-gisat', component: geoParquetGisat },
    { name: 'POC GeoParquet Demo', path: '/geo-parquet-demo', component: geoParquetDemo },
    { name: 'POC GeoParquet Loaders', path: '/geo-parquet-loaders', component: geoParquetLoaders },
    { name: 'POC GeoParquet Loaders v2', path: '/geo-parquet-loaders-binary', component: geoParquetLoadersBinary },

];

export default mapApps;

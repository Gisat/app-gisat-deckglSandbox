// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MetroD_Google3DTiles from "./MetroD_Google3DTiles/index.jsx";
import MetroD_DEM from "./MetroD_DEM/index.jsx";
import Google3DTiles from "./Google3DTiles/index.jsx";
import D8_iconArrows from "./D8_iconArrows/index.jsx";
import MapApp1 from './MapApp1';

const mapApps = [
    { name: 'Metro D: Google 3D Tiles', path: '/metro-d-google-3d-tiles', component: MetroD_Google3DTiles },
    { name: 'Metro D: DEM', path: '/metro-d-dem', component: MetroD_DEM },
    { name: 'D8: MVT Point Cloud Spheres', path: '/d8-mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'D8: Icon Arrows', path: '/d8-icon-arrows', component: D8_iconArrows },
    { name: 'Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    { name: 'Test App', path: '/test-app', component: MapApp1 },
];

export default mapApps;

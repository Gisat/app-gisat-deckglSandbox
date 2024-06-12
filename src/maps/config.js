// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MetroD from './MetroD';
import MetroD_Google3DTiles from "./MetroD_Google3DTiles/index.jsx";
import MetroD_DEM from "./MetroD_DEM/index.jsx";
import Google3DTiles from "./Google3DTiles/index.jsx";
import MapApp1 from './MapApp1';

const mapApps = [
    { name: 'Metro D: Google 3D Tiles', path: '/metro-d-google-3d-tiles', component: MetroD_Google3DTiles },
    { name: 'Metro D: DEM', path: '/metro-d-dem', component: MetroD_DEM },
    { name: 'MVT Point Cloud Spheres', path: '/mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'Metro D', path: '/metro-d', component: MetroD },
    { name: 'Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    { name: 'Test App', path: '/test-app', component: MapApp1 },
];

export default mapApps;

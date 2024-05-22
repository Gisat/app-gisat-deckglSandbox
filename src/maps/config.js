// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MetroD from './MetroD';
import Google3DTiles from "./Google3DTiles/index.jsx";
import MapApp1 from './MapApp1';

const mapApps = [
    { name: 'MVT Point Cloud Spheres', path: '/mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'Metro D', path: '/metro-d', component: MetroD },
    { name: 'Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    { name: 'Test App', path: '/test-app', component: MapApp1 },
];

export default mapApps;

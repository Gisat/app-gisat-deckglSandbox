// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MetroD_Google3DTiles from "./MetroD_Google3DTiles/index.jsx";
import MetroD_DEM from "./MetroD_DEM/index.jsx";
import Google3DTiles from "./Google3DTiles/index.jsx";
import D8_iconArrows from "./D8_iconArrows/index.jsx";
import MapApp1 from './MapApp1';
import D8_filter from "./D8_filter/index.jsx";
import vertical_profile from "./vertical_profiles/index.jsx";

const mapApps = [
    { name: 'P1 Metro D: buildings & DEM', path: '/metro-d-dem', component: MetroD_DEM },
    { name: 'P1 Metro D: Google 3D Tiles', path: '/metro-d-google-3d-tiles', component: MetroD_Google3DTiles },
    { name: 'P3 D8: points as spheres', path: '/d8-mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'P3 D8: 2D arrows', path: '/d8-icon-arrows', component: D8_iconArrows },
    { name: 'P3 D8: data filter extension', path: '/d8-filter', component: D8_filter },
    { name: 'P3 D8: vertical profile', path: '/vertical_profile', component: vertical_profile },
    // { name: 'Google 3D Tiles', path: '/google-3d-tiles', component: Google3DTiles },
    // { name: 'Test App', path: '/test-app', component: MapApp1 },
];

export default mapApps;

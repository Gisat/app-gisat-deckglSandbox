// src/maps/config.js
import MVTPointCloudSpheres from './MVTPointCloudSpheres';
import MapApp1 from './MapApp1';
import MapApp2 from './MapApp2';

const mapApps = [
    { name: 'MVT Point Cloud Spheres', path: '/mvt-point-cloud-spheres', component: MVTPointCloudSpheres },
    { name: 'Map App 1', path: '/map1', component: MapApp1 },
    { name: 'Map App 2', path: '/map2', component: MapApp2 },
];

export default mapApps;

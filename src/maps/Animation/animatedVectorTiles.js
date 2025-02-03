import {MVTLayer} from "@deck.gl/geo-layers";
import {PointCloudLayer} from '@deck.gl/layers';
// import ArrowPointCloudLayer from "./arrowPointCloudLayer";
import chroma from "chroma-js";


const colorScale = chroma
    .scale(["#fda34b", "#ff7882", "#c8699e", "#7046aa", "#0c1db8", "#2eaaac"])
    .domain([-30, 10]);


export function createAnimatedVectorTilesLayer(currentFrame) {

    return new MVTLayer({
            // data: `https://gisat-gis.eu-central-1.linodeobjects.com/eman/mvt/142_decimated_2/{z}/{x}/{y}.mvt`,
            // data: `https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/mvt/142_decimated.mbtiles`,
            // entire dataset but only vel avg property
            data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/mvt/emsn091_32_01_ps_los_velavg/{z}/{x}/{y}.pbf',
            // testing data set with timeline properties
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/mvt/threePoints_timeline/{z}/{x}/{y}.pbf',
            // entire dataset with timeline properties
            // data: 'https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/mvt/emsn091_32_01_ps_los_timeline/{z}/{x}/{y}.pbf',
            binary: false,
            updateTriggers: {
                getPosition: [currentFrame],
                getFillColor: [currentFrame],
                getColor: [currentFrame]
            },
            renderSubLayers: (props) => {
                if (props.data) {
                    // return new GeoJsonLayer({
                    //     ...props,
                    //     id: `${props.id}-animated-layer-point-cloud`,
                    //     pointType: "circle",
                    //     getPointRadius: 30,
                    //     stroked: false,
                    //     // getFillColor: [255,0,0,255],
                    //     getFillColor: (d) => {
                    //         if (d.properties.vel_avg <= currentFrame - 30) {
                    //             return [...colorScale(d.properties.vel_avg).rgb(), 255]
                    //         }
                    //         else return [0,0,0,0]
                    //
                    //     },
                    // })

                    // return new ArrowPointCloudLayer({
                    return new PointCloudLayer({
                        ...props,
                        id: `${props.id}-animated-layer-point-cloud`,
                        pickable: false,
                        pointSize: 1,
                        getPosition: (d) => {
                            // const modified_height = sumArrayUntilNthElement(JSON.parse(d.properties.timeline_values), currentFrame)
                            // return [...d.geometry.coordinates, (d.properties.vel_avg + modified_height*10 + 50000)]
                            return [...d.geometry.coordinates, (d.properties.vel_avg + 30) * 500 + 5000]

                        },
                        getColor: (d) => {
                            if (d.properties.vel_avg <= currentFrame - 30) {
                                return [...colorScale(d.properties.vel_avg).rgb(), 255]
                            } else return [0, 0, 0, 0]
                        },
                        _full3d: true,
                        visible: true,
                        // getPosition: (d) => [...d.geometry.coordinates, 5000],
                        // getColor: (d) => [...colorScale(d.properties.vel_avg).rgb(), 255]

                    })
                }
                return null
            },
            minZoom: 8,
            maxZoom: 13,
            visible: true,
            // stroked: false,
            // filled: true,
            // pointType: "circle",
            // updateTriggers: {
            //     getFillColor: [currentFrame]
            // },
            // getFillColor: (d) => {
            //     if (d.properties.vel_avg <= this.state.currentFrame - 30) {
            //         return [...colorScale(d.properties.vel_avg).rgb(), 255]
            //     }
            //     else return [0,0,0,0]
            //
            // },
            // // getFillColor: [255,0,0,255],
            // getPointRadius: 30,
        })
        }

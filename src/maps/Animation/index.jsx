import React, { useEffect, useState, useRef } from "react";
import { DeckGL } from "deck.gl";
import { MapView } from "@deck.gl/core";
import { MVTLayer, TileLayer } from "@deck.gl/geo-layers";
import { BitmapLayer, PointCloudLayer } from "@deck.gl/layers";
import * as dat from "dat.gui";
import chroma from "chroma-js";
import { CogTerrainLayer } from "@gisatcz/deckgl-geolib";
const FRAME_MIN_TIME = 1000 / 30; // 30 FPS
const frameCount = 40;

const INITIAL_VIEW_STATE = {
    longitude: 120.9089351,
    latitude: 14.5991729,
    zoom: 9,
    pitch: 0,
    bearing: 0,
};

const colorScale = chroma
    .scale(["#fda34b", "#ff7882", "#c8699e", "#7046aa", "#0c1db8", "#2eaaac"])
    .domain([-30, 10]);

function Animation() {
    const [currentFrame, setCurrentFrame] = useState(0);
    const lastFrameTimeRef = useRef(0);
    const animationRef = useRef(null);
    const guiRef = useRef(null);
    const settingsRef = useRef({ timelineKeys: 0 });

    // Layer visibility state
    const [layerVisibility, setLayerVisibility] = useState({
        "animated-vector-tiles": true,
        "tile-layer": true,
    });

    // Animation function
    const _animate = (time) => {
        if (time - lastFrameTimeRef.current < FRAME_MIN_TIME) {
            animationRef.current = requestAnimationFrame(_animate);
            return;
        }
        lastFrameTimeRef.current = time;

        setCurrentFrame((prevFrame) => {
            let nextFrame = prevFrame < frameCount ? prevFrame + 1 : 0;
            settingsRef.current.timelineKeys = nextFrame;
            return nextFrame;
        });

        animationRef.current = requestAnimationFrame(_animate);
    };

    // Layer configurations
    const layerConfigs = [
        {
            id: "animated-vector-tiles",
            type: MVTLayer,
            options: {
                visible: layerVisibility["animated-vector-tiles"],
                data: "https://gisat-gis.eu-central-1.linodeobjects.com/3dflus/mvt/emsn091_32_01_ps_los_velavg/{z}/{x}/{y}.pbf",
                binary: false,
                updateTriggers: {
                    // getPosition: [currentFrame],
                    // getFillColor: [currentFrame],
                    getColor: [currentFrame],
                },
                renderSubLayers: (props) =>
                    props.data
                        ? new PointCloudLayer({
                            ...props,
                            id: `${props.id}-animated-layer-point-cloud`,
                            pickable: false,
                            pointSize: 1,
                            getPosition: (d) => [...d.geometry.coordinates, (d.properties.vel_avg + 30) * 500 + 5000],
                            getColor: (d) =>
                                d.properties.vel_avg <= currentFrame - 30
                                    ? [...colorScale(d.properties.vel_avg).rgb(), 255]
                                    : [0, 0, 0, 0],
                            visible: true,
                        })
                        : null,
            },
            name: "Animation",
            showVisibilityToggle: true,
        },
        {
            id: "tile-layer",
            type: TileLayer,
            options: {
                visible: layerVisibility["tile-layer"],
                data: "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png",
                minZoom: 0,
                maxZoom: 19,
                tileSize: 256,
                renderSubLayers: (props) => {
                    const {
                        bbox: { west, south, east, north },
                    } = props.tile;
                    return new BitmapLayer(props, {
                        data: null,
                        image: props.data,
                        bounds: [west, south, east, north],
                    });
                },
            },
            name: "Basemap",
            showVisibilityToggle: true,
        },
    ];

    // Dynamically create layers with updated visibility
    const layers = layerConfigs.map(
        (config) => new config.type({ ...config.options, id: config.id, currentFrame })
    );

    useEffect(() => {
        const gui = new dat.GUI();
        guiRef.current = gui;
        let settings = settingsRef.current;

        gui
            .add(settings, "timelineKeys", 0, frameCount)
            .listen()
            .onChange((value) => setCurrentFrame(value));

        gui.add(
            {
                startAnimation: () => {
                    if (!animationRef.current) {
                        animationRef.current = requestAnimationFrame(_animate);
                    }
                },
            },
            "startAnimation"
        );

        gui.add(
            {
                stopAnimation: () => {
                    if (animationRef.current) {
                        cancelAnimationFrame(animationRef.current);
                        animationRef.current = null;
                    }
                },
            },
            "stopAnimation"
        );

        // Layer Visibility Toggles
        layerConfigs.forEach((config) => {
            if (config.showVisibilityToggle) {
                gui
                    .add(layerVisibility, config.id)
                    .name(config.name)
                    .onChange((value) => {
                        setLayerVisibility((prevState) => ({
                            ...prevState,
                            [config.id]: value,
                        }));
                    });
            }
        });

        return () => {
            gui.destroy();
            cancelAnimationFrame(animationRef.current);
        };
    }, []);

    return (
        <DeckGL initialViewState={INITIAL_VIEW_STATE} controller={true} views={new MapView({ repeat: true })} layers={layers}>
        </DeckGL>
    );
}

export default Animation;

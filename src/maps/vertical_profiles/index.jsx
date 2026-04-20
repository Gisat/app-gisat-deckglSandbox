// src/maps/MapApp1.jsx
import { useState, useEffect } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView } from '@deck.gl/core';
import { BitmapLayer } from '@deck.gl/layers';
import chroma from "chroma-js";
import { scaleLinear } from 'd3-scale';
import {SimpleMeshLayer} from '@deck.gl/mesh-layers';
import {SphereGeometry} from '@luma.gl/engine';
import { _TerrainExtension as TerrainExtension } from '@deck.gl/extensions';
import { CogTerrainLayer } from "@gisatcz/deckgl-geolib";

const colorScale = chroma
    .scale(['#b1001d', '#ca2d2f', '#e25b40', '#ffaa00', '#ffff00', '#a0f000', '#4ce600', '#50d48e', '#00c3ff', '#0f80d1', '#004ca8', '#003e8a'])
    .domain([-5, 5]);

const sphereSizeScale = scaleLinear([0.45, 1], [2, 9]).clamp(true);

function getVerticalProfileBounds(
    leftX,
    leftY,
    rightX,
    rightY,
    leftProfileHeight,
    profileHeight,
    imageHeight
) {
    const heightAboveProfile = imageHeight ? imageHeight - profileHeight : 0;
    return [
        [leftX, leftY, leftProfileHeight - profileHeight],
        [leftX, leftY, leftProfileHeight + heightAboveProfile],
        [rightX, rightY, leftProfileHeight + heightAboveProfile],
        [rightX, rightY, leftProfileHeight - profileHeight],
    ];
}

const INITIAL_VIEW_STATE = {
    longitude: 14.015511800867504,
    latitude: 50.571906640192161,
    zoom: 13,
    pitch: 60,
    bearing: 0,
};

function MapApp1() {
    const [, setForceUpdate] = useState(0);

    useEffect(() => {
        const timer = setTimeout(() => setForceUpdate(1), 100);
        return () => clearTimeout(timer);
    }, []);

    const layers = [
        new BitmapLayer({
            id: 'verticalProfileLayer_D8_Stab_L1',
            bounds: getVerticalProfileBounds(14.015445, 50.570605, 14.028419600527943, 50.570945823734725, 370, 220, 230),
            image: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/assets/Stab-L1.png',
        }),
        new CogTerrainLayer({
            id: 'CogTerrainLayerD8Dem',
            elevationData:  'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/LITC52_53_4g_5m_4326_cog_nodata.tif',
            minZoom: 12,
            maxZoom: 14,
            opacity: 0.5,
            isTiled: true,
            useChannel: null,
            tileSize: 256,
            meshMaxError: 1,
            operation: 'terrain+draw',
            terrainOptions: {
                type: 'terrain',
                multiplier: 1,
                terrainSkirtHeight: 1,
            }
        }),
        new SimpleMeshLayer({
            data: 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/trim_d8_DESC_upd3_psd_los_4326_selected_arrows.geojson',
            id: 'sphere-mesh',
            mesh: new SphereGeometry(),
            getColor: (d) => [...colorScale(d.properties.vel_rel).rgb(), 255],
            getScale: (d) => Array(3).fill(sphereSizeScale(d.properties.coh)),
            getPosition: (d) => d.geometry.coordinates,
            getTranslation: (d) => [0,0,sphereSizeScale(d.properties.coh)*0.75],
            pickable: true,
            extensions: [new TerrainExtension()],
        })
    ]
    
    return (
        <DeckGL
            initialViewState={INITIAL_VIEW_STATE}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layers}
            className="deckgl-map"
        >
        </DeckGL>
    );
}

export default MapApp1;

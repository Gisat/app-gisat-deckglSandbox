import { useEffect, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { CogBitmapLayer } from '@gisatcz/deckgl-geolib';
import buildDeckGLLayerWithSymbology from '../../layers/factory/buildDeckGLLayerWithSymbology';
import { ARROW_SHAPE_PRESETS } from '../../layers/velocity/arrowShapePresets';
import {
    HOVERED_FEATURE_LINE_COLOR,
    HOVERED_FEATURE_LINE_WIDTH,
    NON_SELECTED_FEATURE_LINE_COLOR,
    NON_SELECTED_FEATURE_LINE_WIDTH,
    SELECTED_FEATURE_LINE_WIDTH
} from '../../layers/velocity/selection';

// const PRECALCULATED_GLAZE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_tabqa_kudairan_cropped_final_glaze_overlay_cog.tif';
const PRECALCULATED_GLAZE_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_tabqa_kudairan_cropped_final_glaze_overlay_z4_bilinear_cog.tif';
const RAW_DEM_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/rasters/glo_30_geoid_Point_tabqa_kudairan_cropped_bilinear_cog.tif';
const LOS_GEOJSON_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/Tabqua_LOS_selected.geojson';

const INITIAL_VIEW_STATE = {
    longitude: 38.5667,
    latitude: 35.8722,
    zoom: 13,
    pitch: 0,
    bearing: 0,
};

/**
 * Whether two features are the same, matching by `id` or `properties.fid`.
 * Used for both selection and hover so the shared border accessors agree.
 */
const sameFeature = (a, b) => {
    if (!a || !b) return false;
    const byId = a.id !== undefined && a.id === b.id;
    const byFid = a.properties?.fid !== undefined && a.properties?.fid === b.properties?.fid;
    return byId || byFid;
};

const TabqaDam = () => {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [glazeMode, setGlazeMode] = useState('precalculated');
    const [arrowShape, setArrowShape] = useState(null);
    const [selectedFeature, setSelectedFeature] = useState(null);
    const [hoveredFeature, setHoveredFeature] = useState(null);
    const [losFeatures, setLosFeatures] = useState([]);

    useEffect(() => {
        let active = true;
        fetch(LOS_GEOJSON_URL)
            .then((response) => response.json())
            .then((collection) => {
                if (active) setLosFeatures(collection?.features ?? []);
            })
            .catch(() => {
                if (active) setLosFeatures([]);
            });
        return () => {
            active = false;
        };
    }, []);

    const basemap = new TileLayer({
        id: 'osm-basemap',
        data: 'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        minZoom: 0,
        maxZoom: 19,
        tileSize: 256,
        renderSubLayers: props => {
            const { bbox: { west, south, east, north } } = props.tile;
            return new BitmapLayer(props, {
                data: null,
                image: props.data,
                bounds: [west, south, east, north],
            });
        },
    });

    const precalculatedGlaze = new CogBitmapLayer({
        id: 'glaze-precalculated',
        rasterData: PRECALCULATED_GLAZE_URL,
        isTiled: true,
        opacity: 0.2,
        cogBitmapOptions: {
            type: 'image',
            useHeatMap: true,
            colorScaleValueRange: [0, 255],
            colorScale: ['#283250', '#283250'],
            // colorScale: ['white', 'black'],
            useDataForOpacity: true,
        },
    });

    const onTheFlyGlaze = new CogBitmapLayer({
        id: 'glaze-onthefly',
        rasterData: RAW_DEM_URL,
        isTiled: true,
        tileSize: 256,
        cogBitmapOptions: {
            type: 'image',
            useReliefGlaze: true,
            noDataValue: 0,
            useChannel: 1,
            swissSlopeWeight: 0.3,
            zFactor: 10,
            maxGlazeAlpha: 80,
        },
    });

    const losLayers = buildDeckGLLayerWithSymbology({
        id: 'tabqua-116a-123d-points',
        features: losFeatures,
        zoom: viewState.zoom,
        arrowShapePresetId: arrowShape,
        // Border color: selected (cyan) takes precedence, then hovered (#ff3c30),
        // then the transparent unselected ring.
        getLineColor: (f) => {
            if (sameFeature(f, selectedFeature)) return [0, 255, 255, 255];
            if (sameFeature(f, hoveredFeature)) return HOVERED_FEATURE_LINE_COLOR;
            return NON_SELECTED_FEATURE_LINE_COLOR;
        },
        // Border width: 3 px when selected/hovered, else the transparent 1 px ring.
        getLineWidth: (f) => {
            if (sameFeature(f, selectedFeature)) return SELECTED_FEATURE_LINE_WIDTH;
            if (sameFeature(f, hoveredFeature)) return HOVERED_FEATURE_LINE_WIDTH;
            return NON_SELECTED_FEATURE_LINE_WIDTH;
        },
        updateTriggers: {
            getLineColor: [selectedFeature, hoveredFeature],
            getLineWidth: [selectedFeature, hoveredFeature]
        }
    });

    const layers = [
        basemap,
        ...(glazeMode === 'precalculated' ? [precalculatedGlaze] : [onTheFlyGlaze]),
        ...losLayers,
    ];

    return (
        <DeckGL
            viewState={viewState}
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            onClick={(info) => setSelectedFeature(info.object || null)}
            onHover={(info) => {
                const next = info.object ?? null;
                setHoveredFeature((prev) => (sameFeature(prev, next) ? prev : next));
            }}
            controller={true}
            layers={layers}
            views={new MapView({ repeat: true })}
            // Set the DeckGL wrapper to fill the screen
            style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}
        >
            {/* UI placed INSIDE DeckGL renders safely on top */}
            <div style={{
                position: 'fixed',
                zIndex: 9999,
                top: 20,
                right: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                pointerEvents: 'auto', // Ensures clicks don't fall through to the map
                fontFamily: 'sans-serif',
                fontSize: 14,
                color: '#333'
            }}>
                <div style={{
                    background: 'white',
                    padding: 15,
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
                }}>
                    <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
                        Glaze Mode
                    </label>
                    <label style={{ display: 'block', marginBottom: 4, cursor: 'pointer' }}>
                        <input
                            type="radio"
                            name="glazeMode"
                            value="precalculated"
                            checked={glazeMode === 'precalculated'}
                            onChange={() => setGlazeMode('precalculated')}
                            style={{ marginRight: 6 }}
                        />
                        Pre-calculated Glaze
                    </label>
                    <label style={{ display: 'block', cursor: 'pointer' }}>
                        <input
                            type="radio"
                            name="glazeMode"
                            value="onthefly"
                            checked={glazeMode === 'onthefly'}
                            onChange={() => setGlazeMode('onthefly')}
                            style={{ marginRight: 6 }}
                        />
                        On-the-fly Glaze
                    </label>
                </div>
                {/* Arrow shape preset toggle for evaluating DynamicArrowLayer geometry */}
                <div style={{
                    background: 'white',
                    padding: 15,
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.3)'
                }}>
                    <label style={{ display: 'block', marginBottom: 8, fontWeight: 'bold' }}>
                        Arrow Shape
                    </label>
                    <label style={{ display: 'block', marginBottom: 4, cursor: 'pointer' }}>
                        <input
                            type="radio"
                            name="arrowShape"
                            value="data"
                            checked={arrowShape === null}
                            onChange={() => setArrowShape(null)}
                            style={{ marginRight: 6 }}
                        />
                        Fill Head (original)
                    </label>
                    {ARROW_SHAPE_PRESETS.map((preset) => (
                        <label
                            key={preset.id}
                            style={{ display: 'block', marginBottom: 4, cursor: 'pointer' }}
                        >
                            <input
                                type="radio"
                                name="arrowShape"
                                value={preset.id}
                                checked={arrowShape === preset.id}
                                onChange={() => setArrowShape(preset.id)}
                                style={{ marginRight: 6 }}
                            />
                            {preset.label}
                        </label>
                    ))}
                </div>
            </div>
        </DeckGL>
    );
};

export default TabqaDam;

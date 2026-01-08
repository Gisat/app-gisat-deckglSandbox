import React, { useState, useCallback } from 'react';
import { DeckGL } from 'deck.gl';
import { MapView, WebMercatorViewport } from '@deck.gl/core';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { COGLayer } from '@developmentseed/deck.gl-geotiff';
import { toProj4 } from 'geotiff-geokeys-to-proj4';
import proj4 from 'proj4';

const INITIAL_VIEW_STATE = {
    longitude: 0,
    latitude: 0,
    zoom: 2,
    bearing: 0,
    pitch: 0,
};

// const COG_URL = 'https://s3.us-east-1.amazonaws.com/ds-deck.gl-raster-public/cog/Annual_NLCD_LndCov_2024_CU_C1V1.tif';
// const COG_URL = 'https://gisat-gis.eu-central-1.linodeobjects.com/esaUtepUnHabitat/rasters/global/GHS-POP/GHS_POP_E2015_COGeoN.tif';
const COG_URL = 'https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_cog/WorldCereals/Indie_cog.tif';

async function geoKeysParser(geoKeys) {
  const projDefinition = toProj4(geoKeys);
  return {
    def: projDefinition.proj4,
    parsed: proj4(projDefinition.proj4),
    coordinatesUnits: 'meters',
  };
}

function CogMap() {
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

    const onCogLoad = useCallback((tiff, options) => {
        const { west, south, east, north } = options.geographicBounds;

        setViewState(currentViewState => {
            const viewport = new WebMercatorViewport({ ...currentViewState, width: window.innerWidth, height: window.innerHeight });
            const newViewState = viewport.fitBounds(
                [
                    [west, south],
                    [east, north],
                ],
                { padding: 40 }
            );
            return {
                ...currentViewState,
                ...newViewState,
            };
        });
    }, []);


    const layers = [
        new TileLayer({
            id: 'base-map',
            data: 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
            minZoom: 0,
            maxZoom: 19,
            tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, {
                    data: null,
                    image: props.data,
                    bounds: [west, south, east, north]
                });
            }
        }),
        new COGLayer({
            id: 'cog-layer',
            geotiff: COG_URL,
            visible: true,
            geoKeysParser,
            onGeoTIFFLoad: onCogLoad,
        })
    ];

    return (
        <DeckGL
            viewState={viewState}
            onViewStateChange={({ viewState }) => setViewState(viewState)}
            controller={true}
            views={new MapView({ repeat: true })}
            layers={layers}
            className="deckgl-map"
        />
    );
}

export default CogMap;

import { useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { LineLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';

import { DynamicArrowLayer } from '../../layers/DynamicArrowLayer';
import { ARROW_REFERENCE_RADIUS_METERS, metersToArrowFraction } from '../../layers/velocity/velocityArrow';

import headFilled from './meshes/arrow_head_filled.obj?url&no-inline';
import headFilledBeveled from './meshes/arrow_head_filled_beveled.obj?url&no-inline';
import headRoundCap from './meshes/arrow_head_round_cap.obj?url&no-inline';
import headRoundCapBeveled from './meshes/arrow_head_round_cap_beveled.obj?url&no-inline';
import headSquareCap from './meshes/arrow_head_square_cap.obj?url&no-inline';
import headSquareCapBeveled from './meshes/arrow_head_square_cap_beveled.obj?url&no-inline';
import headVerticalCut from './meshes/arrow_head_vertical_cut.obj?url&no-inline';
import headVerticalCutBeveled from './meshes/arrow_head_vertical_cut_beveled.obj?url&no-inline';
import singleFilled from './meshes/arrow_single_filled.obj?url&no-inline';
import singleFilledBeveled from './meshes/arrow_single_filled_beveled.obj?url&no-inline';
import singleRoundCap from './meshes/arrow_single_round_cap.obj?url&no-inline';
import singleRoundCapBeveled from './meshes/arrow_single_round_cap_beveled.obj?url&no-inline';
import singleSquareCap from './meshes/arrow_single_square_cap.obj?url&no-inline';
import singleSquareCapBeveled from './meshes/arrow_single_square_cap_beveled.obj?url&no-inline';
import singleVerticalCut from './meshes/arrow_single_vertical_cut.obj?url&no-inline';
import singleVerticalCutBeveled from './meshes/arrow_single_vertical_cut_beveled.obj?url&no-inline';
import stemSharp from './meshes/arrow_tail_unit.obj?url&no-inline';
import stemRounded from './meshes/arrow_tail_unit_rounded.obj?url&no-inline';
import roundCap from './meshes/arrow_tail_round_end_rounded.obj?url&no-inline';

/**
 * 2D shader arrows and 3D split/single meshes side by side.
 *
 * The 2D row is rendered by `DynamicArrowLayer`; the 3D rows by `SimpleMeshLayer`.
 * The columns share one color per type, so the four shapes can be compared across
 * the three representations:
 *
 *   2D fill-head <-> 3D filled head (conceptually)
 *   2D round/square/vertical open-V <-> 3D solid head profiles
 *
 * The 2D shapes use the shader's data-driven stem plus its minimum bare stem.
 * The pen/tail sliders therefore affect the 2D row and the 3D split row; the 3D
 * single row is fixed-proportion and only responds to the pen scale.
 */

const GALLERY_ORIGIN = [38.5667, 35.8722];

const INITIAL_VIEW_STATE = {
    longitude: GALLERY_ORIGIN[0],
    latitude: GALLERY_ORIGIN[1],
    zoom: 19.2,
    pitch: 55,
    bearing: -20
};

const TYPES = [
    { id: 'filled', label: 'Filled' },
    { id: 'round-cap', label: 'Round-cap' },
    { id: 'square-cap', label: 'Square-cap' },
    { id: 'vertical-cut', label: 'Vertical-cut' }
];

const COLORS = {
    filled: [76, 120, 168],
    'round-cap': [245, 133, 24],
    'square-cap': [84, 162, 75],
    'vertical-cut': [178, 121, 162]
};

const HEAD_MESHES = {
    filled: { sharp: headFilled, beveled: headFilledBeveled },
    'round-cap': { sharp: headRoundCap, beveled: headRoundCapBeveled },
    'square-cap': { sharp: headSquareCap, beveled: headSquareCapBeveled },
    'vertical-cut': { sharp: headVerticalCut, beveled: headVerticalCutBeveled }
};

const SINGLE_MESHES = {
    filled: { sharp: singleFilled, beveled: singleFilledBeveled },
    'round-cap': { sharp: singleRoundCap, beveled: singleRoundCapBeveled },
    'square-cap': { sharp: singleSquareCap, beveled: singleSquareCapBeveled },
    'vertical-cut': { sharp: singleVerticalCut, beveled: singleVerticalCutBeveled }
};

const MATERIAL = {
    ambient: 0.45,
    diffuse: 0.75,
    shininess: 64,
    specularColor: [70, 70, 70]
};

// 2D shader constants: head size and width are fixed for the stroked presets;
// the fill-head uses the coherence-driven head shape at its documented minimum.
const STROKED_HEAD_SIZE_METERS = 2.24 * 1.5;
const STROKED_HEAD_WIDTH_METERS = 2 * 2.24 * Math.tan((40 * Math.PI) / 180) * 1.5;
const FILL_HEAD_SIZE_METERS = 6.5;
const FILL_HEAD_WIDTH_METERS = 0.8 * FILL_HEAD_SIZE_METERS;

const ROW_2D_Y = 18;
const ROW_SPLIT_Y = 0;
const ROW_SINGLE_Y = -18;
const COLUMN_SPACING = 18;
const RAISE_METERS = 0.2;

const columnPosition = (index, rowY) => [(index - (TYPES.length - 1) / 2) * COLUMN_SPACING, rowY, RAISE_METERS];

const getTypePosition = (index, rowY) => columnPosition(index, rowY);

const ArrowGallery = () => {
    const [pen, setPen] = useState(1.5);
    const [tail, setTail] = useState(6);
    const [finish, setFinish] = useState('sharp');
    const [tailStyle, setTailStyle] = useState('rounded');
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

    const layers = useMemo(() => {
        const penScale = pen / 1.0;

        const twoDLayers = TYPES.map((type, index) => {
            const isFilled = type.id === 'filled';
            return new DynamicArrowLayer({
                id: `arrow-gallery-2d-${type.id}`,
                data: [{ position: getTypePosition(index, ROW_2D_Y) }],
                shape: type.id,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: GALLERY_ORIGIN,
                getPosition: (d) => d.position,
                getAngle: 0,
                getStemLength: metersToArrowFraction(tail),
                getStemThickness: metersToArrowFraction(isFilled ? Math.max(pen, 1.0) : pen),
                getHeadSize: metersToArrowFraction(isFilled ? FILL_HEAD_SIZE_METERS : STROKED_HEAD_SIZE_METERS),
                getHeadWidth: metersToArrowFraction(isFilled ? FILL_HEAD_WIDTH_METERS : STROKED_HEAD_WIDTH_METERS),
                getRadius: ARROW_REFERENCE_RADIUS_METERS,
                radiusUnits: 'meters',
                getFillColor: COLORS[type.id],
                getLineColor: [0, 0, 0, 0],
                getLineWidth: 0,
                pickable: false,
                updateTriggers: {
                    getStemLength: [tail],
                    getStemThickness: [pen]
                }
            });
        });

        const splitData = TYPES.map((type, index) => ({
            position: getTypePosition(index, ROW_SPLIT_Y),
            color: COLORS[type.id]
        }));

        const stemLayer = new SimpleMeshLayer({
            id: `arrow-gallery-3d-stem-${tailStyle}`,
            data: splitData,
            mesh: tailStyle === 'rounded' ? stemRounded : stemSharp,
            loaders: [OBJLoader],
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getPosition: (d) => d.position,
            getScale: [penScale, penScale, tail],
            getOrientation: [0, 0, 90],
            getColor: (d) => d.color,
            material: MATERIAL,
            pickable: false
        });

        const capLayer =
            tailStyle === 'rounded'
                ? new SimpleMeshLayer({
                      id: 'arrow-gallery-3d-cap-rounded',
                      data: splitData,
                      mesh: roundCap,
                      loaders: [OBJLoader],
                      coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                      coordinateOrigin: GALLERY_ORIGIN,
                      getPosition: (d) => d.position,
                      getScale: [penScale, penScale, penScale],
                      // The cap's dome points rearward, opposite the arrow heading.
                      getOrientation: [0, 180, 90],
                      getColor: (d) => d.color,
                      material: MATERIAL,
                      pickable: false
                  })
                : null;

        const headLayers = TYPES.map(
            (type, index) =>
                new SimpleMeshLayer({
                    id: `arrow-gallery-3d-head-${type.id}-${finish}`,
                    data: [{ position: getTypePosition(index, ROW_SPLIT_Y), color: COLORS[type.id] }],
                    mesh: HEAD_MESHES[type.id][finish],
                    loaders: [OBJLoader],
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: GALLERY_ORIGIN,
                    getPosition: (d) => d.position,
                    getScale: [penScale, penScale, 1],
                    getOrientation: [0, 0, 90],
                    // The head socket sits at the stem tip.
                    getTranslation: [0, tail, 0],
                    getColor: (d) => d.color,
                    material: MATERIAL,
                    pickable: false
                })
        );

        const singleLayers = TYPES.map(
            (type, index) =>
                new SimpleMeshLayer({
                    id: `arrow-gallery-3d-single-${type.id}-${finish}`,
                    data: [{ position: getTypePosition(index, ROW_SINGLE_Y), color: COLORS[type.id] }],
                    mesh: SINGLE_MESHES[type.id][finish],
                    loaders: [OBJLoader],
                    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                    coordinateOrigin: GALLERY_ORIGIN,
                    getPosition: (d) => d.position,
                    getScale: [penScale, penScale, penScale],
                    getOrientation: [0, 0, 90],
                    getColor: (d) => d.color,
                    material: MATERIAL,
                    pickable: false
                })
        );

        const columnLabels = new TextLayer({
            id: 'arrow-gallery-column-labels',
            data: TYPES.map((type, index) => ({
                text: type.label,
                position: getTypePosition(index, 38),
                color: COLORS[type.id]
            })),
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getPosition: (d) => d.position,
            getText: (d) => d.text,
            getColor: (d) => d.color,
            getSize: 15,
            sizeUnits: 'pixels',
            getTextAnchor: 'middle',
            getAlignmentBaseline: 'center',
            fontFamily: 'system-ui, sans-serif',
            fontWeight: 600,
            background: true,
            getBackgroundColor: [255, 255, 255, 220],
            backgroundPadding: [6, 3],
            billboard: true,
            pickable: false
        });

        const gridLines = [];
        for (let x = -40; x <= 40; x += 10) {
            gridLines.push({ source: [x, -30, 0], target: [x, 40, 0] });
        }
        for (let y = -30; y <= 40; y += 10) {
            gridLines.push({ source: [-40, y, 0], target: [40, y, 0] });
        }

        const gridLayer = new LineLayer({
            id: 'arrow-gallery-grid',
            data: gridLines,
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getSourcePosition: (d) => d.source,
            getTargetPosition: (d) => d.target,
            getColor: [175, 188, 188, 170],
            getWidth: 1,
            widthUnits: 'pixels',
            pickable: false
        });

        return [
            gridLayer,
            ...twoDLayers,
            stemLayer,
            ...(capLayer ? [capLayer] : []),
            ...headLayers,
            ...singleLayers,
            columnLabels
        ];
    }, [pen, tail, finish, tailStyle]);

    const sliderStyle = { width: '100%', margin: '2px 0 10px' };
    const buttonStyle = (active) => ({
        padding: '5px 9px',
        marginRight: 6,
        borderRadius: 4,
        border: '1px solid #bbb',
        background: active ? '#1f5f99' : '#fff',
        color: active ? '#fff' : '#222',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400
    });

    return (
        <div style={{ display: 'flex', width: '100%', height: '100%' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 0, background: '#f4f7f6' }}>
                <DeckGL
                    className="deckgl-map"
                    viewState={viewState}
                    onViewStateChange={({ viewState: next }) => setViewState(next)}
                    controller={true}
                    layers={layers}
                />
            </div>
            <aside
                style={{
                    width: 290,
                    background: '#fff',
                    padding: 15,
                    borderLeft: '1px solid #ddd',
                    overflowY: 'auto',
                    fontFamily: 'system-ui, sans-serif',
                    fontSize: 13
                }}
            >
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Arrow Gallery</div>
                <div style={{ fontSize: 11, color: '#555', lineHeight: 1.45, marginBottom: 12 }}>
                    Rows: <b>2D shader</b> · <b>3D split</b> · <b>3D single</b>
                    <br />
                    Columns: <b>Filled</b> · <b>Round-cap</b> · <b>Square-cap</b> · <b>Vertical-cut</b>
                </div>

                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>Pen width: {pen.toFixed(1)} m</label>
                <input
                    type="range"
                    min={0.5}
                    max={2.5}
                    step={0.1}
                    value={pen}
                    onChange={(e) => setPen(Number(e.target.value))}
                    style={sliderStyle}
                />

                <label style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>
                    Tail length: {tail.toFixed(1)} m
                </label>
                <input
                    type="range"
                    min={2}
                    max={8}
                    step={0.5}
                    value={tail}
                    onChange={(e) => setTail(Number(e.target.value))}
                    style={sliderStyle}
                />

                <div style={{ fontWeight: 600, marginBottom: 4 }}>3D finish</div>
                <div style={{ marginBottom: 10 }}>
                    <button type="button" style={buttonStyle(finish === 'sharp')} onClick={() => setFinish('sharp')}>
                        Sharp
                    </button>
                    <button
                        type="button"
                        style={buttonStyle(finish === 'beveled')}
                        onClick={() => setFinish('beveled')}
                    >
                        Beveled
                    </button>
                </div>

                <div style={{ fontWeight: 600, marginBottom: 4 }}>3D tail style</div>
                <div style={{ marginBottom: 10 }}>
                    <button
                        type="button"
                        style={buttonStyle(tailStyle === 'rounded')}
                        onClick={() => setTailStyle('rounded')}
                    >
                        Rod + cap
                    </button>
                    <button
                        type="button"
                        style={buttonStyle(tailStyle === 'sharp')}
                        onClick={() => setTailStyle('sharp')}
                    >
                        Sharp rod
                    </button>
                </div>

                <button type="button" style={{ ...buttonStyle(false), width: '100%' }} onClick={() => setViewState(INITIAL_VIEW_STATE)}>
                    Reset view
                </button>

                <div style={{ marginTop: 10, color: '#666', fontSize: 11, lineHeight: 1.35 }}>
                    The 2D row is shader-rasterized. The 3D split row keeps a fixed head length while pen and tail change;
                    the 3D single row is fixed-proportion. The no-border 2D variant is not shown.
                </div>
            </aside>
        </div>
    );
};

export default ArrowGallery;

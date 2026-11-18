import { useMemo, useState } from 'react';
import DeckGL from '@deck.gl/react';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { LineLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { OBJLoader } from '@loaders.gl/obj';

import { DynamicArrowLayer } from '../../layers/DynamicArrowLayer';
import { ARROW_REFERENCE_RADIUS_METERS, metersToArrowFraction } from '../../layers/velocity/velocityArrow';

import headFilled from './meshes/arrow_head_filled.obj?url&no-inline';
import headFilledBeveled from './meshes/arrow_head_filled_beveled.obj?url&no-inline';
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
 * The 2D row is rendered by `DynamicArrowLayer`; the 3D rows by `SimpleMeshLayer`
 * (the split heads by `SolidPolygonLayer`). The columns share one color per type,
 * so the four shapes can be compared across the three representations:
 *
 *   2D fill-head <-> 3D filled solid head
 *   2D round/square/vertical open-V <-> 3D extruded head profile
 *
 * The 3D split row rebuilds each open-V head from the same 40°/2.24 footprint as
 * the 2D shader, with the arm length fixed and the stroke driven by the pen. That
 * keeps the wing length and angle constant while letting the round, square and
 * vertical-cut endings reproduce their authored geometry. The filled head uses
 * the solid OBJ scaled onto the same equilateral footprint as the 2D fill-head
 * (width equals length), matching the dams app compo-EW pair. The 3D single row
 * is fixed-proportion and responds only to the pen scale.
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

const FILLED_HEAD_MESHES = { sharp: headFilled, beveled: headFilledBeveled };

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

// The solid head meshes are authored at pen 1.0; the 2D stroked head corresponds
// to the 1.5 m reference pen (`2.24 × 1.5`). The filled split head keeps that
// reference footprint; the open-V split heads use that fixed arm length.
const HEAD_REFERENCE_SCALE = 1.5;

// 2D shader constants: head size and width are fixed for the stroked presets;
// the fill-head uses the coherence-driven head shape at its documented minimum.
const STROKED_HEAD_SIZE_METERS = 2.24 * HEAD_REFERENCE_SCALE;
const STROKED_HEAD_WIDTH_METERS = 2 * 2.24 * Math.tan((40 * Math.PI) / 180) * HEAD_REFERENCE_SCALE;

// Filled head, mirroring the dams app compo-EW pair: the 2D head is equilateral
// (head width equals head length) and the 3D `arrow_head_filled.obj` (3.5 wide ×
// 3.0 long) is scaled on X and Z independently onto that same footprint, so both
// rows draw one and the same head shape. The LOS 0.8 width ratio is not used
// here — it makes the 2D triangle noticeably pointier than the 3D mesh.
const ARROW_HEAD_FILLED_DIAMETER = 3.5;
const ARROW_HEAD_FILLED_HEIGHT = 3.0;
const FILLED_HEAD_SIZE_METERS = ARROW_HEAD_FILLED_DIAMETER * HEAD_REFERENCE_SCALE;
const FILLED_HEAD_WIDTH_METERS = FILLED_HEAD_SIZE_METERS;

// The open-V split heads are extruded from the same 40 degree / 2.24 x pen
// footprint as the 2D shader: the along-axis head size is fixed at the reference
// pen and the stroke is the live pen, so the wings keep their length, angle and
// style endings while the stroke thickens.
const HEAD_SIZE_METERS = 2.24 * HEAD_REFERENCE_SCALE;
const HEAD_ANGLE_DEG = 40;
const HEAD_THETA = (HEAD_ANGLE_DEG * Math.PI) / 180;
const HEAD_SIN = Math.sin(HEAD_THETA);
const HEAD_COS = Math.cos(HEAD_THETA);
const HEAD_HALF_WIDTH_METERS = HEAD_SIZE_METERS * Math.tan(HEAD_THETA);
const HEAD_ARC_SEGMENTS = 8;

/**
 * Build the plan-view outline of a split head, socket at (0, 0), +y forward.
 *
 * Ports the generator's round/square/vertical profiles to metres so the gallery
 * can rebuild the head for the live pen: the arm length stays fixed and only the
 * stroke (`pen`) changes. The returned y values may be negative at the rear wing
 * overhang, matching the authored OBJ meshes.
 *
 * @param {string} style - `round-cap`, `square-cap` or `vertical-cut`.
 * @param {number} pen - Pen width in metres.
 * @returns {number[][]} Closed outline points in metres.
 */
const headProfile = (style, pen) => {
    const halfPen = pen / 2;
    const tInner = (halfPen * (1 + HEAD_COS)) / HEAD_SIN;
    const yInner = -halfPen * HEAD_SIN - tInner * HEAD_COS;
    const miter = halfPen / HEAD_SIN;
    let poly;

    if (style === 'round-cap') {
        poly = [
            [-halfPen, yInner],
            [halfPen, yInner]
        ];

        const rightCy = -HEAD_SIZE_METERS;
        for (let i = 0; i <= HEAD_ARC_SEGMENTS; i += 1) {
            const angle = ((220 + (180 * i) / HEAD_ARC_SEGMENTS) * Math.PI) / 180;
            poly.push([
                HEAD_HALF_WIDTH_METERS + halfPen * Math.cos(angle),
                rightCy + halfPen * Math.sin(angle)
            ]);
        }
        for (let i = 1; i < HEAD_ARC_SEGMENTS; i += 1) {
            const angle = ((40 + (100 * i) / HEAD_ARC_SEGMENTS) * Math.PI) / 180;
            poly.push([halfPen * Math.cos(angle), halfPen * Math.sin(angle)]);
        }

        const leftCy = -HEAD_SIZE_METERS;
        for (let i = 0; i <= HEAD_ARC_SEGMENTS; i += 1) {
            const angle = ((140 + (180 * i) / HEAD_ARC_SEGMENTS) * Math.PI) / 180;
            poly.push([
                -HEAD_HALF_WIDTH_METERS + halfPen * Math.cos(angle),
                leftCy + halfPen * Math.sin(angle)
            ]);
        }
    } else if (style === 'square-cap') {
        const rxOuter = HEAD_HALF_WIDTH_METERS + halfPen * HEAD_COS;
        const ryOuter = -HEAD_SIZE_METERS + halfPen * HEAD_SIN;
        const rxInner = HEAD_HALF_WIDTH_METERS - halfPen * HEAD_COS;
        const ryInner = -HEAD_SIZE_METERS - halfPen * HEAD_SIN;
        poly = [
            [-halfPen, yInner],
            [halfPen, yInner],
            [rxInner, ryInner],
            [rxOuter, ryOuter],
            [0, miter],
            [-rxOuter, ryOuter],
            [-rxInner, ryInner]
        ];
    } else {
        const tOuter = (HEAD_HALF_WIDTH_METERS - halfPen * HEAD_COS) / HEAD_SIN;
        const yOuter = halfPen * HEAD_SIN - tOuter * HEAD_COS;
        const tIn = (HEAD_HALF_WIDTH_METERS + halfPen * HEAD_COS) / HEAD_SIN;
        const yIn = -halfPen * HEAD_SIN - tIn * HEAD_COS;
        poly = [
            [-halfPen, yInner],
            [halfPen, yInner],
            [HEAD_HALF_WIDTH_METERS, yIn],
            [HEAD_HALF_WIDTH_METERS, yOuter],
            [0, miter],
            [-HEAD_HALF_WIDTH_METERS, yOuter],
            [-HEAD_HALF_WIDTH_METERS, yIn]
        ];
    }

    return poly.map(([x, y]) => [x, y - yInner]);
};

const ROW_2D_Y = 18;
const ROW_SPLIT_Y = 0;
const ROW_SINGLE_Y = -18;
const COLUMN_SPACING = 14;
const RAISE_METERS = 0.2;

const columnPosition = (index, rowY) => [(index - (TYPES.length - 1) / 2) * COLUMN_SPACING, rowY, RAISE_METERS];

const getTypePosition = (index, rowY) => columnPosition(index, rowY);

const ROWS = [
    { id: '2d', label: '2D shader', y: ROW_2D_Y },
    { id: 'split', label: '3D split', y: ROW_SPLIT_Y },
    { id: 'single', label: '3D single', y: ROW_SINGLE_Y }
];

// Right edge of the row labels, held clear of the first type column.
const ROW_LABEL_X = -((TYPES.length - 1) / 2) * COLUMN_SPACING - 8;

const ArrowGallery = () => {
    const [pen, setPen] = useState(1.5);
    const [tail, setTail] = useState(6);
    const [finish, setFinish] = useState('sharp');
    const [tailStyle, setTailStyle] = useState('custom');
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);

    const layers = useMemo(() => {
        const penScale = pen / 1.0;

        const twoDLayers = TYPES.map((type, index) => {
            const isFilled = type.id === 'filled';
            // The shader's filled shape id is `fill-head`, not the column id
            // `filled`; passing the latter would fall through to the stroked
            // branch and rasterize an open-V instead of the filled head.
            const shape = isFilled ? 'fill-head' : type.id;
            // The shader adds the stroked shapes' minimum bare stem (pen + wing
            // sweep + cap radius) on top of the data stem. Feed that reserve back
            // out and allow for the 3D head's rear overhang, so the visible bare
            // tail matches the 3D split/single rows instead of reading longer.
            const overhangMeters = isFilled ? 0 : Math.min(...headProfile(type.id, pen).map(([, y]) => y));
            const dataStemMeters = isFilled ? tail : tail + overhangMeters - pen;
            return new DynamicArrowLayer({
                id: `arrow-gallery-2d-${type.id}`,
                data: [{ position: getTypePosition(index, ROW_2D_Y) }],
                shape,
                coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
                coordinateOrigin: GALLERY_ORIGIN,
                getPosition: (d) => d.position,
                getAngle: 0,
                getStemLength: metersToArrowFraction(dataStemMeters),
                getStemThickness: metersToArrowFraction(isFilled ? Math.max(pen, 1.0) : pen),
                getHeadSize: metersToArrowFraction(isFilled ? FILLED_HEAD_SIZE_METERS : STROKED_HEAD_SIZE_METERS),
                getHeadWidth: metersToArrowFraction(isFilled ? FILLED_HEAD_WIDTH_METERS : STROKED_HEAD_WIDTH_METERS),
                getRadius: ARROW_REFERENCE_RADIUS_METERS,
                radiusUnits: 'meters',
                getFillColor: COLORS[type.id],
                getLineColor: [0, 0, 0, 0],
                getLineWidth: 0,
                pickable: false,
                updateTriggers: {
                    getStemLength: [tail, pen],
                    getStemThickness: [pen]
                }
            });
        });

        const splitData = TYPES.map((type, index) => ({
            type,
            position: getTypePosition(index, ROW_SPLIT_Y),
            color: COLORS[type.id]
        }));

        // Default is the mixed mode: sharp stems everywhere except the round-cap,
        // which keeps the rounded rear cap. The other modes apply to all columns.
        const stemStyleFor = (type) =>
            tailStyle === 'custom' ? (type.id === 'round-cap' ? 'rounded' : 'sharp') : tailStyle;
        const roundedStems = splitData.filter((d) => stemStyleFor(d.type) === 'rounded');
        const sharpStems = splitData.filter((d) => stemStyleFor(d.type) === 'sharp');

        const makeStemLayer = (id, data, mesh) =>
            new SimpleMeshLayer({
                id,
                data,
                mesh,
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

        const stemLayers = [
            makeStemLayer(`arrow-gallery-3d-stem-rounded-${tailStyle}`, roundedStems, stemRounded),
            makeStemLayer(`arrow-gallery-3d-stem-sharp-${tailStyle}`, sharpStems, stemSharp)
        ];

        const capLayer = roundedStems.length
            ? new SimpleMeshLayer({
                  id: `arrow-gallery-3d-caps-${tailStyle}`,
                  data: roundedStems,
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

        const filledHeadLayer = new SimpleMeshLayer({
            id: `arrow-gallery-3d-head-filled-${finish}`,
            data: [{ position: getTypePosition(0, ROW_SPLIT_Y), color: COLORS.filled }],
            mesh: FILLED_HEAD_MESHES[finish],
            loaders: [OBJLoader],
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getPosition: (d) => d.position,
            // Scale X and Z independently so the filled mesh lands on the same
            // equilateral footprint as the 2D fill-head (the dams app compo-EW
            // pair); Y follows the live pen like the stem.
            getScale: [
                FILLED_HEAD_WIDTH_METERS / ARROW_HEAD_FILLED_DIAMETER,
                penScale,
                FILLED_HEAD_SIZE_METERS / ARROW_HEAD_FILLED_HEIGHT
            ],
            getOrientation: [0, 0, 90],
            // The head socket sits at the stem tip.
            getTranslation: [0, tail, 0],
            getColor: (d) => d.color,
            material: MATERIAL,
            pickable: false
        });

        // Open-V split heads are extruded from the live pen profile, so each style
        // keeps its round/square/vertical endings while the stroke changes.
        const headThickness = 0.8 * pen;
        const headBaseZ = RAISE_METERS - headThickness / 2;
        const strokedHeads = TYPES.map((type, index) => ({
            ...type,
            position: getTypePosition(index, ROW_SPLIT_Y)
        })).filter((type) => type.id !== 'filled');

        const headLayer = new SolidPolygonLayer({
            id: 'arrow-gallery-3d-heads',
            data: strokedHeads,
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            extruded: true,
            filled: true,
            getPolygon: (d) =>
                headProfile(d.id, pen).map(([x, y]) => [
                    d.position[0] + x,
                    d.position[1] + tail + y,
                    headBaseZ
                ]),
            getElevation: headThickness,
            getFillColor: (d) => COLORS[d.id],
            updateTriggers: {
                getPolygon: [pen, tail],
                getElevation: [pen]
            },
            material: MATERIAL,
            pickable: false
        });

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

        const rowLabels = new TextLayer({
            id: 'arrow-gallery-row-labels',
            data: ROWS.map((row) => ({
                text: row.label,
                position: [ROW_LABEL_X, row.y, RAISE_METERS]
            })),
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getPosition: (d) => d.position,
            getText: (d) => d.text,
            getColor: [85, 85, 85],
            getSize: 15,
            sizeUnits: 'pixels',
            getTextAnchor: 'end',
            getAlignmentBaseline: 'center',
            fontFamily: 'system-ui, sans-serif',
            fontWeight: 600,
            background: true,
            getBackgroundColor: [255, 255, 255, 220],
            backgroundPadding: [6, 3],
            billboard: true,
            pickable: false
        });

        const columnLabels = new TextLayer({
            id: 'arrow-gallery-column-labels',
            data: TYPES.map((type, index) => ({
                text: type.label,
                position: getTypePosition(index, 38),
                color: COLORS[type.id],
                anchor: index === TYPES.length - 1 ? 'end' : 'middle'
            })),
            coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
            coordinateOrigin: GALLERY_ORIGIN,
            getPosition: (d) => d.position,
            getText: (d) => d.text,
            getColor: (d) => d.color,
            getSize: 15,
            sizeUnits: 'pixels',
            getTextAnchor: (d) => d.anchor,
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
            ...stemLayers,
            ...(capLayer ? [capLayer] : []),
            filledHeadLayer,
            headLayer,
            ...singleLayers,
            rowLabels,
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
                    width: 270,
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

                <div style={{ fontWeight: 600, marginBottom: 4 }}>3D finish (filled + single)</div>
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

                <div style={{ fontWeight: 600, marginBottom: 4 }}>3D stem style (split row only)</div>
                <div style={{ marginBottom: 10 }}>
                    <button
                        type="button"
                        style={buttonStyle(tailStyle === 'custom')}
                        onClick={() => setTailStyle('custom')}
                    >
                        Default
                    </button>
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
                    The 2D row is shader-rasterized. The filled 2D and 3D split heads share the compo-EW equilateral
                    footprint (head width equals head length). The 3D open-V split heads are rebuilt from the fixed 40°
                    footprint for the live pen, so each keeps its round/square/vertical endings while the stroke
                    thickens. Stem style Default uses the round rear cap only for the round-cap column; Rod + cap and
                    Sharp rod apply to every split column. The stem style affects only the 3D split row; the 3D single
                    row is fixed-proportion. The exact split-head OBJs are attached in the docs. The no-border 2D
                    variant is not shown.
                </div>
            </aside>
        </div>
    );
};

export default ArrowGallery;

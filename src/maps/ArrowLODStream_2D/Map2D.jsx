import { useEffect, useState, useRef, useMemo } from 'react';
import { DeckGL, WebMercatorViewport, FlyToInterpolator } from 'deck.gl';
import { TileLayer } from '@deck.gl/geo-layers';
import {
    ScatterplotLayer,
    BitmapLayer,
    PolygonLayer,
    LineLayer,
    TextLayer
} from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';

import { HUD } from '../../components/HUD';
import { PlaybackControls } from '../../components/PlaybackControls';
import { SelectionAnalysisPanel, filterPointsByGeometryInBounds, normalizeGeometry } from '../../components/PointSelection';
import { calculateProfileData } from '../../components/2DLineProfile';
import ArrowLODTileLayer from '../../layers/ArrowLODTileLayer';
import { DynamicArrowLayer } from '../../layers/DynamicArrowLayer';
import { getLodTier } from '../../layers/lodTiers';
import { cartoLightBasemapUrl } from '../basemaps';
import { SymbolModeToggle } from '../../components/MapSymbols/SymbolModeToggle';
import { ColorScaleLegend } from '../../components/MapSymbols/ColorScaleLegend';
import { LegendOverlay } from '../../components/MapSymbols/LegendOverlay';
import { COLOR_DOMAIN, colorScale } from '../../layers/displacementScale';
import { DISPLACEMENT_SYMBOL_MATERIAL } from '../../layers/displacementMaterial';
import { getAllRowIndices, getSymbolRowSplit } from '../../layers/symbolRows';
import { getArrowHeading } from '../../layers/velocity/displacementSymbols';
import {
    ARROW_HEAD_SIZE,
    ARROW_HEAD_WIDTH,
    ARROW_STEM_THICKNESS,
    getArrowRadiusPixels,
    getArrowStemLengthFraction
} from './arrowPixelSymbols';
import { SnakeViewControls } from './SnakeViewControls';
import ZClipExtension from './ZClipExtension';
import {
    ANIMATION_DURATION_MS,
    MAX_TUBES,
    SAMPLE_COUNT,
    buildSnakeMesh,
    buildSnakeSeries,
    computeSelectionStats,
    projectDisplacement
} from './snakeGeometry';
import {
    buildSlicePoints,
    buildSliceRing,
    buildTimeAxis
} from './snakeSliceGeometry';

// --- Configuration ---
const INITIAL_VIEW_STATE = { longitude: 14.44, latitude: 50.05, zoom: 12, pitch: 0, bearing: 0 };
const BACKEND_BASE_URL = window.BACKEND_API_URL || 'http://localhost:5000';
const DATES_API_URL = `${BACKEND_BASE_URL}/api/dates`;
const DATA_API_URL = `${BACKEND_BASE_URL}/api/data`;

// 🛑 MUST MATCH 'generate_virtual_tiles.py'
const TILE_CACHE_LIMIT = 200;

const SNAKE_BASE_MARKER_ID = 'snake-base-markers';
const SNAKE_AXIS_STEM_ID = 'snake-time-axis-stem';
const SNAKE_AXIS_HITS_ID = 'snake-time-axis-hits';

const SELECTION_METRICS = [
    'mean_velocity',
    'mean_velocity_std',
    'height',
    'temporal_coherence',
    'los_east',
    'los_north',
    'los_up',
    'incidence_angle',
    'track_angle'
];

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

// 🆕 Point Size Logic
function getPointSize(zoom) {
    const tier = getLodTier(zoom);
    if (tier === 2) return 5; // Tier 2 (Detail)
    if (tier === 1) return 3; // Tier 1 (Mid)
    return 2;                 // Tier 0 (Overview)
}

// Arrow mode splits each tile into small-displacement points (circles) and
// moving points (arrows) using the CURRENT displayed displacement, so the
// symbols change with the timeline. The split and its signature cache are
// shared with the 3D map (see layers/symbolRows.js) so the two maps cannot
// drift.

// One circle renderer shared by circle mode and the arrow mode's near-zero
// points, so radius/border/triggers cannot drift between the two branches.
function buildDisplacementCircleLayer({
    id,
    data,
    zoom,
    mode,
    debouncedTimeIndex,
    selectedPointIds,
    hoveredPointId,
    getPosition,
    getFillColor,
    pickable = true,
    updateTriggers
}) {
    return new ScatterplotLayer({
        id,
        data,
        getPosition,
        getRadius: getPointSize(zoom),
        radiusUnits: 'pixels',
        getFillColor,
        // Same 1 px transparent-black rim as the arrows.
        stroked: true,
        filled: true,
        getLineColor: [0, 0, 0, 0],
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        updateTriggers: updateTriggers ?? {
            getFillColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
            getPosition: [mode],
        },
        transitions: {
            getFillColor: 0
        },
        pickable
    });
}

function formatMm(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)} mm` : '—';
}

function formatCoherence(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function formatDegrees(value) {
    return Number.isFinite(value) ? `${value.toFixed(1)}°` : '—';
}

// In 3D mode the remaining unselected points are drawn dim on the ground. The
// filtered row-index list is cached per raw Arrow table + selection object, so
// camera tilt/orbit animation frames reuse the same array instead of
// re-allocating and re-filtering every frame.
const unselectedRowIndexCache = new WeakMap();

// Stable accessor identity so deck.gl does not rebuild colours every frame.
const UNSELECTED_GROUND_FILL = () => [200, 200, 200, 100];

function getUnselectedRowIndices(tableData, selectedPointIds) {
    const cached = unselectedRowIndexCache.get(tableData.arrowTable);
    if (cached && cached.selectedPointIds === selectedPointIds) return cached.rows;

    const rows = [];
    for (let i = 0; i < tableData.numRows; i++) {
        if (!selectedPointIds.has(tableData.getPointId(i))) rows.push(i);
    }
    unselectedRowIndexCache.set(tableData.arrowTable, { selectedPointIds, rows });
    return rows;
}

// Arrow/circle split of the remaining unselected rows, shared with the 2D
// classification so the two views cannot drift. Cached per Arrow table +
// selection + split signature, reusing the filtered arrays while the
// classification is unchanged.
const unselectedSymbolCache = new WeakMap();

function getUnselectedSymbolRowSplit(tableData, mode, timeIndex, selectedPointIds) {
    const split = getSymbolRowSplit(tableData, mode, timeIndex);
    const cached = unselectedSymbolCache.get(tableData.arrowTable);
    if (cached
        && cached.selectedPointIds === selectedPointIds
        && cached.signature === split.signature) {
        return cached;
    }

    const arrowRows = [];
    for (const rowIndex of split.arrowRows) {
        if (!selectedPointIds.has(tableData.getPointId(rowIndex))) arrowRows.push(rowIndex);
    }
    const circleRows = [];
    for (const rowIndex of split.circleRows) {
        if (!selectedPointIds.has(tableData.getPointId(rowIndex))) circleRows.push(rowIndex);
    }

    const result = { selectedPointIds, signature: split.signature, arrowRows, circleRows };
    unselectedSymbolCache.set(tableData.arrowTable, result);
    return result;
}

function ArrowLODStream2D() {
    const [totalPoints, setTotalPoints] = useState(0);
    const [cacheSize, setCacheSize] = useState(0);
    const [dates, setDates] = useState([]);
    const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
    const [timeIndex, setTimeIndex] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [fetchStatus, setFetchStatus] = useState("Idle");

    // Derive currentTierDisplay from viewState.zoom (not from state)
    const currentTierDisplay = (() => {
        const t = getLodTier(viewState.zoom);
        const percentages = ['5%', '35%', '100%'];
        return `${t} (${percentages[t]})`;
    })();

    const [mode, setMode] = useState('static');
    const [isPlaying, setIsPlaying] = useState(false);
    // 'circle' keeps the existing look; 'arrow' renders the same points as
    // round-cap shader arrows. Both modes share the one cached dataset.
    const [symbolMode, setSymbolMode] = useState('circle');

    // Selection state
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [debouncedBufferDistance, setDebouncedBufferDistance] = useState(100);
    const [selectedPointIds, setSelectedPointIds] = useState(new Set());  // Point IDs (pid column)
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedFeatures, setSelectedFeatures] = useState(null); // Backend response with time-series data
    const [isSelectingBackend, setIsSelectingBackend] = useState(false);
    const [hoveredPointId, setHoveredPointId] = useState(null);
    const [drawnLineCoords, setDrawnLineCoords] = useState(null);

    // Time-snake (3D) state
    const [snakeActive, setSnakeActive] = useState(false);
    const [selectionCommitted, setSelectionCommitted] = useState(false);
    const [showSlicePlane, setShowSlicePlane] = useState(true);
    const [smoothDays, setSmoothDays] = useState(45);
    const [timeScale, setTimeScale] = useState(1);
    const [leanScale, setLeanScale] = useState(1);
    const [thicknessScale, setThicknessScale] = useState(1);
    const [widthByCoherence, setWidthByCoherence] = useState(true);
    const [flipLean, setFlipLean] = useState(false);
    // 'los' shows the measured slant-range LOS; 'vertical' divides by los_up
    // to show the vertical-equivalent ground motion.
    const [projectionMode, setProjectionMode] = useState('los');
    const [animProgress, setAnimProgress] = useState(0);
    const [refitToken, setRefitToken] = useState(0);
    const [hoveredSliceU, setHoveredSliceU] = useState(null);

    const mapContainerRef = useRef(null);
    const savedViewRef = useRef(null);
    const selectionRequestIdRef = useRef(0);
    const animProgressRef = useRef(0);
    // Track when geometry was last processed to avoid re-filtering every frame
    const lastProcessedGeometryRef = useRef(null);

    // ------------------------------------------------------------------
    // Selection: data flow
    // ------------------------------------------------------------------

    // Handle geometry completion from drawing overlay
    const handleGeometryComplete = (geometry, mode, coords) => {
        if (!geometry) return;

        // Keep the tilted view and the old snakes visible while the next
        // selection is being drawn; only the commit flag is reset.
        if (!snakeActive) {
            savedViewRef.current = {
                ...viewState,
                transitionDuration: 0,
                transitionInterpolator: undefined
            };
        }

        setDrawnGeometry(geometry);
        setIsDrawing(false);
        setSelectedPointIds(new Set());
        setSelectedFeatures(null);
        setSelectionCommitted(false);
        setHoveredSliceU(null);
        setHoveredPointId(null);
        animProgressRef.current = 0;
        setAnimProgress(0);
        lastProcessedGeometryRef.current = null;
        setSnakeActive(true);

        if (mode === 'line') {
            setDrawnLineCoords(coords);
        } else {
            setDrawnLineCoords(null);
        }
    };

    // Send selected point IDs to backend for time-series data
    const queryBackendForSelection = (pointIds, metrics = []) => {
        if (!pointIds || pointIds.length === 0) return;

        const requestId = selectionRequestIdRef.current + 1;
        selectionRequestIdRef.current = requestId;
        setIsSelectingBackend(true);

        const payload = {
            point_ids: Array.from(pointIds),
            metrics: metrics,
        };

        fetch(`${DATA_API_URL.replace('/api/data', '')}/api/select`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
            .then(res => res.json())
            .then(data => {
                // Ignore stale responses from a previous drawing.
                if (selectionRequestIdRef.current !== requestId) return;
                setSelectedFeatures(data);
            })
            .catch(err => {
                if (selectionRequestIdRef.current !== requestId) return;
                console.error('❌ Backend selection error:', err);
                setSelectedFeatures(null);
            })
            .finally(() => {
                if (selectionRequestIdRef.current !== requestId) return;
                setIsSelectingBackend(false);
            });
    };

    // When selected point IDs change, query backend
    useEffect(() => {
        if (selectedPointIds.size > 0) {
            queryBackendForSelection(selectedPointIds, SELECTION_METRICS);
        } else {
            setSelectedFeatures(null);
        }
    }, [selectedPointIds]);

    const profileData = useMemo(() => {
        if (selectionMode === 'line' && selectedFeatures && drawnLineCoords) {
            return calculateProfileData(selectedFeatures, drawnLineCoords, ['mean_velocity', 'mean_velocity_std']);
        }
        return null;
    }, [selectedFeatures, drawnLineCoords, selectionMode]);

    // ------------------------------------------------------------------
    // Time-snake derived data
    // ------------------------------------------------------------------

    const selectionStats = useMemo(
        () => computeSelectionStats(selectedFeatures?.features ?? []),
        [selectedFeatures]
    );

    const snakeSeries = useMemo(() => {
        if (!snakeActive || !selectedFeatures?.features?.length) {
            return { tubes: [], totalFeatures: 0, usedFeatures: 0, timeRange: null };
        }
        return buildSnakeSeries(selectedFeatures.features, {
            smoothDays,
            samples: SAMPLE_COUNT,
            maxTubes: MAX_TUBES,
            timeRange: selectionStats.timeRange
        });
    }, [snakeActive, selectedFeatures, smoothDays, selectionStats.timeRange]);

    const suggestedTimeHeightM = selectionStats.suggestedTimeHeightM;
    const suggestedLeanMPerMm = selectionStats.suggestedLeanMPerMm;
    const timeHeightM = suggestedTimeHeightM * timeScale;
    const leanMPerMm = suggestedLeanMPerMm * leanScale;
    const radiusBaseM = selectionStats.suggestedRadiusM * thicknessScale;

    const snake = useMemo(() => {
        if (!snakeActive || snakeSeries.tubes.length === 0 || !snakeSeries.timeRange) {
            return { origin: null, mesh: null };
        }
        return buildSnakeMesh(snakeSeries.tubes, {
            timeRange: snakeSeries.timeRange,
            timeHeightM,
            leanMPerMm,
            widthByCoherence,
            radiusBaseM,
            flipLean,
            projectionMode
        });
    }, [
        snakeActive,
        snakeSeries,
        timeHeightM,
        leanMPerMm,
        widthByCoherence,
        radiusBaseM,
        flipLean,
        projectionMode
    ]);

    const baseMarkers = useMemo(() => {
        const seen = new Set();
        const markers = [];
        for (const tube of snakeSeries.tubes) {
            const key = String(tube.pointId ?? `${tube.lon},${tube.lat}`);
            if (seen.has(key)) continue;
            seen.add(key);
            markers.push({
                pointId: tube.pointId,
                lon: tube.lon,
                lat: tube.lat,
                lastLosMm: tube.lastValueMm,
                lastVertMm: Number.isFinite(tube.lastValueMm)
                    ? projectDisplacement(tube.lastValueMm, tube.losUp, 'vertical')
                    : null,
                coherence: tube.coherence,
                incidenceAngle: tube.incidenceAngle
            });
        }
        return markers;
    }, [snakeSeries]);

    const bearingDeg = useMemo(() => (
        Number.isFinite(selectionStats.meanLosBearingDeg)
            ? selectionStats.meanLosBearingDeg - 90
            : 0
    ), [selectionStats]);

    const axis = useMemo(() => {
        if (!snakeActive || !selectionCommitted) return null;
        if (!selectionStats.bounds || !snakeSeries.timeRange) return null;
        // Calendar axis rides the Time-height control:
        // 0.5× → years only, 1× and 2× → years + quarters.
        const labelGranularity = timeScale <= 0.5 ? 'year' : 'quarter';
        return buildTimeAxis(
            selectionStats.bounds,
            snakeSeries.timeRange,
            timeHeightM,
            {
                marginM: Math.max(4, 0.05 * selectionStats.spanM),
                bearingDeg: viewState.bearing ?? bearingDeg,
                labelGranularity
            }
        );
    }, [
        snakeActive,
        selectionCommitted,
        selectionStats,
        snakeSeries.timeRange,
        timeHeightM,
        timeScale,
        bearingDeg,
        viewState.bearing
    ]);

    const dateMsList = useMemo(
        () => dates.map(date => {
            const ms = Date.parse(`${date}T00:00:00Z`);
            return Number.isFinite(ms) ? ms : NaN;
        }),
        [dates]
    );

    // Static slice height from the slider date. The tubes are linear in real
    // time, so map the acquisition date to a time fraction (not the sample
    // index, which drifts when acquisitions are irregular).
    const sliderSliceU = (() => {
        const range = snakeSeries.timeRange;
        if (!range || dates.length === 0) {
            return dates.length > 1 ? timeIndex / (dates.length - 1) : 0;
        }
        const dateMs = dateMsList[timeIndex];
        if (!Number.isFinite(dateMs)) return 0;
        return clamp01((dateMs - range.startMs) / Math.max(1, range.endMs - range.startMs));
    })();

    let sliceU = null;
    if (mode === 'animation') {
        sliceU = animProgress;
    } else if (hoveredSliceU != null) {
        sliceU = hoveredSliceU;
    } else if (showSlicePlane) {
        sliceU = sliderSliceU;
    }

    const activeSliceU = sliceU != null ? sliceU : animProgress;

    const sliceGeometry = useMemo(() => {
        if (!snakeActive || !selectionCommitted || sliceU == null) {
            return { ring: null, points: [] };
        }
        return {
            ring: buildSliceRing(drawnGeometry, sliceU, timeHeightM),
            points: buildSlicePoints(
                snakeSeries.tubes,
                sliceU,
                timeHeightM,
                leanMPerMm,
                flipLean,
                projectionMode
            )
        };
    }, [
        snakeActive,
        selectionCommitted,
        sliceU,
        drawnGeometry,
        snakeSeries,
        timeHeightM,
        leanMPerMm,
        flipLean,
        projectionMode
    ]);

    const timestepCount = useMemo(() => {
        let max = 0;
        for (const feature of selectedFeatures?.features ?? []) {
            const count = feature?.properties?.dates?.length ?? 0;
            if (count > max) max = count;
        }
        return max;
    }, [selectedFeatures]);

    const nearestTickIndex = useMemo(() => {
        if (!axis || activeSliceU == null) return -1;
        let best = -1;
        let bestDistance = Infinity;
        axis.ticks.forEach((tick, index) => {
            const distance = Math.abs(tick.u - activeSliceU);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        });
        return best;
    }, [axis, activeSliceU]);

    const zClipExtension = useMemo(() => new ZClipExtension(), []);

    // ------------------------------------------------------------------
    // Effects: dates, playback, camera, commit
    // ------------------------------------------------------------------

    // 1. Fetch Dates
    useEffect(() => {
        fetch(DATES_API_URL)
            .then(res => res.json())
            .then(d => setDates(d))
            .catch(console.error);
    }, []);

    // 2. Animation Loop (2D). Disabled while the snake clock drives time.
    useEffect(() => {
        let interval;
        if (mode === 'animation' && isPlaying && dates.length > 0 && !snakeActive) {
            interval = setInterval(() => {
                setTimeIndex(prev => (prev >= dates.length - 1 ? 0 : prev + 1));
            }, 100);
        }
        return () => clearInterval(interval);
    }, [isPlaying, dates, mode, snakeActive]);

    // 2b. Time-snake clock: one rAF drives both the z-clip and the slice.
    useEffect(() => {
        if (!snakeActive || mode !== 'animation' || !isPlaying) return undefined;

        let rafId;
        const start = performance.now() - animProgressRef.current * ANIMATION_DURATION_MS;

        const tick = (now) => {
            const p = (((now - start) % ANIMATION_DURATION_MS) + ANIMATION_DURATION_MS)
                % ANIMATION_DURATION_MS / ANIMATION_DURATION_MS;
            animProgressRef.current = p;
            setAnimProgress(p);

            // Pick the acquisition closest to the clip's real time, not the
            // sample-index fraction: z and the date readout must agree even
            // when acquisition intervals are irregular.
            const range = snakeSeries.timeRange;
            let index = -1;
            if (range && dateMsList.length > 0) {
                const targetMs = range.startMs
                    + p * Math.max(1, range.endMs - range.startMs);
                let bestDistance = Infinity;
                for (let i = 0; i < dateMsList.length; i++) {
                    const dateMs = dateMsList[i];
                    if (!Number.isFinite(dateMs)) continue;
                    const distance = Math.abs(dateMs - targetMs);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        index = i;
                    }
                }
            }
            if (index < 0 && dates.length > 1) {
                index = Math.round(p * (dates.length - 1));
            }
            if (index >= 0) {
                setTimeIndex(prev => (prev === index ? prev : index));
            }

            rafId = requestAnimationFrame(tick);
        };

        rafId = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafId);
    }, [snakeActive, mode, isPlaying, dates.length, dateMsList, snakeSeries.timeRange]);

    // 2c. While paused (or in static mode), the clip/slice follows the slider
    // date on the real-time axis, so irregular acquisition intervals do not
    // drift from the Z-axis ticks.
    useEffect(() => {
        if (!snakeActive) return;
        if (mode === 'animation' && isPlaying) return;
        animProgressRef.current = sliderSliceU;
        setAnimProgress(sliderSliceU);
    }, [snakeActive, mode, isPlaying, sliderSliceU]);

    // Commit the new selection once its features have arrived AND at least one
    // renderable tube exists. Committing with zero tubes would hide the 2D
    // points and tilt to an empty scene (all-null series, a single date, etc.).
    useEffect(() => {
        if (!snakeActive || selectionCommitted) return;
        const features = selectedFeatures?.features;
        if (!features || features.length === 0) return;
        if (snakeSeries.tubes.length === 0) return;

        setSelectionCommitted(true);
        setTimeScale(1);
        setLeanScale(1);
        setThicknessScale(1);
        setTimeIndex(0);
        animProgressRef.current = 0;
        setAnimProgress(0);
    }, [snakeActive, selectionCommitted, selectedFeatures, snakeSeries]);

    // Entry / refit camera. One bearing drives both the camera and the axis.
    useEffect(() => {
        if (!snakeActive || !selectionCommitted) return;
        if (!selectionStats.bounds) return;

        const width = mapContainerRef.current?.clientWidth || window.innerWidth || 800;
        const height = mapContainerRef.current?.clientHeight || window.innerHeight || 600;
        const [minLon, minLat, maxLon, maxLat] = selectionStats.bounds;
        const fit = new WebMercatorViewport({ width, height })
            .fitBounds(
                [[minLon, minLat], [maxLon, maxLat]],
                { padding: 80, minExtent: 0.001 }
            );
        if (!fit || !Number.isFinite(fit.zoom)) return;

        setViewState({
            longitude: fit.longitude,
            latitude: fit.latitude,
            zoom: Math.min(fit.zoom - 0.4, 17.5),
            pitch: 55,
            bearing: bearingDeg,
            transitionDuration: 1100,
            transitionInterpolator: new FlyToInterpolator({ speed: 1.4 })
        });
    }, [snakeActive, selectionCommitted, refitToken, selectionStats, bearingDeg]);

    // 🚀 Performance: Debounce fetching in static mode
    const [debouncedTimeIndex, setDebouncedTimeIndex] = useState(0);

    useEffect(() => {
        if (mode === 'animation') {
            setDebouncedTimeIndex(timeIndex);
        } else {
            const handler = setTimeout(() => {
                setDebouncedTimeIndex(timeIndex);
            }, 500);
            return () => clearTimeout(handler);
        }
    }, [timeIndex, mode]);

    useEffect(() => {
        const handler = setTimeout(() => setDebouncedBufferDistance(bufferDistance), 400);
        return () => clearTimeout(handler);
    }, [bufferDistance]);

    // Recompute the line corridor and re-select when buffer changes after a line is drawn
    useEffect(() => {
        if (selectionMode !== 'line' || !drawnLineCoords || drawnLineCoords.length < 2) return;
        const newGeometry = normalizeGeometry('line', drawnLineCoords, debouncedBufferDistance);
        if (newGeometry) {
            lastProcessedGeometryRef.current = null; // force renderSubLayers to re-select
            setDrawnGeometry(newGeometry);
            setSelectedPointIds(new Set());
            setSelectedFeatures(null);
            setSelectionCommitted(false);
            setHoveredSliceU(null);
        }
    // Only re-run when the debounced buffer changes; mode/coords are handled by handleGeometryComplete
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [debouncedBufferDistance]);

    // ------------------------------------------------------------------
    // Clear / exit
    // ------------------------------------------------------------------

    const clearSelectionAndExit = () => {
        setSelectedPointIds(new Set());
        setDrawnGeometry(null);
        setSelectedFeatures(null);
        setDrawnLineCoords(null);
        setSelectionMode(null);
        setIsDrawing(false);
        setSelectionCommitted(false);
        setSnakeActive(false);
        setHoveredSliceU(null);
        setHoveredPointId(null);
        animProgressRef.current = 0;
        setAnimProgress(0);
        lastProcessedGeometryRef.current = null;

        const saved = savedViewRef.current;
        savedViewRef.current = null;
        if (saved) {
            setViewState({
                ...saved,
                transitionDuration: 1000,
                transitionInterpolator: new FlyToInterpolator({ speed: 1.4 })
            });
        }
    };

    // ------------------------------------------------------------------
    // Hover / tooltip
    // ------------------------------------------------------------------

    const handleViewStateChange = ({ viewState: next }) => {
        setViewState({
            ...next,
            transitionDuration: 0,
            transitionInterpolator: undefined
        });
    };

    const handleHover = (info) => {
        if (!snakeActive || !selectionCommitted) {
            if (hoveredSliceU != null) setHoveredSliceU(null);
            return;
        }

        const layerId = info.layer?.id;

        if (info.object && layerId === SNAKE_AXIS_HITS_ID) {
            setHoveredSliceU(info.object.u);
            return;
        }

        if (layerId === SNAKE_AXIS_STEM_ID && axis && info.x != null && info.y != null) {
            const width = mapContainerRef.current?.clientWidth || window.innerWidth || 800;
            const height = mapContainerRef.current?.clientHeight || window.innerHeight || 600;
            const viewport = new WebMercatorViewport({
                width,
                height,
                longitude: viewState.longitude,
                latitude: viewState.latitude,
                zoom: viewState.zoom,
                pitch: viewState.pitch ?? 0,
                bearing: viewState.bearing ?? 0
            });

            const [axisLon, axisLat] = axis.origin;
            const yBottom = viewport.project([axisLon, axisLat, 0])[1];
            const yTop = viewport.project([axisLon, axisLat, timeHeightM])[1];
            const denominator = yBottom - yTop;

            if (Math.abs(denominator) > 1) {
                let u = clamp01((yBottom - info.y) / denominator);

                // Snap to a tick so the slice lands on a labelled date. Scale the
                // threshold to the tick spacing so dense axes at tall time
                // heights never snap to a neighbouring tick.
                let nearest = null;
                for (const tick of axis.ticks) {
                    if (!nearest || Math.abs(tick.u - u) < Math.abs(nearest.u - u)) {
                        nearest = tick;
                    }
                }
                const snapThreshold = Math.min(0.025, 0.35 / Math.max(1, axis.ticks.length - 1));
                if (nearest && Math.abs(nearest.u - u) < snapThreshold) u = nearest.u;

                setHoveredSliceU(u);
                return;
            }
        }

        if (hoveredSliceU != null) setHoveredSliceU(null);
    };

    const getTooltip = ({ object, layer }) => {
        if (!object) return null;

        if (layer?.id === SNAKE_BASE_MARKER_ID) {
            return {
                text: [
                    `Point ${object.pointId ?? '—'}`,
                    `LOS ${formatMm(object.lastLosMm)} (Vert. equiv. ≈ ${formatMm(object.lastVertMm)})`,
                    `Coherence ${formatCoherence(object.coherence)} • Inc ${formatDegrees(object.incidenceAngle)}`
                ].join('\n')
            };
        }

        if (layer?.id === SNAKE_AXIS_HITS_ID) {
            return { text: object.label };
        }

        return null;
    };

    // ------------------------------------------------------------------
    // Layers
    // ------------------------------------------------------------------

    const paused = snakeActive && selectionCommitted;
    // In static mode use a finite "unclipped" value instead of exactly
    // timeHeightM: float32 rounding of the top ring must never discard it.
    const clipZ = snakeActive && mode === 'animation'
        ? animProgress * timeHeightM
        : 1e9;

    const layers = [
        new TileLayer({
            id: 'base-map',
            data: cartoLightBasemapUrl,
            minZoom: 0, maxZoom: 19, tileSize: 256,
            renderSubLayers: props => {
                const { west, south, east, north } = props.tile.bbox;
                return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north] });
            }
        }),
        new ArrowLODTileLayer({
            id: 'arrow-lod-tile-layer',
            dataUrl: DATA_API_URL,
            dateIndex: debouncedTimeIndex,
            mode: mode,
            paused: paused,
            columnMap: {
                latitude: 'y',
                longitude: 'x',
                color: 'displacements',
                // Requested for this map only, so the arrow toggle never
                // refetches: both symbol modes read the same cached tiles.
                losEast: 'los_east',
                losNorth: 'los_north'
            },
            timeSeries: {
                dates: 'dates',
                displacements: 'displacements'
            },
            onStatusChange: (status) => {
                setTotalPoints(status.totalPoints);
                setCacheSize(status.cacheSize);
                setIsLoading(status.isLoading);
                setFetchStatus(status.isLoading ? "Fetching..." : "Ready");
            },

            renderSubLayers: (props) => {
                const { data } = props;

                if (!data || data.length === 0) return null;

                // After commit the selection is frozen and the tilted snake
                // renders instead of the 2D points. The remaining unselected
                // points stay visible, dim and flat on the ground, so the
                // selection still has spatial context without stealing hover.
                // They follow the same circle/arrow symbol mode as the 2D view.
                if (selectionCommitted) {
                    const groundLayers = [];

                    for (const tableData of data) {
                        const getPosition = (rowIndex) => {
                            const { lon, lat } = tableData.getPosition(rowIndex);
                            return [lon, lat, 0];
                        };

                        if (symbolMode === 'arrow') {
                            const { arrowRows, circleRows } = getUnselectedSymbolRowSplit(
                                tableData,
                                mode,
                                debouncedTimeIndex,
                                selectedPointIds
                            );

                            if (circleRows.length > 0) {
                                groundLayers.push(buildDisplacementCircleLayer({
                                    id: `arrow-table-${tableData.tableIndex}-ground-circles`,
                                    data: circleRows,
                                    zoom: viewState.zoom,
                                    mode,
                                    debouncedTimeIndex,
                                    selectedPointIds,
                                    hoveredPointId,
                                    getPosition,
                                    getFillColor: UNSELECTED_GROUND_FILL,
                                    updateTriggers: {
                                        getFillColor: [],
                                        getPosition: [],
                                    },
                                    pickable: false
                                }));
                            }

                            if (arrowRows.length > 0) {
                                groundLayers.push(new DynamicArrowLayer({
                                    id: `arrow-table-${tableData.tableIndex}-ground-arrows`,
                                    data: arrowRows,
                                    shape: 'round-cap',
                                    anchorCentered: false,
                                    showBorder: true,

                                    getPosition,
                                    getFillColor: UNSELECTED_GROUND_FILL,

                                    getRadius: getArrowRadiusPixels(viewState.zoom),
                                    radiusUnits: 'pixels',

                                    getAngle: (rowIndex) => {
                                        const los = tableData.getLosVector(rowIndex);
                                        return getArrowHeading(
                                            los?.east,
                                            los?.north,
                                            tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex)
                                        );
                                    },
                                    getStemLength: (rowIndex) =>
                                        getArrowStemLengthFraction(
                                            tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex)
                                        ),
                                    getStemThickness: ARROW_STEM_THICKNESS,
                                    getHeadSize: ARROW_HEAD_SIZE,
                                    getHeadWidth: ARROW_HEAD_WIDTH,

                                    getLineColor: [0, 0, 0, 0],
                                    getLineWidth: 0,

                                    updateTriggers: {
                                        getFillColor: [],
                                        getPosition: [],
                                        // Direction/length follow the displayed
                                        // displacement, so they refresh with time.
                                        getAngle: [debouncedTimeIndex, mode],
                                        getStemLength: [debouncedTimeIndex, mode],
                                        getRadius: [viewState.zoom],
                                    },

                                    transitions: {
                                        getFillColor: 0
                                    },

                                    pickable: false
                                }));
                            }
                            continue;
                        }

                        const rows = getUnselectedRowIndices(tableData, selectedPointIds);
                        if (rows.length === 0) continue;
                        groundLayers.push(buildDisplacementCircleLayer({
                            id: `arrow-table-${tableData.tableIndex}-unselected-ground`,
                            data: rows,
                            zoom: viewState.zoom,
                            mode,
                            debouncedTimeIndex,
                            selectedPointIds,
                            hoveredPointId,
                            getPosition,
                            getFillColor: UNSELECTED_GROUND_FILL,
                            // Constant fill/positions: never invalidate this
                            // layer on the animation clock or hover, only when
                            // the row data itself changes.
                            updateTriggers: {
                                getFillColor: [],
                                getPosition: [],
                            },
                            pickable: false
                        }));
                    }

                    return groundLayers;
                }

                // Only compute expensive data key if there's actually a geometry to filter
                if (drawnGeometry && !isDrawing && !selectionCommitted) {
                    // Track both geometry AND total row count to detect new data
                    const geometryKey = JSON.stringify(drawnGeometry);
                    const totalRows = data.reduce((sum, td) => sum + td.numRows, 0);
                    const dataKey = `${geometryKey}-${totalRows}-${data.length}`;

                    if (lastProcessedGeometryRef.current !== dataKey) {
                        lastProcessedGeometryRef.current = dataKey;

                        const newSelected = new Set();

                        // Viewport bounds of the visible tilted view, so a
                        // selection drawn on the pitched map still sees all of
                        // its candidate points.
                        const { longitude, latitude, zoom, pitch, bearing } = viewState;
                        const containerWidth = mapContainerRef.current?.clientWidth || 800;
                        const containerHeight = mapContainerRef.current?.clientHeight || 600;

                        const viewport = new WebMercatorViewport({
                            width: containerWidth,
                            height: containerHeight,
                            longitude,
                            latitude,
                            zoom,
                            pitch: pitch ?? 0,
                            bearing: bearing ?? 0
                        });

                        const bounds = viewport.getBounds();

                        // Filter all visible table data for selected points
                        data.forEach(tableData => {
                            const pointIds = filterPointsByGeometryInBounds(
                                tableData,
                                drawnGeometry,
                                bounds
                            );
                            pointIds.forEach(id => newSelected.add(id));
                        });

                        if (newSelected.size > 0) {
                            setSelectedPointIds(newSelected);
                        }
                    }
                }

                return data.map((tableData) => {
                    // Shared by both symbol modes, so switching symbols never
                    // changes position or colour semantics.
                    const getPosition = (rowIndex) => {
                        const { lon, lat } = tableData.getPosition(rowIndex);
                        return [lon, lat];
                    };

                    const getFillColor = (rowIndex) => {
                        const pointId = tableData.getPointId(rowIndex);

                        // If point is hovered, show bright red
                        if (hoveredPointId === pointId) {
                            return [255, 0, 0, 255]; // Bright red
                        }

                        // If point is selected, highlight it
                        if (selectedPointIds.has(pointId)) {
                            return [66, 212, 244, 255]; // Bright cyan
                        }

                        // If there are selected points, dim unselected
                        if (selectedPointIds.size > 0) {
                            return [200, 200, 200, 100]; // Dim gray
                        }

                        // Normal displacement color
                        const val = tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex);
                        const rgb = colorScale(val);
                        return [rgb[0], rgb[1], rgb[2], 200];
                    };

                    if (symbolMode === 'arrow') {
                        const getDisplacement = (rowIndex) =>
                            tableData.getDisplacementValue(rowIndex, mode, debouncedTimeIndex);

                        // Since |displacement| scales the length and colour,
                        // points within the near-zero band render as circles and
                        // the rest as arrows. The split changes with the date /
                        // animation frame.
                        const { arrowRows, circleRows } = getSymbolRowSplit(
                            tableData,
                            mode,
                            debouncedTimeIndex
                        );

                        const circleLayer = buildDisplacementCircleLayer({
                            id: `arrow-table-${tableData.tableIndex}-stable-circles`,
                            data: circleRows,
                            zoom: viewState.zoom,
                            mode,
                            debouncedTimeIndex,
                            selectedPointIds,
                            hoveredPointId,
                            getPosition,
                            getFillColor
                        });

                        // Round-cap SDF arrows sized in pixels. `shape` and
                        // `anchorCentered` are baked into the shader at compile
                        // time, so the '-roundcap' layer id keeps this instance
                        // distinct from the circle branch.
                        const arrowLayer = new DynamicArrowLayer({
                            id: `arrow-table-${tableData.tableIndex}-roundcap-border`,
                            data: arrowRows,
                            shape: 'round-cap',
                            anchorCentered: false,
                            // Keep the default 1 px transparent-black rim so it
                            // can be compared with the bordered circles.
                            showBorder: true,

                            getPosition,
                            getFillColor,

                            getRadius: getArrowRadiusPixels(viewState.zoom),
                            radiusUnits: 'pixels',

                            // Direction follows the sign of the currently
                            // displayed displacement, matching the circle/arrow
                            // split. Missing LOS columns degrade to a north (0)
                            // arrow instead of dropping the point.
                            getAngle: (rowIndex) => {
                                const los = tableData.getLosVector(rowIndex);
                                return getArrowHeading(los?.east, los?.north, getDisplacement(rowIndex));
                            },
                            getStemLength: (rowIndex) =>
                                getArrowStemLengthFraction(getDisplacement(rowIndex)),
                            getStemThickness: ARROW_STEM_THICKNESS,
                            getHeadSize: ARROW_HEAD_SIZE,
                            getHeadWidth: ARROW_HEAD_WIDTH,

                            // Hover/selection stays fill-only, matching the
                            // circles. A non-zero line alpha would make the
                            // shader treat every arrow as selected.
                            getLineColor: [0, 0, 0, 0],
                            getLineWidth: 0,

                            updateTriggers: {
                                getFillColor: [debouncedTimeIndex, mode, selectedPointIds, hoveredPointId],
                                getPosition: [mode],
                                // Angle and stem only depend on the displayed
                                // displacement; zoom drives `getRadius` and does
                                // not need to rebuild them.
                                getAngle: [debouncedTimeIndex, mode],
                                getStemLength: [debouncedTimeIndex, mode],
                                getRadius: [viewState.zoom],
                            },

                            // Disable transitions for instant updates
                            transitions: {
                                getFillColor: 0
                            },

                            pickable: true
                        });

                        const tableLayers = [];
                        if (circleRows.length > 0) tableLayers.push(circleLayer);
                        if (arrowRows.length > 0) tableLayers.push(arrowLayer);
                        return tableLayers;
                    }

                    return buildDisplacementCircleLayer({
                        id: `arrow-table-${tableData.tableIndex}`,
                        data: getAllRowIndices(tableData),
                        zoom: viewState.zoom,
                        mode,
                        debouncedTimeIndex,
                        selectedPointIds,
                        hoveredPointId,
                        getPosition,
                        getFillColor
                    });
                }).flat();
            }
        }),
        // --- Time-snake layers (after the tile layer) ---
        snake.mesh && snake.origin && new SimpleMeshLayer({
            id: 'snake-time-tube-mesh',
            data: [0],
            mesh: snake.mesh,
            getPosition: [0, 0, 0],
            getColor: [255, 255, 255, 255],
            coordinateSystem: 'meter-offsets',
            coordinateOrigin: [snake.origin[0], snake.origin[1], 0],
            pickable: false,
            material: DISPLACEMENT_SYMBOL_MATERIAL,
            // The clipped tube is open; keep its inner wall visible.
            parameters: { cullMode: 'none' },
            clipZ,
            extensions: [zClipExtension]
        }),
        snake.mesh && snake.origin && new ScatterplotLayer({
            id: SNAKE_BASE_MARKER_ID,
            data: baseMarkers,
            getPosition: (d) => [d.lon, d.lat, 0],
            getRadius: (d) => (
                hoveredPointId != null && String(d.pointId) === String(hoveredPointId)
                    ? 6
                    : 2
            ),
            radiusUnits: 'pixels',
            getFillColor: (d) => (
                hoveredPointId != null && String(d.pointId) === String(hoveredPointId)
                    ? [255, 0, 0, 255]
                    : [66, 212, 244, 255]
            ),
            stroked: false,
            pickable: true,
            updateTriggers: {
                getRadius: [hoveredPointId],
                getFillColor: [hoveredPointId]
            }
        }),
        axis && new LineLayer({
            id: SNAKE_AXIS_STEM_ID,
            data: [axis.stem],
            getSourcePosition: (d) => d[0],
            getTargetPosition: (d) => d[1],
            getColor: [40, 40, 40, 230],
            getWidth: 2,
            widthUnits: 'pixels',
            pickable: true
        }),
        axis && new LineLayer({
            id: 'snake-time-axis-ticks',
            data: axis.ticks,
            getSourcePosition: (d) => d.hit,
            getTargetPosition: (d) => d.tip,
            getColor: (_, { index }) => (
                index === nearestTickIndex ? [66, 212, 244, 255] : [60, 60, 60, 200]
            ),
            getWidth: (_, { index }) => (index === nearestTickIndex ? 2 : 1),
            widthUnits: 'pixels',
            pickable: false,
            updateTriggers: {
                getColor: [nearestTickIndex],
                getWidth: [nearestTickIndex]
            }
        }),
        axis && new TextLayer({
            id: 'snake-time-axis-labels',
            data: axis.ticks,
            getText: (d) => d.label,
            getPosition: (d) => d.tip,
            getSize: 7,
            getColor: (_, { index }) => (
                index === nearestTickIndex ? [66, 212, 244, 255] : [120, 120, 120, 240]
            ),
            getTextAnchor: 'start',
            getAlignmentBaseline: 'center',
            billboard: true,
            fontFamily: 'system-ui, sans-serif',
            pickable: false,
            updateTriggers: {
                getColor: [nearestTickIndex]
            }
        }),
        axis && new ScatterplotLayer({
            id: SNAKE_AXIS_HITS_ID,
            data: axis.ticks,
            getPosition: (d) => d.hit,
            getRadius: 7,
            radiusUnits: 'pixels',
            // Fully transparent: deck.gl still renders these into the picking
            // buffer, so the hits stay pickable without showing as cyan dots.
            getFillColor: [66, 212, 244, 0],
            stroked: false,
            pickable: true
        }),
        sliceGeometry.ring && new PolygonLayer({
            id: 'snake-time-slice-polygon',
            data: [sliceGeometry.ring],
            getPolygon: (d) => d,
            filled: true,
            stroked: true,
            getFillColor: [66, 212, 244, 38],
            getLineColor: [66, 212, 244, 210],
            lineWidthUnits: 'pixels',
            getLineWidth: 2,
            pickable: false
        }),
        sliceGeometry.points.length > 0 && new ScatterplotLayer({
            id: 'snake-time-slice-dots',
            data: sliceGeometry.points,
            getPosition: (d) => d.position,
            // Grow past the base radius so the fill and 1 px rim stay crisp at
            // every zoom, matching the 2D point border.
            getRadius: Math.max(3, getPointSize(viewState.zoom)),
            radiusUnits: 'pixels',
            getFillColor: (d) => d.color,
            stroked: true,
            filled: true,
            getLineColor: [0, 0, 0, 0],
            getLineWidth: 1,
            lineWidthUnits: 'pixels',
            updateTriggers: {
                getRadius: [viewState.zoom]
            },
            pickable: false
        })
    ].filter(Boolean);

    return (
        <div ref={mapContainerRef} style={{ position: 'relative', width: '100%', height: '100vh', overflow: 'hidden' }}>
            <DeckGL
                viewState={viewState}
                onViewStateChange={handleViewStateChange}
                controller={{ maxPitch: 85 }}
                layers={layers}
                onHover={handleHover}
                getTooltip={getTooltip}
            />

            <HUD
                viewState={viewState}
                currentTierDisplay={currentTierDisplay}
                totalPoints={totalPoints}
                fetchStatus={fetchStatus}
                isLoading={isLoading}
                cacheSize={cacheSize}
                cacheLimit={TILE_CACHE_LIMIT}
            />

            <PlaybackControls
                date={dates[timeIndex]}
                mode={mode}
                isPlaying={isPlaying}
                isLoading={isLoading}
                timeIndex={timeIndex}
                totalDates={dates.length}
                setMode={setMode}
                setIsPlaying={setIsPlaying}
                setTimeIndex={setTimeIndex}
            />

            {!snakeActive && (
                <LegendOverlay lifted={Boolean(selectedFeatures)}>
                    <ColorScaleLegend
                        colorScale={colorScale}
                        domain={COLOR_DOMAIN}
                        // The 2D map always colours raw LOS displacement, so the
                        // projection mode (3D-only) must not retitle it.
                        title="LOS (slant-range) displacement (mm)"
                    />
                </LegendOverlay>
            )}

            <SelectionAnalysisPanel
                top="130px"
                left="10px"
                selectionMode={selectionMode}
                onSelectionModeChange={setSelectionMode}
                isDrawing={isDrawing}
                onIsDrawingChange={setIsDrawing}
                bufferDistance={bufferDistance}
                onBufferDistanceChange={setBufferDistance}
                onClear={clearSelectionAndExit}
                onGeometryComplete={handleGeometryComplete}

                selectedCount={selectedPointIds.size}
                selectedFeatures={selectedFeatures}
                profileData={profileData}
                isLoading={isSelectingBackend}
                backendFeatureCount={selectedFeatures?.features?.length || 0}

                lineProfileMetrics={['mean_velocity', 'mean_velocity_std']}
                is3D={false}
                viewState={viewState}
                onPointHover={setHoveredPointId}

                belowSelectionPanel={
                    <SymbolModeToggle
                        symbolMode={symbolMode}
                        onSymbolModeChange={setSymbolMode}
                    />
                }
            />

            {snakeActive && (
                <SnakeViewControls
                    smoothDays={smoothDays}
                    onSmoothDaysChange={setSmoothDays}
                    timeScale={timeScale}
                    onTimeScaleChange={setTimeScale}
                    timeHeightM={timeHeightM}
                    suggestedTimeHeightM={suggestedTimeHeightM}
                    leanScale={leanScale}
                    onLeanScaleChange={setLeanScale}
                    leanMPerMm={leanMPerMm}
                    suggestedLeanMPerMm={suggestedLeanMPerMm}
                    thicknessScale={thicknessScale}
                    onThicknessScaleChange={setThicknessScale}
                    widthByCoherence={widthByCoherence}
                    onWidthByCoherenceChange={setWidthByCoherence}
                    flipLean={flipLean}
                    onFlipLeanChange={setFlipLean}
                    projectionMode={projectionMode}
                    onProjectionModeChange={setProjectionMode}
                    showSlicePlane={showSlicePlane}
                    onShowSlicePlaneChange={setShowSlicePlane}
                    onRefit={() => setRefitToken(token => token + 1)}
                    onExit={clearSelectionAndExit}
                    usedFeatures={snakeSeries.usedFeatures}
                    totalFeatures={snakeSeries.totalFeatures}
                    timeRange={snakeSeries.timeRange}
                    timestepCount={timestepCount}
                    sampleCount={SAMPLE_COUNT}
                />
            )}
        </div>
    );
}

export default ArrowLODStream2D;

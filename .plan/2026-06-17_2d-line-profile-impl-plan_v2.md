# Plan: 2D Line Profile Component (v2 - Final)

This document outlines the implementation plan for creating a new 2D Line Profile component and integrating it into the `ArrowLODStream_3D` and `Misicuni_dam` maps.

## 1. Objective

- Create a reusable `LineProfileChart` component.
- Integrate the full point selection toolset (`SelectionControls`, `DrawingOverlay`) and the new chart into the `Misicuni_dam` map.
- Integrate the `LineProfileChart` into the `ArrowLODStream_3D` map, which already has the selection toolset.

**UX Logic:**
-   When `selectionMode` is `'polygon'` or `'circle'`, the existing `TimeSeriesChart` will be shown.
-   When `selectionMode` is `'line'`, the new `LineProfileChart` will be shown automatically.

## 2. Core Component Creation (Unchanged)

These files will be created exactly as planned previously. They are reusable for both target maps.

-   `src/components/2DLineProfile/`
    -   `projectionUtils.js`: Contains the geometric calculation logic.
    -   `LineProfileChart.jsx`: The new React component for rendering the chart.
    -   `index.js`: A barrel file to export the components.

The content for these files remains as defined in the previous plan version.

## 3. Integration Target 1: `ArrowLODStream_3D/Map3D.jsx`

This component already has the required selection tools. The integration is straightforward.

**File to modify:** `src/maps/ArrowLODStream_3D/Map3D.jsx`

**Steps:**

1.  **Import new modules**:
    ```jsx
    // Add with other imports
    import { LineProfileChart, calculateProfileData } from '../../components/2DLineProfile';
    ```

2.  **Add state for drawn line**:
    ```jsx
    // Add with other selection state
    const [drawnLineCoords, setDrawnLineCoords] = useState(null);
    ```

3.  **Update `handleGeometryComplete`**: Save the raw line coordinates.
    ```jsx
    const handleGeometryComplete = (mode, coords, bufferDist = 100) => {
        const geoCoords = coords.map(c => c.geo || c);
        const geometry = normalizeGeometry(mode, geoCoords, bufferDist);
        if (!geometry) return;

        setDrawnGeometry(geometry);
        setIsDrawing(false);

        // --- NEW ---
        if (mode === 'line') {
            setDrawnLineCoords(geoCoords);
        } else {
            setDrawnLineCoords(null);
        }
        // --- END NEW ---
    };
    ```

4.  **Update `onClear` handler**:
     ```jsx
    // In SelectionControls props
    onClear={() => {
        setSelectedPointIds(new Set());
        setDrawnGeometry(null);
        setSelectedFeatures(null);
        setIsDrawing(selectionMode ? true : false);
        setDrawnLineCoords(null); // --- NEW ---
    }}
     ```

5.  **Add `useMemo` for `profileData`**:
    ```jsx
    // Add after other state and useEffect hooks
    const profileData = useMemo(() => {
        if (selectionMode === 'line' && selectedFeatures && drawnLineCoords) {
            return calculateProfileData(selectedFeatures, drawnLineCoords);
        }
        return null;
    }, [selectedFeatures, drawnLineCoords, selectionMode]);
    ```

6.  **Update render logic**:
    ```jsx
    // Replace the existing TimeSeriesChart rendering block
    <div style={{
        position: 'absolute',
        bottom: '10px',
        left: '10px',
        width: 'calc(50% - 430px)',
        minWidth: '300px',
        zIndex: 999,
    }}>
        {profileData ? (
            <LineProfileChart data={profileData} />
        ) : selectedFeatures ? (
            <TimeSeriesChart
                selectedFeatures={selectedFeatures}
                isLoading={isSelectingBackend}
                onPointHover={setHoveredPointId}
            />
        ) : null}
    </div>
    ```

## 4. Integration Target 2: `Misicuni_dam/index.jsx`

This component requires adding the entire selection feature set as a prerequisite.

**File to modify:** `src/maps/Misicuni_dam/index.jsx`

### 4.1. Prerequisite: Add Selection Functionality

1.  **Import necessary components and hooks**:
    ```jsx
    // Add to existing imports
    import { SelectionControls, DrawingOverlay, TimeSeriesChart, normalizeGeometry, pointInPolygon } from '../../components/PointSelection';
    import { setDeckGLInstance } from '../../components/PointSelection/drawingUtils';
    import { LineProfileChart, calculateProfileData } from '../../components/2DLineProfile';
    ```

2.  **Add all selection-related state**:
    ```jsx
    // Add inside MisicuniDam component function
    const [selectionMode, setSelectionMode] = useState(null);
    const [isDrawing, setIsDrawing] = useState(false);
    const [bufferDistance, setBufferDistance] = useState(100);
    const [drawnGeometry, setDrawnGeometry] = useState(null);
    const [selectedPoints, setSelectedPoints] = useState([]);
    const [selectedFeatures, setSelectedFeatures] = useState(null);
    const [, setHoveredPointId] = useState(null); // Already exists in a way, but let's be explicit
    const [drawnLineCoords, setDrawnLineCoords] = useState(null);
    const [allVectorData, setAllVectorData] = useState([]);

    const deckGLRef = useRef(null);
    ```

3.  **Load and consolidate all vector data**: The component loads multiple vector files. We need to consolidate them into one array for selection.
    ```jsx
    // Inside MisicuniDam component, add new useEffect
    useEffect(() => {
        const loadAllData = async () => {
            const promises = VECTOR_POINT_DATA.map(layerConfig => fetch(layerConfig.url).then(res => res.json()));
            const allGeoJsonData = await Promise.all(promises);
            const combinedFeatures = allGeoJsonData.flatMap(geoJson => geoJson.features || []);
            setAllVectorData(combinedFeatures);
        };
        loadAllData();
    }, []);

    // Set DeckGL instance for drawing utils
    useEffect(() => {
        if (deckGLRef.current) setDeckGLInstance(deckGLRef.current);
    }, []);
    ```

4.  **Add `handleGeometryComplete` function**: This will perform client-side selection.
    ```jsx
    // Add inside MisicuniDam component function
    const handleGeometryComplete = (mode, coords, bufferDist = 100) => {
        const geoCoords = coords.map(c => c.geo || c);
        const geometry = normalizeGeometry(mode, geoCoords, bufferDist);
        if (!geometry) return;

        setDrawnGeometry(geometry);
        setIsDrawing(false);

        if (mode === 'line') {
            setDrawnLineCoords(geoCoords);
        } else {
            setDrawnLineCoords(null);
        }

        // Filter all loaded vector data
        const selected = allVectorData.filter(feature => {
            const [lon, lat] = feature.geometry?.coordinates || [0, 0];
            return pointInPolygon([lon, lat], geometry);
        });

        setSelectedPoints(selected); // Keep original selected features for highlighting

        // Adapt to the FeatureCollection format expected by the charts
        const fc = {
            type: 'FeatureCollection',
            features: selected.map((f, i) => ({
                type: 'Feature',
                id: f.properties?.id_global || f.properties?.id || i,
                geometry: f.geometry,
                properties: {
                    ...f.properties,
                    // The charts expect 'mean_velocity'. We map it from available properties.
                    mean_velocity: f.properties.VEL_REL ?? f.properties.VEL_RE_UP ?? f.properties.VEL_RE_EW ?? 0,
                    point_id: f.properties?.id_global || f.properties?.id || i,
                }
            }))
        };
        setSelectedFeatures(fc);
    };
    ```

5.  **Update `SimpleMeshLayer` `getColor` logic** to show selection.
    ```jsx
    // Inside the meshLayers mapping
    const selectedIds = new Set(selectedPoints.map(p => p.properties?.id_global || p.properties?.id));

    // ... inside SimpleMeshLayer props ...
    getColor: (d) => {
        const pointId = d.properties?.id_global || d.properties?.id;
        if (selectedIds.has(pointId)) {
            return [66, 212, 244, 255]; // Bright Cyan for selected
        }
        if (selectedIds.size > 0) {
            return [200, 200, 200, 100]; // Dim unselected
        }
        // ... rest of original color logic
    ```

### 4.2. Integrate Line Profile Chart

1.  **Add `useMemo` for `profileData`**:
    ```jsx
    // Add inside MisicuniDam component function
    const profileData = useMemo(() => {
        if (selectionMode === 'line' && selectedFeatures && drawnLineCoords) {
            return calculateProfileData(selectedFeatures, drawnLineCoords);
        }
        return null;
    }, [selectedFeatures, drawnLineCoords, selectionMode]);
    ```

2.  **Add Controls and Chart to JSX**:
    ```jsx
    // Add inside the main return div of MisicuniDam component
    <SelectionControls
        selectionMode={selectionMode}
        onModeChange={setSelectionMode}
        bufferDistance={bufferDistance}
        onBufferChange={setBufferDistance}
        selectedCount={selectedPoints.length}
        onClear={() => {
            setSelectedPoints([]);
            setDrawnGeometry(null);
            setSelectedFeatures(null);
            setDrawnLineCoords(null);
            setIsDrawing(false);
        }}
        top="400px" // Adjust position to not overlap existing controls
        left="10px"
    />

    <DrawingOverlay
        viewState={viewState}
        selectionMode={selectionMode}
        isDrawing={isDrawing}
        onGeometryComplete={handleGeometryComplete}
        bufferDistance={bufferDistance}
        is3D={true}
    />

    <div style={{
        position: 'absolute',
        bottom: '10px',
        left: '10px',
        width: 'calc(50% - 280px)',
        minWidth: '300px',
        zIndex: 999,
    }}>
        {profileData ? (
            <LineProfileChart data={profileData} />
        ) : selectedFeatures ? (
            <TimeSeriesChart
                selectedFeatures={selectedFeatures}
                isLoading={false}
                onPointHover={setHoveredPointId}
            />
        ) : null}
    </div>
    ```

This completes the revised plan.
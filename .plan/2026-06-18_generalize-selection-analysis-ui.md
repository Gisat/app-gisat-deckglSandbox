# Plan: Generalize Selection and Analysis UI

**Date:** 2026-06-18

**Goal:** Refactor the point selection and charting functionality into a reusable component to eliminate code duplication and provide consistent behavior across all maps.

---

### Phase 1: Create the `SelectionAnalysisPanel` Component

1.  **Create New File:**
    -   Create `src/components/PointSelection/SelectionAnalysisPanel.jsx`.

2.  **Component Scaffolding:**
    -   Create a new React component `SelectionAnalysisPanel`.
    -   This component will accept props like `allVectorData`, `lineProfileMetrics`, `onSelectedIdsChange`, `is3D`, `viewState`, and backend-related props if needed (`backendUrl`, etc.).

3.  **Move State Management:**
    -   Migrate all selection-related state from `Misicuni_dam/index.jsx` into `SelectionAnalysisPanel.jsx`:
        -   `selectionMode`, `setSelectionMode`
        -   `isDrawing`, `setIsDrawing`
        -   `bufferDistance`, `setBufferDistance`
        -   `drawnGeometry`, `setDrawnGeometry`
        -   `selectedPoints`, `setSelectedPoints` (or `selectedPointIds` for backend-driven selection)
        -   `selectedFeatures`, `setSelectedFeatures`
        -   `drawnLineCoords`, `setDrawnLineCoords`
        -   `showLineProfileChart`, `setShowLineProfileChart`

4.  **Move UI Rendering:**
    -   Move the JSX for `SelectionControls`, `DrawingOverlay`, and the chart container from `Misicuni_dam/index.jsx` into the `render` method of `SelectionAnalysisPanel`.

5.  **Move Logic/Callbacks:**
    -   Move the `handleGeometryComplete` function.
    -   Move the `profileData` `useMemo` calculation.
    -   The logic for filtering points (`pointInPolygon`) or preparing backend queries will also be inside this component.

### Phase 2: Refactor `Misicuni_dam/index.jsx`

1.  **Remove Old Code:**
    -   Delete the state, effects, and helper functions that were moved to `SelectionAnalysisPanel`.
    -   Remove the JSX for `SelectionControls`, `DrawingOverlay`, and the chart container.

2.  **Integrate New Component:**
    -   Render `<SelectionAnalysisPanel />` in the `MisicuniDam` component.
    -   Pass the required props, for example:
        -   `allVectorData={allVectorData}`
        -   `lineProfileMetrics={lineProfileMetrics}`
        -   `is3D={true}`
        -   `viewState={viewState}`
        -   `onSelectedIdsChange={handleSelectionChange}` (a new callback to update highlighting on the map's mesh layers).

### Phase 3: Refactor `ArrowLODStream_3D/Map3D.jsx`

1.  **Remove Old Code:**
    -   Similar to `Misicuni_dam`, remove the duplicated selection and charting code.

2.  **Integrate New Component:**
    -   Render `<SelectionAnalysisPanel />`.
    -   The `SelectionAnalysisPanel` will be made flexible enough to handle both frontend and backend selection strategies.
    -   Pass props for backend selection, like a backend URL or selection function.
    -   Pass `onSelectedIdsChange` to handle point highlighting.

### Phase 4: Refactor `ArrowLODStream_2D/Map2D.jsx`

1.  **Remove Old Code:**
    -   Remove the current selection implementation.

2.  **Integrate New Component:**
    -   Render `<SelectionAnalysisPanel />`.
    -   This will add the line profile functionality to this map. If the data for this map does not contain suitable attributes, the line profile option will be gracefully hidden.

---

### Component API for `SelectionAnalysisPanel.jsx` (Initial Draft)

To make the component reusable, it will have a clear and flexible API.

```javascript
<SelectionAnalysisPanel
    // Data and selection mode
    selectionDataSource={allVectorData} // or a backend URL
    selectionStrategy="frontend" // "frontend" or "backend"
    
    // Map interaction
    viewState={viewState}
    is3D={true}
    onSelectedIdsChange={setSelectedIdsSet} // Callback to notify parent of selected IDs for highlighting

    // Line Profile configuration
    lineProfileMetrics={['VEL_RE_UP', 'VEL_LA_UP']} // Array of attributes for the line chart. If empty/null, the option is hidden.
/>
```

This plan ensures the new component is modular and the existing maps are simplified, leading to a more maintainable codebase.

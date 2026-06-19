# Plan: Generalize Selection and Analysis UI

**Date:** 2026-06-18

**Goal:** Refactor the point selection and charting functionality into a reusable component to eliminate code duplication and provide consistent behavior across all maps. This will be achieved by creating a "controlled" `SelectionAnalysisPanel` component that handles UI while the parent map component manages state and data logic.

---
### Refinements based on Feedback (2026-06-18)

Based on user feedback, the following clarifications and improvements will be made:

1.  **Vector Data Loading:** The `SelectionAnalysisPanel` will not be responsible for loading data. The parent map component will load the required vector data (e.g., just the first layer for `Misicuni_dam`) and pass it to the panel via props.
2.  **Unified Point ID Extraction:** A new helper function, `getPointId(feature)`, will be created to provide a single, consistent way of extracting a unique identifier from a feature's properties (`fid`, `ID_CELL`, etc.). This function will be used throughout the selection and highlighting logic.
3.  **Optional Hover Handling:** The panel will accept an optional `onPointHover` callback prop to support hover-highlighting in maps that need it (like `ArrowLODStream_3D`), without forcing it on maps that don't.
4.  **Chart Toggle:** The `showLineProfileChart` toggle functionality has already been implemented and committed. This logic will be moved into the new `SelectionAnalysisPanel` to ensure it's available generally.

---
### Backend API Contract for Point Selection

This remains for reference for maps that use a backend.

*   **Request:**
    *   **Endpoint:** `/api/select`
    *   **Method:** `POST`
    *   **Body:** `{"point_ids": ["id1", "id2", ...]}`
*   **Response:**
    *   **Format:** GeoJSON `FeatureCollection`

---

### Phase 1: Create the `SelectionAnalysisPanel` (Controlled Component)

1.  **Create New File:**
    -   Create `src/components/PointSelection/SelectionAnalysisPanel.jsx`.

2.  **Create `getPointId` Helper:**
    -   In a utility file (e.g., `src/components/PointSelection/geometryUtils.js`), create a `getPointId(feature)` function that encapsulates the logic for extracting a unique ID from a feature.

3.  **Component Scaffolding:**
    -   Create a new React component `SelectionAnalysisPanel`. This component will be "controlled".
    -   It will manage its own internal state for `showLineProfileChart`.
    -   It will receive props for state (`selectionMode`, `selectedFeatures`, etc.) and callbacks (`onSelectionModeChange`, `onGeometryComplete`, etc.) from the parent map.

4.  **UI Rendering:**
    -   The component will render `SelectionControls`, `DrawingOverlay`, and the chart container, passing down the props it receives.

### Phase 2: Migration of Maps

1.  **Refactor `Misicuni_dam/index.jsx` (Frontend Case):**
    -   Keep the selection state and `handleGeometryComplete` logic within the component.
    -   Use the new `getPointId` helper function.
    -   Render `<SelectionAnalysisPanel />`, passing down the required state and callbacks.

2.  **Refactor `ArrowLODStream_3D/Map3D.jsx` (Backend Case):**
    -   Keep its specific selection logic (filtering tile data, querying backend).
    -   Render `<SelectionAnalysisPanel />` and wire it up to the existing state and logic.
    -   Pass the optional `onPointHover` callback to the panel.

3.  **Refactor `ArrowLODStream_2D/Map2D.jsx`:**
    -   Add the necessary state management for selection.
    -   Render `<SelectionAnalysisPanel />`.

---
### Component API for `SelectionAnalysisPanel.jsx` (Controlled Component)

```javascript
<SelectionAnalysisPanel
    // State and callbacks
    selectionMode={selectionMode}
    onSelectionModeChange={setSelectionMode}
    isDrawing={isDrawing}
    onIsDrawingChange={setIsDrawing}
    bufferDistance={bufferDistance}
    onBufferDistanceChange={setBufferDistance}
    onClear={handleClear}
    onGeometryComplete={handleGeometryComplete} // The map implements this logic

    // Data to display
    selectedCount={selectedPoints.length}
    selectedFeatures={selectedFeatures}
    drawnLineCoords={drawnLineCoords}
    
    // Configuration & Optional Callbacks
    lineProfileMetrics={['VEL_RE_UP', 'VEL_LA_UP']}
    is3D={true}
    viewState={viewState}
    onPointHover={setHoveredPointId} // Optional
/>
```
---

I will skip the testing phase as requested.

# Point Selection and Analysis Components

This document provides an overview of the React components used for point selection and data visualization within the application. These components provide a powerful way for users to interact with map data by drawing selection areas and viewing analysis charts.

## Overview

The selection feature is orchestrated by the `SelectionAnalysisPanel`, which combines several components to deliver a seamless user experience. The typical workflow is:

1.  A user selects a drawing tool (`polygon`, `circle`, or `line`) from the `SelectionControls` UI.
2.  The user draws a shape on the map using the `DrawingOverlay` canvas. This overlay handles both 2D and 3D map interactions.
3.  Once the drawing is complete, `geometryUtils` normalizes the shape into a standard GeoJSON polygon. For lines, this involves creating a buffered corridor.
4.  The application then filters the underlying point data (e.g., from an Arrow table) against this geometry.
5.  The selected data is passed to a chart for visualization.
    -   For `polygon` and `circle` selections, a `TimeSeriesChart` is displayed.
    -   For `line` selections, the user can toggle between the `TimeSeriesChart` and a `2DLineProfileChart`.
6.  The `2DLineProfileChart` uses `projectionUtils` to calculate the distance of each selected point along the drawn line, creating a cross-section profile of the data.

## Component Architecture

The system is designed to be modular and reusable. The main components are:

-   **`SelectionAnalysisPanel`**: The central controller that manages state and connects all the pieces.
-   **Map Components (e.g., `Map2D.jsx`, `Map3D.jsx`)**: The parent components that host the `SelectionAnalysisPanel` and provide the core map view and data layers.
-   **UI Controls (`SelectionControls`)**: Provides the user interface for initiating actions.
-   **Drawing Surface (`DrawingOverlay`)**: Captures user input on the map.
-   **Charting (`TimeSeriesChart`, `LineProfileChart`)**: Visualizes the results.
-   **Utilities (`geometryUtils`, `drawingUtils`, `projectionUtils`)**: A set of helper modules for handling the complex geometric and data transformation logic.

---

## Component Reference

### `PointSelection` Components

The components in `@src/components/PointSelection/` provide the framework for user-driven data selection.

#### `SelectionAnalysisPanel.jsx`

This is the primary orchestrator for the selection UI. It's a controlled component that should be placed within a map component. It encapsulates the drawing tools, selection logic, and charting views into a single, cohesive unit.

-   **Props**:
    -   `selectionMode`, `onSelectionModeChange`: Manages the current drawing mode ('polygon', 'circle', 'line').
    -   `isDrawing`, `onIsDrawingChange`: Controls whether the drawing overlay is active.
    -   `bufferDistance`, `onBufferDistanceChange`: Manages the buffer size (in meters) for line selections.
    -   `onClear`: A callback to clear the current selection.
    -   `onGeometryComplete`: A callback fired when a user finishes drawing a shape. It receives the normalized GeoJSON geometry and the original drawn coordinates.
    -   `selectedCount`, `selectedFeatures`, `profileData`: Data props to feed the charts. `profileData` should be pre-computed by the parent using `calculateProfileData` and is passed directly to the `LineProfileChart`.
    -   `isLoading`, `backendFeatureCount`: Props to display loading status and feedback from backend queries.
    -   `lineProfileMetrics`: An array of metric names. When non-empty, the "2D Profile" checkbox is shown in `SelectionControls`, allowing the user to toggle the `LineProfileChart`. The actual metric series shown are determined by how the parent computes `profileData`.
    -   `is3D`: A boolean that adapts the drawing overlay's behavior for 3D (terrain-aware) maps.
    -   `viewState`: The current Deck.gl view state, needed for coordinate projections.
    -   `onPointHover`: A callback to enable cross-highlighting between the chart and the map.

#### `SelectionControls.jsx`

A simple UI component that provides buttons for selecting the drawing mode, a slider for the line buffer distance, a checkbox to toggle the line profile chart, and a "Clear" button.

#### `DrawingOverlay.jsx`

This component renders a transparent `<canvas>` element over the map to capture user drawing.

-   **2D vs. 3D Mode**:
    -   In **2D mode**, it attaches its own mouse event listeners to the canvas and uses `viewport.unproject` to convert screen pixels to geographic coordinates.
    -   In **3D mode**, it relies on the parent map component (e.g., `Map3D.jsx`) to perform terrain-aware ray-casting. The parent map fires a custom `map3dDrawingClick` event with the precise 3D coordinate, which the overlay listens for. This is crucial for drawing accurately on a surface with elevation.

#### `TimeSeriesChart.jsx`

A scatter plot built with `@nivo/scatterplot` that visualizes a property (e.g., `mean_velocity`) of the selected points. It also supports hover events (`onPointHover`) to highlight the corresponding point on the map.

#### `drawingUtils.js`

Contains essential functions for converting between screen and geographic coordinates.

-   `screenToGeo(viewState, x, y, width, height)`: Converts a screen coordinate to a geographic one. In 3D mode, it attempts to use a globally-set DeckGL instance to perform 3D picking against the terrain layer for maximum accuracy.
-   `redrawCanvas(...)`: Handles the rendering of the drawing-in-progress on the canvas, providing real-time feedback to the user.

#### `geometryUtils.js`

A collection of geospatial helper functions using `@turf/` libraries.

-   `normalizeGeometry(mode, coords, bufferMeters)`: Converts a user's raw drawing into a valid GeoJSON `Polygon`.
    -   For `circle`, it creates a polygon from a center and a radius point.
    -   For `line`, it creates a polygonal corridor by buffering the line using the `@turf/buffer` library.
        -   **Buffer recomputation**: When the user adjusts the buffer-distance slider after completing a line drawing, the corridor polygon and the point selection are automatically recomputed. In maps that query a backend, the recomputation is debounced (400 ms) to avoid spamming requests while dragging the slider.
        -   **Status & Limitation**: This process uses round endcaps for the buffer by default. The library does not currently support `flat` or `square` endcap styles, which could be a consideration for future enhancements.
    -   For `polygon`, it ensures the ring is closed.
-   `filterPointsByGeometryInBounds(...)`: An efficient function to filter a large set of points (from an Arrow table) against a selection geometry and a pre-computed bounding box.

---

### `2DLineProfile` Components

The components in `@src/components/2DLineProfile/` are focused on creating and displaying a 2D line profile analysis.

#### `LineProfileChart.jsx`

A line chart built with `@nivo/line` designed to show how one or more metrics change over a distance.

-   It can render multiple metric series on the same chart.
-   It supports hover events (`onPointHover`) to identify points along the profile, which can be highlighted on the map.
-   The styling is configured to match the `TimeSeriesChart` for a consistent look.

#### `projectionUtils.js`

This module contains the logic for processing data for the `LineProfileChart`.

-   `calculateProfileData(selectedFeatures, lineCoords, metricFields)`: This is the core function.
    1.  It takes the points selected by a line-buffer geometry and the original line drawn by the user.
    2.  For each point, it calculates its scalar projection onto the line, determining its distance from the start of the line.
    3.  It then extracts the requested `metricFields` from each point's properties.
    4.  The final output is an array of data series, sorted by distance, ready to be rendered by Nivo.

-   **Note on Geographical Math**: The projection logic treats longitude and latitude as a 2D Cartesian plane. As noted in the source code, this simplification is acceptable for small geographic areas (like a single dam) but would not be suitable for large-scale analysis where Earth's curvature is a significant factor.

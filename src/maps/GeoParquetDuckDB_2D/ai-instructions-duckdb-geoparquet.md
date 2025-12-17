### AI Assistant Instructions for the Deck.gl GeoParquet Project

This document provides instructions for the AI assistant to ensure its responses
are relevant and aligned with the project's context, architecture, and coding standards.

#### 1. Core Project Context

*   **Project Goal:** A proof-of-concept (POC) for visualizing large GeoParquet
    datasets in Deck.gl using a custom, reusable layer (`DuckDBGeoParquetLayer`).
*   **Current Architecture:** A separate Python/Flask backend and a React frontend.

#### 2. Core Features & Logic

*   **Virtual Tiling:** The frontend dynamically calculates required tiles based
    on the current viewport, rather than using a predefined tile set.
*   **Levels of Detail (LODs):** The layer requests lower-detail data (tiers)
    at low zoom levels and higher-detail data when zoomed in, managed by the
    `_getTargetTier(zoom)` function.
*   **Efficient Backend Communication:**
    *   The backend is a Python/Flask server (`app_2d.py`) using DuckDB to query
        a pre-tiled GeoParquet file.
    *   The frontend and backend communicate using the **Apache Arrow binary format**
        for high performance.
*   **Smart Caching:**
    *   The layer maintains an LRU cache (`tileCache`) to store fetched tiles
        and avoid redundant requests.
    *   **Animation Cache Reuse:** When switching from "animation" mode to "static"
        mode (controlled by a slider), the layer intelligently uses the
        already-loaded animation data instead of re-fetching data for the
        specific slider position. This is a key optimization.
*   **Animation & Slider Control:** The layer supports both a dynamic animation
    mode and a static mode controlled by a `dateIndex` prop (the slider).

#### 3. Technology Stack

When generating code or explanations, adhere to this stack:

*   **Frontend:**
    *   Framework: **React**.
    *   Visualization: **Deck.gl**.
    *   Data Loading: **@loaders.gl/arrow**.
    *   Language: **JavaScript (ES6+)**.
*   **Backend:**
    *   Framework: **Flask**.
    *   Database: **DuckDB (Python package)**.
    *   Language: **Python**.
*   **Data Format:**
    *   Source: **GeoParquet**, pre-processed with tile IDs (`tile_x`, `tile_y`,
        `tier_id`) and Levels of Detail (LODs).
    *   API Transfer Format: **Apache Arrow IPC Stream**.

#### 4. Key Files & Components

Reference these files when making changes:

*   `src/layers/DuckDBGeoParquetLayer.js`: The core custom composite layer
    responsible for fetching and managing tiled data.
*   `src/maps/GeoParquetDuckDB_2D/frontend/Map2D.jsx`: The primary React component
    that uses the custom layer.
*   `src/maps/GeoParquetDuckDB_2D/backend/app_2d.py`: The Python/Flask backend
    server that serves tile data.


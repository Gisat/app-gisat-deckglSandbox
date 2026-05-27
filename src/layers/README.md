# ArrowLODTileLayer

A high-performance, backend-agnostic [Deck.gl](https://deck.gl/) layer designed to render massive spatial datasets (like EGMS InSAR point clouds) at 60fps. 

To achieve zero-copy GPU rendering, this layer bypasses traditional JSON/GeoJSON parsing. Instead, it relies on spatial bounding-box tiling, custom Level of Detail (LOD) tiers, and direct memory-mapped streaming using the **Apache Arrow IPC format**.

> ### ⚠️ Status: Under Development
> Please note that this layer and its data pipeline are in active development. Currently, the LOD tier thresholds (e.g., distributing exactly 5% of points to Tier 0, 35% to Tier 1) and grid sizes are manually adjusted for our specific EGMS testing dataset. In future iterations, these density distributions will become dynamically configurable application parameters.

---

## 🛠️ Data Pipeline: How to Prepare Your Data

This layer requires data to be pre-processed into a specific tiled and tiered structure before being served. Do not load raw CSVs or raw PostGIS geometries directly into this layer.

We provide a Python pre-processing script to handle this automatically:
**Path:** `src/data_pipeline/generate_tiled_geoparquet.py`

This script takes a raw CSV file and performs critical optimizations:
1. **Grid Tiling (`tile_x`, `tile_y`):** Assigns points to a spatial grid (default 0.06°) to enable bounding-box culling.
2. **LOD Tiers (`tier_id`):** Distributes points into LOD groups for smooth rendering at global and local scales without overwhelming the browser.
3. **Spatial Sorting:** Sorts the data physically on disk (via a Hilbert curve) to ensure backend database queries are lightning-fast.
4. **Coordinate Flattening:** Extracts coordinates into flat `Float32` arrays (`longitude`, `latitude`) to bypass expensive WKB/GeoJSON parsing in the frontend.

**How to generate your data:**
1. Open `src/data_pipeline/generate_tiled_geoparquet.py`.
2. Modify the `INPUT_CSV_PATH` to point to your raw CSV file.
3. Modify the `OUTPUT_PARQUET_PATH` to your desired destination.
4. Run the script: `python src/data_pipeline/generate_tiled_geoparquet.py`.
5. Load the resulting `.geoparquet` file into your database (e.g., PostGIS, DuckDB).

---

## 🔌 The Backend Data Contract

This layer is backend-agnostic. You can serve the data using any database or API server, as long as your `/api/data` endpoint fulfills the following strict contract.

### 1. The HTTP Request
The layer will automatically request tiles based on the Deck.gl viewport. Your API must accept `GET` requests with the following query parameters:
* `tile_x` (Integer) & `tile_y` (Integer): The grid coordinates calculated during pre-processing.
* `tier` (Integer): The LOD level requested (0 = global overview, 1 = mid, 2 = deep).
* `mode` (String): e.g., `static` or `animation`.
* `date_index` (Integer): Index for filtering time-series arrays.

*Example Request:* `GET /api/data?tile_x=10&tile_y=5&tier=1&mode=static`

### 2. The HTTP Response
* **Format:** The endpoint MUST return a binary Apache Arrow IPC Stream.
* **Content-Type Header:** `application/vnd.apache.arrow.stream`

### 3. The Required Schema (No WKB Geometries!)
To maintain zero-copy performance to the GPU, **your backend must not return standard spatial geometries (like WKB or GeoJSON).** The Arrow table must contain flat numeric columns.

**Required Columns:**
* `longitude` (Float32 Array)
* `latitude` (Float32 Array)

**Optional Data Columns:**
* Multi-dimensional arrays for time series (e.g., `displacements: Float32[]`)
* Any numerical metric you want to visualize (e.g., `height: Float32`, `mean_velocity: Float32`)
* Point Identifiers (e.g., `point_id`)

*(Note for PostGIS backends: Use `ST_X(geom)::real AS longitude` and `ST_Y(geom)::real AS latitude` in your SQL queries rather than selecting the raw `geom` column).*

---

## 💻 Usage Examples (2D and 3D)

Because the layer is generic, you map the binary columns from your Arrow stream directly to the Deck.gl visual properties using standard accessors. You control whether the map is 2D or 3D purely by adjusting the Deck.gl sub-layer properties.

```jsx
import React, { useState } from 'react';
import DeckGL from '@deck.gl/react';
import { ScatterplotLayer, PointCloudLayer } from '@deck.gl/layers';
import ArrowLODTileLayer from '../layers/ArrowLODTileLayer';

function MapComponent() {
  const [viewMode, setViewMode] = useState('2D'); // Toggle between '2D' and '3D'

  const layer = new ArrowLODTileLayer({
    id: 'arrow-lod-layer',
    dataUrl: '[http://your-server.com/api/data](http://your-server.com/api/data)', // Your Arrow-compliant backend API
    
    // Grid configuration (must match the Python script's output)
    gridSize: 0.06, 
    
    // Application State
    dateIndex: 0,
    mode: 'static',
    is3D: viewMode === '3D', // Tells backend whether to fetch the height column

    // Map your Arrow columns directly to Deck.GL visual attributes
    columnMap: {
      latitude: 'latitude',
      longitude: 'longitude',
      height: 'height',
      size: 'mean_velocity',
      color: 'displacement'
    },
    
    // Render the data as a 2D Scatterplot or 3D Point Cloud
    renderSubLayers: (props) => {
      
      // 2D VIEW: Standard flat map points
      if (viewMode === '2D') {
        return new ScatterplotLayer({
          ...props,
          id: `${props.id}-scatter-2d`,
          getPosition: d => [d.longitude, d.latitude], // Flat X, Y
          getFillColor: d => calculateColor(d.displacement),
          getRadius: d => d.mean_velocity || 1,
          radiusMinPixels: 2
        });
      }

      // 3D VIEW: True 3D points factoring in elevation/height
      if (viewMode === '3D') {
        return new PointCloudLayer({
          ...props,
          id: `${props.id}-pointcloud-3d`,
          getPosition: d => [d.longitude, d.latitude, d.height || 0], // X, Y, Z
          getColor: d => calculateColor(d.displacement),
          pointSize: 3
        });
      }
    },

    onStatusChange: ({ isLoading, totalPoints }) => {
      console.log(`Loading: ${isLoading}, Points rendered: ${totalPoints}`);
    }
  });

  return (
    <div>
      <button onClick={() => setViewMode(viewMode === '2D' ? '3D' : '2D')}>
        Toggle {viewMode === '2D' ? '3D' : '2D'}
      </button>
      
      <DeckGL
        initialViewState={{ 
          longitude: 14.42, 
          latitude: 50.08, 
          zoom: 11,
          pitch: viewMode === '3D' ? 45 : 0 // Tilt the camera for 3D view
        }}
        controller={true}
        layers={[layer]}
      />
    </div>
  );
}

export default MapComponent;
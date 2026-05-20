# duckdb large vector - point selection: fe-core reuse analysis

## what fe-core implemented

your colleague built `MapSelectionByGeometryDemo` — an interactive map that lets users draw polygon/circle/line geometries to spatially query InSAR measurement points from a backend. it uses:

- `@gisatcz/ptr-fe-core` — GISAT's enterprise map framework (OpenLayers-based, Redux state)
- Next.js API routes as backend proxy
- Mantine UI components
- Panther persistent state for cross-session persistence

**relevant source files** (read-only reference):
```
fe-core/src/features/demos/maps/mapSet/MapSelectionByGeometryDemo/
  MapSelectionByGeometryClient.tsx  — main component (state, handlers, UI)
  constants.ts                      — selection colours, mode types
  state.ts                          — initial app state shape
  InsarStatsPanel.tsx               — stats sidebar after selection

fe-core/src/features/shared/helpers/
  selectionByGeometryHelpers.ts     — geometry normalization + backend fetch logic
  
fe-core/src/features/demos/maps/mapSet/MapGeometryDrawing/
  GeometryControlButtons.tsx        — mode selector UI component
  LineBufferControls.tsx            — line buffer/cap controls
```

---

## what you can reuse (and how)

### ✅ 1. geometry normalization logic — copy directly

**source**: `selectionByGeometryHelpers.ts` lines 37-79

All three modes — polygon, circle, line — are **converted to a GeoJSON Polygon before sending to the backend**. The backend always receives a plain polygon and uses `ST_Within()`. This means **all three modes are handled identically on the backend**.

```js
// POLYGON: close if not already closed
const coords = [...geometryCoordinates];
const first = coords[0];
const last = coords[coords.length - 1];
if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([...first]);
}
geometry = { type: 'Polygon', coordinates: [coords] };

// CIRCLE: center + edge point → radius → approximate 64-point polygon
// geometryCoordinates[0] = center [lon, lat]
// geometryCoordinates[1] = edge point [lon, lat]
// → compute radiusMeters via haversine, generate polygon ring

// LINE: polyline + buffer distance → corridor polygon
// geometryCoordinates = [[lon,lat], [lon,lat], ...]
// bufferMeters: user-controlled slider (e.g. 200m)
// capStyle: 'round' (hemispherical ends) or 'flat' (squared ends)
// → buildLineBufferPolygon() generates the corridor outline as a polygon ring
```

**adaptation needed per mode**:

| mode | fe-core function | your implementation |
|------|-----------------|---------------------|
| polygon | none needed | copy closing logic directly |
| circle | `buildCirclePolygon(center, radius)` | reimplement: generate 64-point ring from center + haversine radius |
| line | `buildLineBufferPolygon(coords, bufferMeters, capStyle)` | reimplement: offset each segment by buffer, connect with round/flat caps |

**line buffer function** (what you need to reimplement — fe-core's is internal):
```js
// simplified version without round caps (flat cap only, good enough for MVP)
function buildLineBufferPolygon(lineCoords, bufferMeters) {
    // for each segment, compute perpendicular offset vectors
    // union left-side offsets + right-side offsets reversed = corridor polygon
    // see: https://en.wikipedia.org/wiki/Parallel_curve
    // or use turf.js: turf.buffer(turfLineString, bufferMeters, { units: 'meters' })
}
```

**recommendation**: use `@turf/buffer` from `turf.js` — it handles the maths for all three modes and is a small focused package. fe-core reimplemented this internally; you don't need to.

---

### ✅ 2. backend fetch + response parsing — copy ~80%

**source**: `selectionByGeometryHelpers.ts` lines 81-122

```js
// POST geometry to backend
const response = await fetch(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, geometry }),
});

if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new Error(`Failed: ${response.status} — ${JSON.stringify(errorBody)}`);
}

const data = await response.json();
const rawFeatures = data?.features ?? data; // handles wrapped & unwrapped responses

// deduplicate by id
const seen = new Set();
const featureKeys = [];
for (const feature of rawFeatures) {
    const key = feature.id ?? feature.properties?.fid;
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    featureKeys.push(key);
}
return featureKeys;
```

**your adapted version** (change endpoint + payload):
```js
async function selectByGeometry(geometry, geoparquetPath) {
    const response = await fetch('http://localhost:5000/api/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry, geoparquet_path: geoparquetPath }),
    });

    if (!response.ok) {
        const err = await response.json().catch(() => null);
        throw new Error(`Selection failed: ${response.status} — ${JSON.stringify(err)}`);
    }

    const data = await response.json();
    const rawFeatures = data?.features ?? data;
    if (!Array.isArray(rawFeatures)) throw new Error('Unexpected response format.');

    const seen = new Set();
    const selected = new Set();
    for (const feature of rawFeatures) {
        const id = feature.id ?? feature.properties?.fid;
        if (id == null || seen.has(id)) continue;
        seen.add(id);
        selected.add(id);
    }
    return selected; // Set of selected feature IDs
}
```

---

### ✅ 3. selection mode UI — copy pattern, remove Mantine dependency

**source**: `GeometryControlButtons.tsx` + `MapSelectionByGeometryClient.tsx`

fe-core's pattern:
```tsx
const [selectionMode, setSelectionMode] = useState('polygon');

const handleModeChange = (mode) => {
    setSelectionMode(mode);
    // geometry modes: disable ctrl+click interactivity
    // click mode: enable ctrl+click interactivity
    if (mode !== 'click') updateDrawing({ mode });
};

// dynamic segment list
const segments = [
    { label: 'Polygon', value: 'polygon' },
    { label: 'Circle', value: 'circle' },
    ...(enableLineMode ? [{ label: 'Line', value: 'line' }] : []),
    ...(enableClickMode ? [{ label: 'Click', value: 'click' }] : []),
];
```

**your adapted version** (plain HTML, no Mantine):
```jsx
const [selectionMode, setSelectionMode] = useState('polygon');
const [isDrawingActive, setIsDrawingActive] = useState(false);

const handleModeChange = (mode) => {
    setSelectionMode(mode);
    setIsDrawingActive(false); // reset drawing when mode changes
    if (mode === 'click') {
        setPickingEnabled(true);    // enable DeckGL picking
    } else {
        setPickingEnabled(false);   // geometry mode: disable layer picking
    }
};
```

---

### ✅ 4. colour palette — copy directly

**source**: `constants.ts` lines 19-28

```js
// copy as-is, rename to match your conventions
export const SELECTION_COLORS = [
    '#42d4f4', '#e15dda', '#f58231', '#e6194B',
    '#25b537', '#4363d8', '#6a632f', '#aaffc3',
];
```

**single vs distinct toggle** (from `MapSelectionByGeometryClient.tsx`):
```jsx
const [colourMode, setColourMode] = useState('single'); // 'single' | 'distinct'

// in ScatterplotLayer.getFillColor:
getFillColor: (rowIndex) => {
    const key = `${tableIndex}-${rowIndex}`;
    if (!selectedPoints.has(key)) {
        return selectedPoints.size > 0
            ? [originalR, originalG, originalB, 60]  // dim unselected
            : [originalR, originalG, originalB, 200]; // normal
    }
    if (colourMode === 'single') {
        return hexToRgb(SELECTION_COLORS[0]);
    }
    const idx = Array.from(selectedPoints).indexOf(key);
    return hexToRgb(SELECTION_COLORS[idx % SELECTION_COLORS.length]);
},
updateTriggers: { getFillColor: [selectedPoints, colourMode] },
```

---

### ✅ 5. selection state management — copy pattern, adapt to React hooks

**source**: `MapSelectionByGeometryClient.tsx` lines 208-280

fe-core uses Redux dispatch. your version with React hooks:

```jsx
const [selectedPoints, setSelectedPoints] = useState(new Set());

// bulk set (after geometry query returns)
const handleSelectPoints = (ids) => setSelectedPoints(new Set(ids));

// remove one
const handleRemovePoint = (id) => setSelectedPoints(prev => {
    const next = new Set(prev);
    next.delete(id);
    return next;
});

// clear all
const handleClearSelection = () => setSelectedPoints(new Set());
```

fe-core also has a **"clear geometry + clear selection"** split (two separate actions). you should mirror this: clearing the drawn shape is separate from clearing the selection state. both are needed because the user may want to re-draw without losing the current selection.

---

## what you cannot reuse

| fe-core component | reason not reusable |
|---|---|
| `@gisatcz/ptr-fe-core` package | enterprise dep, OpenLayers-based, not compatible with Deck.GL |
| Redux dispatch / shared state | your app uses local React state |
| `MapSet` wrapper component | your app uses bare `<DeckGL>` |
| `buildCirclePolygon()` / `buildLineBufferPolygon()` | internal to ptr-fe-core; reimplement |
| Panther persistent state | your app has no persistence layer |
| Mantine UI components | not installed; use plain HTML or add Mantine |
| Next.js API routes | your backend is Flask, not Next.js |

---

## the full goal: selection → graphs

clarifying the intended data flow before describing the backend:

```
user draws polygon / circle / line+buffer on map
         ↓
frontend converts all modes to a GeoJSON Polygon (corridor for line)
         ↓
frontend sends polygon geometry to /api/select
         ↓
DuckDB: ST_Within(point, polygon) → returns ALL columns for matched points
         ↓
frontend receives per-point time-series data
         ↓
  ┌──────┴───────────┐
  ▼                  ▼
highlight selected   render charts (displacement over time,
points on map        velocity distribution, etc.)
```

**line selection note**: the backend always receives a plain GeoJSON Polygon — it never needs to know the user drew a line. the frontend is responsible for converting the drawn line + buffer distance into a corridor polygon before sending. `ST_Within()` works identically for polygon, circle, and line modes.

**why this matters**: the current `/api/data` endpoint intentionally fetches a minimal column set for fast tile rendering (only `longitude, latitude, displacement`). the full GeoParquet contains columns not used for rendering — `dates` (full array), `displacements` (full time series), `mean_velocity`, `height`, and potentially others. these are what you need for graphs. **the selection endpoint must return these extra columns**, not just spatial coordinates.

---

## what the backend needs: new `/api/select` endpoint

```python
# routes.py — new endpoint
from flask import request, jsonify
import json, traceback

@bp.route('/select', methods=['POST'])
def select_by_geometry():
    try:
        body = request.get_json()
        geometry = body.get('geometry')          # GeoJSON Polygon geometry
        geoparquet_path = body.get('geoparquet_path')
        longitude_col = body.get('longitude_col', 'x')
        latitude_col = body.get('latitude_col', 'y')

        if not geometry:
            return jsonify({'error': 'geometry required'}), 400

        db = Database(geoparquet_path)
        geojson_str = json.dumps(geometry)

        # return ALL columns useful for graphing — not just lon/lat
        # dates + displacements are the full time series needed for charts
        # mean_velocity, height are extra attributes for analysis
        query = f"""
        SELECT
            {longitude_col} AS longitude,
            {latitude_col}  AS latitude,
            displacements,
            dates,
            mean_velocity,
            height
        FROM egms_data
        WHERE ST_Within(
            ST_Point({longitude_col}, {latitude_col}),
            ST_GeomFromGeoJSON(?)
        )
        """
        result = db.get_conn().execute(query, [geojson_str]).fetchall()

        features = []
        for i, row in enumerate(result):
            lon, lat, displacements, dates, mean_velocity, height = row
            features.append({
                'type': 'Feature',
                'id': i,
                'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
                'properties': {
                    'displacements': list(displacements) if displacements else [],
                    'dates': [d.strftime('%Y-%m-%d') for d in dates] if dates else [],
                    'mean_velocity': mean_velocity,
                    'height': height,
                }
            })

        return jsonify({'type': 'FeatureCollection', 'features': features})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500
```

**note**: DuckDB spatial extension is already installed in `db.py` (`INSTALL spatial; LOAD spatial;`).

**important**: column names (`x`/`y` vs `longitude`/`latitude`) must match your GeoParquet schema. pass them as body params or hard-code after confirming the schema.

**response size**: if the user selects many points (>500), each with a full `displacements` array (e.g. 100 timestamps), the response can get large. consider adding a `LIMIT` or a `max_points` guard on the backend.

---

## what the frontend does with the response

```jsx
const [selectedFeatures, setSelectedFeatures] = useState([]); // full feature data for charts
const [selectedPoints, setSelectedPoints] = useState(new Set()); // lon/lat keys for map highlighting

const handleSelectByGeometry = async (geometry) => {
    setIsFetchingSelection(true);
    try {
        const response = await fetch('http://localhost:5000/api/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geometry, geoparquet_path: geoparquetPath }),
        });
        const data = await response.json();
        const features = data.features ?? [];

        // for map highlighting: identify which visible Arrow table rows match
        // simplest approach: match by coordinate (lon/lat)
        const coordSet = new Set(
            features.map(f => `${f.geometry.coordinates[0].toFixed(5)}_${f.geometry.coordinates[1].toFixed(5)}`)
        );
        setSelectedPoints(coordSet);  // used in ScatterplotLayer.getFillColor

        // for graphs: store full feature data
        setSelectedFeatures(features);
    } finally {
        setIsFetchingSelection(false);
    }
};
```

**note on ID matching**: the current visualization Arrow tables don't carry a row ID — they only have `longitude, latitude, displacement`. to match selected features back to Arrow table rows for highlighting, match on rounded coordinates (as above). **recommended: add a `point_id` column to the `/api/data` response** — enables exact matching and unlocks a cleaner `/api/timeseries?ids=[...]` endpoint in phase 3.

---

## implementation plan

### phase 1 — drawing UI (frontend only, highlights visible cached points)
effort: ~4 hours | no backend changes needed

what this does:
- user draws **polygon / circle / line+buffer** on map
- frontend converts drawn geometry to a GeoJSON Polygon using `turf.js` (circle → polygon ring; line → corridor polygon)
- frontend tests each visible Arrow table row against the polygon using `pointInPolygon()`
- only points already loaded into the tile cache are selectable
- no time-series data is available yet for graphs (Arrow tables only contain `displacement` for one timestamp in static mode)

- [ ] `npm install @turf/buffer @turf/circle @turf/helpers` (`@turf/circle` for circle→polygon, `@turf/buffer` for line→corridor)
- [ ] create `SelectionControls.jsx` with mode toggle: **polygon / circle / line / click** + draw/clear buttons  
- [ ] implement canvas drawing overlay on top of `<DeckGL>`:
  - polygon: click vertices, double-click to close
  - circle: click center, drag to set radius
  - line: click to add waypoints, shows preview of corridor
- [ ] for line mode: add **buffer distance slider** (reuse fe-core `LineBufferControls.tsx` pattern) + cap style toggle (round/flat)
- [ ] before filtering, convert geometry: `turf.buffer(lineString, bufferMeters, { units: 'meters' })` or `turf.circle(center, radiusMeters, { units: 'meters' })`
- [ ] implement `pointInPolygon()` utility for Arrow table rows
- [ ] wire `selectedPoints` state into `ScatterplotLayer.getFillColor` (highlight + dim others)
- [ ] add selected count to HUD

**limitation**: no chart data yet — Arrow tiles only carry one timestamp's displacement in static mode. graphing requires phase 2.

---

### ⚠️ before starting phase 2 — verify GeoParquet schema

run this against your actual GeoParquet to confirm exact column names before writing the `/api/select` query:

```sql
-- option 1: DuckDB information schema
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'egms_data';

-- option 2: quick describe
DESCRIBE SELECT * FROM read_parquet('/path/to/egms_optimized_be.geoparquet') LIMIT 0;
```

check:
- lon/lat columns: `x`/`y` or `longitude`/`latitude`?
- time series array: `displacements` or something else?
- dates array: `dates` or `timestamps`?
- extra attributes available for graphing beyond `mean_velocity` and `height`?

the backend `/api/select` code uses `x`/`y` as defaults — update if the actual names differ.

---

### phase 2 — backend spatial query + graph data (the real feature)
effort: ~3 hours | this is the meaningful step

what this does:
- user draws polygon / circle / line → frontend converts to GeoJSON Polygon → POST to `/api/select`
- DuckDB queries the **full GeoParquet** (not just visible tiles): `ST_Within()` spatial filter
- backend returns `displacements[]`, `dates[]`, `mean_velocity`, `height` for ALL matching points
- frontend highlights selected points on map AND renders time-series charts
- **line mode is fully supported**: backend only ever sees a polygon, regardless of how it was drawn

- [ ] add `/api/select` endpoint to `routes.py` (see backend code above)
- [ ] adapt `selectByGeometry()` fetch helper from fe-core pattern; ensure turf.js conversion happens before the POST for circle and line modes
- [ ] store `selectedFeatures` (full time-series) in state
- [ ] highlight matching points on map (coordinate matching against visible tiles)
- [ ] render displacement-over-time chart for selected points (one line per point)
- [ ] handle loading state and large response guard (`LIMIT`)

---

### phase 3 — graph panel + polish
effort: ~2-3 hours

- [ ] add chart component — options: **Plotly.js** (2D + 3D plots, built-in interactivity), recharts, chart.js — decide on the go
- [ ] show summary stats: count, mean velocity, displacement range
- [ ] single/distinct colour toggle (from fe-core pattern) — same colour in chart as on map
- [ ] remove individual point from selection
- [ ] error handling for empty or oversized selections
- [ ] add `max_points` guard on backend (warn user if selection too large)

---

### phase 4 — 3D selection (Map3D.jsx)
effort: ~2 hours | ~80% shared with 2D implementation

**approach**: selection in 3D uses the same 2D horizontal footprint logic. points are selected by `ST_Within(lon, lat, polygon)` — **height is never part of the spatial query**. this is correct for InSAR: you select measurement points by their ground location, regardless of how high they appear in the 3D scene.

**visual feedback**: instead of extruding the selection polygon into a 3D wall (which looks misleading at pitch angles), the drawn shape is rendered as a **flat polygon clamped to the ground surface** using a `GeoJsonLayer`:

```jsx
// add alongside SimpleMeshLayer in the layers array
new GeoJsonLayer({
    id: 'selection-shape',
    data: drawnPolygon,                    // GeoJSON Polygon (same object sent to /api/select)
    filled: true,
    stroked: true,
    getFillColor: [66, 212, 244, 40],      // semi-transparent cyan fill
    getLineColor: [66, 212, 244, 220],
    lineWidthMinPixels: 2,
    // no getElevation — stays flat at ground level
}),
```

this is visible and readable from any pitch/bearing angle. for line mode, the corridor polygon is rendered the same way.

**sphere highlighting** (replaces 2D scatter dot highlighting):
```jsx
// in SimpleMeshLayer:
getColor: (d) => {
    const key = `${d.longitude.toFixed(5)}_${d.latitude.toFixed(5)}`;
    if (selectedPoints.has(key)) return hexToRgb(SELECTION_COLORS[0]); // highlight
    return selectedPoints.size > 0
        ? [...colorScale(d.displacement), 60]   // dim unselected
        : [...colorScale(d.displacement), 220];  // normal
},
updateTriggers: { getColor: [selectedPoints] },
```

**what is shared with 2D (copy directly)**:
- `SelectionControls.jsx` — identical component
- turf.js geometry conversion — identical
- `selectByGeometry()` fetch helper — identical (same `/api/select` endpoint)
- `selectedPoints` / `selectedFeatures` state pattern — identical
- chart panel — identical (same time-series data)

**what differs from 2D**:
- `GeoJsonLayer` for ground-clamped shape feedback (instead of canvas overlay)
- `getColor` on `SimpleMeshLayer` instead of `getFillColor` on `ScatterplotLayer`

- [ ] import and reuse `SelectionControls.jsx` from 2D implementation
- [ ] add `GeoJsonLayer` for ground-clamped selection shape (polygon / corridor / circle ring)
- [ ] wire `selectedPoints` into `SimpleMeshLayer.getColor`
- [ ] reuse `selectByGeometry()` fetch helper — no changes needed
- [ ] reuse chart panel from phase 3 — no changes needed

---

## effort summary

| task | effort | fe-core reuse |
|------|--------|---------------|
| drawing UI (polygon/circle/line) | 2-3h | 60% (UI pattern copied, drawing rebuilt) |
| geometry normalization | 0.5h | 90% (near-direct copy) |
| backend `/api/select` with full columns | 1.5-2h | 10% (different backend architecture) |
| fetch + parse helper | 1h | 80% (change endpoint + payload) |
| map highlighting (2D) | 0.5h | 50% (colour palette copied, layer logic rebuilt) |
| charts panel | 2-3h | 20% (InsarStatsPanel concept; chart lib is new) |
| 3D selection (phase 4) | 2h | 80% (shared with 2D; only layer + shape feedback differ) |
| npm package (phase 5) | 2-3h | n/a (new work, layer code already done) |
| **total** | **~12-16h** | **~50-60%** |

---

### phase 5 — npm package `@gisat/deckgl-duckdb-geoparquet`
effort: ~2-3 hours | do after selection feature is stable

**the three-part split**:

```
npm package  @gisat/deckgl-duckdb-geoparquet
─────────────────────────────────────────────
DuckDBGeoParquetLayer.js only
"plug into any Deck.GL app against any backend"

reference backend  (stays in this repo)
─────────────────────────────────────────────
Flask + DuckDB + GeoParquet
"one way to serve the data — implement your own if needed"
documents the API contract (GET /api/data, Arrow IPC response)

this sandbox repo = the demo app
─────────────────────────────────────────────
Map2D + Map3D + selection + charts
"full working stack — getting started reference"
```

**why only the layer goes into the package**: the layer is backend-agnostic — it only cares that the backend returns Arrow IPC with the right columns. the backend and UI are reference implementations, not reusable library code.

**package contents**:
```
src/
  DuckDBGeoParquetLayer.js   ← the layer, as-is (already generic via props)
  index.js                   ← export DuckDBGeoParquetLayer + DEFAULT_PROPS
package.json
  name: "@gisat/deckgl-duckdb-geoparquet"
  peerDependencies:
    "@deck.gl/core": ">=9"
    "@loaders.gl/core": ">=4"
    "@loaders.gl/arrow": ">=4"
  build: vite lib mode (outputs ESM + CJS)
README.md
  usage example
  backend API contract (expected params + Arrow IPC response schema)
  → link to this sandbox repo for full demo
  → link to src/backend/ for reference Flask implementation
```

**do after phase 3/4** — the selection feature will likely add an `onSelectionChange` callback prop to the layer. package the stable API, not a moving target.

- [ ] extract `DuckDBGeoParquetLayer.js` into a new repo (or subdirectory with its own `package.json`)
- [ ] set up vite lib mode build (ESM + CJS output)
- [ ] write package README with API contract + links to this sandbox
- [ ] publish to npm under `@gisat` org
- [ ] replace local import in Map2D and Map3D with the npm package

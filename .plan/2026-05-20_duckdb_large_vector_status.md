# duckdb large vector - current status

## what is built

a multi-tier LOD system for visualizing large GeoParquet datasets (EGMS InSAR points, ~Prague area) via a Flask+DuckDB backend, with both 2D and 3D Deck.GL frontends.

**component map**

```
src/
├── maps/GeoParquetDuckDB_2D/frontend/
│   ├── Map2D.jsx              — main view, ScatterplotLayer, time controls
│   ├── components/HUD.jsx     — zoom/tier/cache/status display
│   └── components/PlaybackControls.jsx — mode toggle, time slider, play/pause
├── maps/GeoParquetDuckDB_3D/frontend/
│   └── Map3D.jsx              — same as 2D but SimpleMeshLayer (spheres)
├── layers/DuckDBGeoParquetLayer.js — core composite layer (502 LOC)
└── backend/
    ├── app/routes.py          — /api/dates, /api/data
    ├── app/db.py              — DuckDB in-memory connection
    └── wsgi.py                — gunicorn entry point
```

---

## architecture: how it works

### LOD tiling strategy

```
zoom < 13   → Tier 0 — global query, 5% of data (overview)
zoom 13-14  → Tier 1 — per-tile query, ~35% of data
zoom ≥ 15   → Tier 2 — per-tile query, 100% of data
```

tiles are identified by `(tile_x, tile_y, tier_id)` columns pre-baked into the GeoParquet file.

### data flow per viewport change

```
viewport change in DeckGL
  → DuckDBGeoParquetLayer._fetchTiles(viewport)
  → calculate visible tile grid from viewport bounds + gridSize (0.06°)
  → check tileCache (LRU Map, max 200 entries)
  → batch-fetch missing tiles: GET /api/data?tile_x=&tile_y=&tier=&mode=...
  → backend: DuckDB queries GeoParquet, returns Arrow IPC stream
  → ArrowLoader parses response into Arrow table
  → tables stored in tileCache, rendered via renderSubLayers callback
```

### caching

- **LRU map** (insertion-order): oldest entries evicted when size > 200
- **Tier 0 protected**: never evicted from cache
- **smart reuse**: animation tiles (full time array) reused in static mode — avoids double fetch
- **deduplication**: `pendingRequests` Set prevents duplicate in-flight requests

### modes

| mode | what backend fetches | tile cache key |
|------|---------------------|---------------|
| static | `displacements[date_index]` → single float | `{x}_{y}_T{t}_static_{dateIndex}` |
| animation | full `displacements` array | `{x}_{y}_T{t}_anim` |

static mode debounces `timeIndex` by 500 ms before fetching to avoid rapid slider requests.

### data model (Arrow table columns)

2D: `longitude, latitude, displacement` (or `displacements` in animation)  
3D: adds `height, mean_velocity`  
columns are configurable via `columnMap` prop on the layer.

---

## what works well

- **smart caching** with LRU and T0 protection is solid
- **animation tile reuse** in static mode is a real performance win
- **pre-cached Arrow column references** in `_processArrowTables()` avoid repeated `.getChild()` calls
- **request deduplication** via `pendingRequests` Set
- **debounced static mode** prevents flooding the backend while scrubbing time slider
- **HUD + PlaybackControls** give clear feedback on tier, point count, loading state

---

## known issues

### 🔴 blocking bugs

**1. tier filtering is broken in backend**  
`routes.py` passes `tier_id = ?` in the WHERE clause for tiled queries — but this is **not present in the global query** path, and tier filtering needs to be verified against the actual parquet schema. The backend does not check whether `tier_id` exists as a column before executing.

```python
# current — tier is only used in tiled path, not validated
WHERE tile_x = ? AND tile_y = ? AND tier_id = ?
```

**2. date indexing offset assumption**  
`db_index = date_index + 1` assumes 1-based array indexing in DuckDB. This is correct for DuckDB's 1-indexed `LIST` arrays, but is not documented or guarded. If a date_index of 0 is passed for an empty array, it crashes silently.

**3. hard-coded local path in frontend**  
`geoparquetPath` is set to `/Users/marianakecova/GST/...` in both Map2D.jsx and Map3D.jsx. This only works on one machine.  
Fix: use `import.meta.env.VITE_GEOPARQUET_PATH` or pass via URL param.

### 🟡 performance gaps

**4. `_reGatherData` rebuilds all tile tables on every fetch completion**  
iterates the full tile grid every time. Could be optimized by tracking only deltas.

**5. no viewport bounds caching**  
`_fetchTiles` recalculates grid bounds from scratch on every call, including on minor pan moves that don't change the tile set.

**6. no tier pre-check**  
backend has no `/api/schema` endpoint to verify column names exist before queries run. A missing column causes a 500 and the tile is silently cached as empty `[]`.

### 🟢 missing features

**7. no point selection** — users cannot select individual points or regions → this is the next feature to implement (see selection doc)

**8. no cache persistence** — full reload on page refresh; no IndexedDB caching

**9. no retry logic** — failed tile requests are cached as `[]` permanently until page reload

---

## component breakdown

| file | LOC | status | notes |
|------|-----|--------|-------|
| DuckDBGeoParquetLayer.js | 502 | ✅ solid | core logic, well-structured |
| Map2D.jsx | 210 | ⚠️ functional | hard-coded path, no selection |
| Map3D.jsx | 218 | ⚠️ functional | hard-coded path, no selection |
| routes.py | 78 | ⚠️ issues | tier filtering unvalidated, no /select |
| db.py | 19 | ✅ ok | simple, works |
| HUD.jsx | 20 | ✅ ok | clear, minimal |
| PlaybackControls.jsx | 82 | ✅ ok | good UX |

---

## next: point selection feature

the next planned feature is spatial selection of points by drawing geometry on the map (polygon, circle, click). this requires:

1. **frontend**: drawing UI + geometry state management
2. **backend**: new `/api/select` POST endpoint using DuckDB spatial `ST_Within()`
3. **layer**: `selectedPoints` state passed to `ScatterplotLayer.getFillColor`

see `duckdb_large_vector_point_selection_fe_core.md` for the implementation plan and fe-core reuse strategy.

---

## running

```bash
# backend
export GEOPARQUET_PATH='/path/to/egms_optimized_be.geoparquet'
cd src/backend
gunicorn --bind 0.0.0.0:5000 wsgi:application

# frontend
npm run dev
```

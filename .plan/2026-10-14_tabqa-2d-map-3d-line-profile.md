# Plan: Tabqa 2D map + "3D line profile" in the 3D Feature Scatter Chart app

> Renamed from `.kilo/plans/1791885138710-tabqa-3d-line-profile.md` onto the dated
> `.plan/` convention. Implemented and committed (see "Post-implementation notes"
> at the end).

## Goal
Convert `src/maps/FeatureScatterChart3D` into a **Tabqa (Syria) 2D map** whose chart
panel offers **two mutually exclusive 3D chart modes**: the existing 3D feature-space
**scatter**, and a new **3D line profile** (multi-series lines + uncertainty ribbons).
The flag that disabled the profile (`showLineProfileToggle={false}`) is replaced by a
**panel-header mode toggle**, so the profile is available again but the `SelectionControls`
`2D Profile` checkbox stays disabled.

## Locked decisions
1. Keep the app name/route: `3D Feature Scatter Chart` / `/3d-feature-scatter-chart`
   (no `config.js` change). Only the map/data/chart contents change.
2. **Map = 2D** (flat): OSM basemap + relief "glaze" `CogBitmapLayer` copied from
   `Tabqa_dam`; pitch 0, no rotate. Remove the Czech `CogTerrainLayer`/DEM and 3D drawing.
3. **Charts stay 3D.** One docked panel with a header toggle: `Scatter | 3D line profile`.
   Default mode = **Scatter**. Panel still opens by default (`showFeatureSpace=true`).
4. Dataset = `Tabqua_LOS_selected.geojson` (Tabqa, Syria).
5. **3D line profile** reuses the existing three renderers (Plotly / deck.gl / three) and
   their switcher. Three dimensions, selectable mode:
   - **Along line:** X = distance along the drawn line (m), Y = series value, Z = elevation (`H`).
   - **Geo path:** X = lon, Y = lat, Z = elevation (`H`); **single active series, no ribbon**.
6. **Multi-series selectable**, each with its own uncertainty ribbon. Default on:
   `VEL_REL` (+`VEL_SD`), `VEL_LAST` (+`SVEL_LAST`), `LT_365` (+`LTS_365`).
   Also selectable: `TD_90/180/365/730` (+`STD_90/180/365/730`).
7. Band = **filled translucent ribbon** (`value−std … value+std`), series-coloured, plus a
   centre line and points.
8. Scatter attribute metadata is **fully remapped** to Tabqa fields with re-pointed presets.
9. Keep the existing sphere `SimpleMeshLayer` for the map points (only the basemap changes).

## Current state (verified)
- `src/maps/FeatureScatterChart3D/index.jsx` — Czech dataset, `CogTerrainLayer` DEM, 3D
  drawing (`map3dDrawingClick`, `extractTerrainCoordinate`, `setDeckGLInstance`),
  `showLineProfileToggle={false}`, mounts `<FeatureSpaceChart/>`.
- `src/components/FeatureSpaceChart3D/` — portable module: `FeatureSpaceChart.jsx` (panel
  chrome + preset/custom UI), `attributes.js` (metadata + presets), `transformPoints.js`,
  `colorScale.js`, `PointTooltip.jsx`, `renderers/{Plotly,DeckGL,Three}Renderer.jsx`.
- `src/components/2DLineProfile/projectionUtils.js` — `calculateProfileData` (exported),
  `projectPointOntoLine` (private), haversine planar projection; `haversine` from
  `PointSelection/geometryUtils`.
- `src/maps/Tabqa_dam/index.jsx` — the 2D map to copy: `PRECALCULATED_GLAZE_URL` /
  `RAW_DEM_URL` + `CogBitmapLayer` config; `INITIAL_VIEW_STATE = {38.5667,35.8722,zoom 13}`;
  loads this exact dataset.

## Data & field mapping (Tabqa)
Per point: id = `properties.ID` (fallback `fid`, `feature.id`); geometry `[lon, lat]`;
elevation = `properties.H`; series live on `properties`.
| Series | Value | Std (band) |
|---|---|---|
| VEL_REL | `VEL_REL` | `VEL_SD` |
| VEL_LAST | `VEL_LAST` | `SVEL_LAST` |
| LT_365 (last trend) | `LT_365` | `LTS_365` |
| TD_90/180/365/730 | `TD_*` | `STD_*` |
Series colours (reference): VEL_REL `#2ca02c` (green), VEL_LAST `#d62728` (red),
LT_365 `#17becf` (cyan); window trends from a small extra palette.
Keys stay **UPPERCASE** to match the dataset. No `h_dtm` / `h_struct` (drop the derivation).

## Ordered tasks

1. **`src/components/FeatureSpaceChart3D/attributes.js`**
   - Replace `ATTRIBUTES`/`ATTRIBUTE_KEYS`/`AXIS_KEYS`/`COLOR_KEYS`/`SIZE_KEYS` with the
     Tabqa fields (VEL_REL, VEL_LAST, LT_365, VEL_AVG, VEL_SD, SVEL_LAST, LTS_365,
     TD_90/180/365/730, STD_90/180/365/730, H, H_SD, H_REF, COH, COH_MOD, INC_ANG, az_ang,
     REL_LEN, ACCEL, SEASONAL, VACC). Units: velocities `mm/yr`, heights `m`.
   - Presets → Kinematic `{x:VEL_REL, y:VEL_LAST, z:LT_365, color:VEL_REL, size:COH}`,
     Topographic `{x:H, y:VEL_REL, z:COH, color:VEL_REL, size:COH}`; update
     `DEFAULT_CUSTOM_AXES`. Remove `h_struct`-specific comments/derivation references.

2. **`src/components/FeatureSpaceChart3D/transformPoints.js`**
   - Drop the `h_struct` derivation; `NUMERIC_KEYS` from the new `ATTRIBUTES`.
   - `id = p.ID ?? p.fid ?? feature.id`; `idOrig = p.fid ?? null`; keep `coords`.
   - Update the `FeatureSpacePoint` typedef docblock.

3. **`src/components/FeatureSpaceChart3D/colorScale.js`**
   - Rename/retarget the map special case from `vel_rel` to `VEL_REL`
     (`MAP_VELOCITY_COLORS`, `MAP_VELOCITY_DOMAIN`; set a Tabqa-appropriate domain, e.g.
     `[-3, 3]` — see Open questions).

4. **`src/components/FeatureSpaceChart3D/PointTooltip.jsx`**
   - Replace `coh` → `COH`; `id_orig` → `fid`; format values via the new attribute metadata.

5. **`src/components/2DLineProfile/projectionUtils.js`**
   - Export `projectPointOntoLine` and add `buildProfileSeries(selectedFeatures, lineCoords,
     seriesDefs)` returning, per series, ordered samples
     `{ id, distance, lon, lat, height, value, std }` (`seriesDefs = [{key, stdKey, label, color, unit}]`).
     Reuse the existing planar projection; do not change `calculateProfileData` behaviour.

6. **Renderers — add an optional `profile` layer to `renderers/*.jsx`**
   - New prop `profile = { mode: 'along'|'geo', activeSeriesKey, series: [ {key,label,color,samples} ] }`.
   - When `profile` is set, draw (instead of the scatter cloud): per-series **centre line**,
     **points**, and — in `along` mode only — a **translucent ribbon** between `value±std`
     across distance; colour strictly by series.
     - `PlotlyRenderer`: `scatter3d` `mode:'lines+markers'` per series + `mesh3d` ribbon.
     - `DeckGLRenderer`: `PathLayer` (line) + `PolygonLayer` (ribbon quads) +
       `ScatterplotLayer`/`SimpleMeshLayer` (points); hover → `onHover(id)`.
     - `ThreeRenderer`: `Line`/`LineSegments` + a ribbon `BufferGeometry` (transparent
       `MeshBasicMaterial`, `flat`) + points; hover via raycast.
   - Axis titles: `Distance along profile [m]`, series label (`mm/yr`), `Elevation [m]`
     (along mode); or `Longitude`/`Latitude`/`Elevation [m]` (geo mode).

7. **`src/components/FeatureSpaceChart3D/FeatureSpaceChart.jsx`**
   - Add `mode` state (`'scatter'|'profile'`, default `'scatter'`), `dimMode` state
     (`'along'|'geo'`), `seriesKeys` state (default trio), `activeSeriesKey` state.
   - Accept new props `profileSeries` (precomputed by the app; full list) and
     `onPointHover` (unchanged).
   - Header gains a `Scatter | 3D line profile` toggle; in profile mode add a series
     multi-select, a `Along line | Geo path` toggle, and (geo mode) an active-series select
     (a second header row is fine). Keep the existing renderer switcher and collapse.
   - In profile mode with no line/points, render an empty state
     ("Draw a line selection to see the profile").
   - Renderer call: pass `profile={{mode: dimMode, activeSeriesKey, series: selectedSeries}}`
     (geo mode passes one series); scatter mode passes nothing.

8. **`src/maps/FeatureScatterChart3D/index.jsx`**
   - Imports: `import { CogBitmapLayer } from '@gisatcz/deckgl-geolib';` add `MapView`;
     drop `CogTerrainLayer`, `extractTerrainCoordinate`, `setDeckGLInstance`,
     `calculateProfileData`.
   - `DATA_URL` → `Tabqua_LOS_selected.geojson`.
   - `INITIAL_VIEW_STATE` → `{ longitude: 38.5667, latitude: 35.8722, zoom: 13, pitch: 0, bearing: 0 }`.
   - Layers: OSM basemap `TileLayer` + `CogBitmapLayer` glaze (copy
     `precalculatedGlaze` + `onTheFlyGlaze`, module constants from `Tabqa_dam`) + the point
     `SimpleMeshLayer` (`getPosition` uses `properties.H`, `getColor` from `VEL_REL` scale,
     `getScale` from `|VEL_REL|`).
   - Drawing: `DrawingOverlay is3D={false}`; remove the terrain-pick `onClick` and the
     `map3dDrawingClick` path; keep `controller` guards and the container `dblclick` finish.
   - `getPointId` → `properties.ID ?? properties.fid`.
   - Compute `profileSeries = buildProfileSeries(selectedFeatures, drawnLineCoords, SERIES_DEFS)`
     (`SERIES_DEFS` = trio + window trends) via `useMemo`; pass to `<FeatureSpaceChart/>`.
   - Keep `showFeatureSpace` (default `true`) + the top-right toggle button; keep
     `showLineProfileToggle={false}` on `SelectionControls`.
   - Update `applySelection` to add `point_id` from `ID` (drop `mean_velocity`/Czech fields).

## Risks / notes
- **VEL_SD pairing is ambiguous** — the file has no explicit `VEL_REL_SD`; `VEL_SD` may be
  the std of `VEL_AVG`, not `VEL_REL`. Confirm before trusting that band.
- Ribbon rendering is new geometry in all three engines; Plotly `mesh3d`, deck.gl
  `PolygonLayer` and a three `BufferGeometry` strip must each be built from the ordered samples.
- Ribbons can occlude points in orbit; keep them translucent and ideally depth-sorted.
- Plotly's `scatter3d` still cannot size markers per point (scatter mode) — pre-existing.
- This is a **breaking data swap**: the scatter's attributes/presets change; any other
  consumer of `FeatureSpaceChart3D` (only `FeatureScatterChart3D`) must be updated together.
- The dataset is `*_selected` (a subset); selection drawing still applies over it.

## Validation
- `npm run lint` (`--max-warnings 0`) and `npm run build` pass.
- `/3d-feature-scatter-chart`: OSM + glaze (no Czech terrain); points on the Tabqa dam;
  draw polygon/circle/line (2D) → selection works.
- Panel header toggles Scatter ↔ 3D line profile (default Scatter).
- Profile: draw a line → three series render as rings/segments; toggle series on/off;
  ribbons toggle with their series; `Along line` vs `Geo path` switches axes; geo mode shows
  one active series with no ribbon; hover highlights the map point and clears on unhover.
- Scatter: Tabqa attributes/presets work; `Kinematic`/`Topographic`/`Custom` usable.
- Regression: `/geoparquet-duckdb-2d|3d` still show the `2D Profile` checkbox;
  `/selection-drawing-3d`, `/arrow-lod-stream-*`, `/misicuni-dam`, `/tabqa` unchanged.

## Out of scope
- Vertical/longitudinal/lateral (directional) decomposition — not in the dataset.
- Changing `SelectionAnalysisPanel`, the Nivo charts, or other maps' behaviour.
- Load-time ETL/schema normalisation beyond reading the Tabqa fields directly.

## Open questions
1. Is `VEL_SD` the std of `VEL_REL` (used for the green band) or of `VEL_AVG`?
2. Preferred `VEL_REL` colour domain for the map/scatter scale (default propose `[-3, 3]`).

---

## Post-implementation notes (2026-10-14)

**Status:** implemented and committed as `6297ebc7a`
(`feat(feature-scatter-chart-3d): add Tabqa 2D map and 3D line profile mode`). `npm run lint`
(`--max-warnings 0`) and `npm run build` both pass. `.kilo/` stays untracked; this file is the
committed copy.

### Deviations & follow-ups applied during/after implementation
These changed the plan's letter (not its intent); recorded so the plan matches the shipped code.

- **Map points = plain `ScatterplotLayer`.** Instead of the planned `SimpleMeshLayer` spheres,
  the 2D map draws billboard discs (`ScatterplotLayer`, `radiusUnits:'pixels'`) so it reads as a
  flat map. Colour coding is preserved: `VEL_REL` colour scale, per-point radius from `|VEL_REL|`,
  and the selected (cyan) / hovered (red) / dimmed (grey) states.
- **Glaze = pre-calculated only.** Dropped the on-the-fly `RAW_DEM_URL` layer and its radio toggle;
  only `precalculatedGlaze` is rendered. Removed the now-unused `glazeMode` state / UI.
- **No separate panel collapse button.** The panel's own collapse chevron duplicated the map's
  top-right "Hide 3D feature space" button, so `collapsed` state + button were removed; the panel
  is shown/hidden only via the map button.
- **`3D line profile` mode is gated.** New `showProfile` prop on `FeatureSpaceChart`; the
  `Scatter | 3D line profile` toggle renders only while the line tool is in use
  (`selectionMode === 'line' || drawnLineCoords.length >= 2`), else the panel falls back to Scatter.
- **Line buffer range.** `SelectionControls` gained optional `bufferMin`/`bufferMax`/`bufferStep`
  (defaults 10/500/10 keep other maps unchanged). This app uses **10–200 m** with default **50 m**.
- **Initial view.** `INITIAL_VIEW_STATE` is flat (`pitch 0`) at **zoom 16** over the dam
  (coords as set in the app), not the plan's `{38.5667, 35.8722, zoom 13}`.
- **Selection fix.** `getPointId` is ID-first (`ID ?? fid`). The map highlight set must use **string**
  keys (`new Set(selectedPoints.map(p => String(p.id)))`) because Tabqa `ID`s are numeric while the
  lookup is `has(String(pointId))` — otherwise nothing highlighted. (Pre-existing latent bug on the
  old dataset, surfaced by the numeric IDs.)
- **New pure module.** `profileGeometry.js` (`buildProfileFrame`, `formatTick`, `hexToRgba`) plus
  `ProfileTooltip.jsx` were added to share the profile frame/geometry and hover tooltip across the
  three renderers.

### Open question 1 — `VEL_SD` pairing (investigated, still needs the data owner)
Analysed the actual `Tabqua_LOS_selected.geojson` (934 features, 488 keys):

- There is **no** `SVEL_REL`/`SVEL_AVG`; only a single `VEL_SD`.
- `VEL_SD` = 0.03–0.13 (mean 0.085), far smaller than the epoch-trend stds
  (`SVEL_LAST` 0.09–2.0, `LTS_365` 0.5–4.7). A ~0.085 std is consistent with a **well-averaged**
  velocity (standard error ≈ noise/√N over ~300 epochs) — i.e. more likely the std of `VEL_AVG`.
- `VEL_REL` and `VEL_AVG` are genuinely different (corr 0.68, difference sd 1.97), so
  `VEL_REL ≠ VEL_AVG − const`; we cannot assume they share a std.
- `LT_REL` is a 0–1 reference factor, not a velocity std.

**Recommendation:** treat the green `VEL_REL (+VEL_SD)` band as **indicative**, not authoritative,
and confirm the pairing with the data provider. If it turns out `VEL_SD` belongs to `VEL_AVG`,
the fix is a one-line swap of `stdKey` in `SERIES_DEFS`
(`src/maps/FeatureScatterChart3D/index.jsx`) — or add `VEL_AVG` as a series.

### Open question 2 — `VEL_REL` colour domain (resolved)
Pinned to **`[-3, 3]`** (same for the map and the scatter). Justification from the data: 91 % of
`VEL_REL` values lie within ±3, so the scale is not saturated while still separating the core
population; it also matches the plan's proposal. (Percentiles: p05 −4.3, p25 −0.9, p50 −0.1,
p75 0.7, p95 2.1.)

### Remaining risk — manual browser pass (not automatable here)
The three renderers (especially the new ribbon geometry) have not been exercised in a real browser:
ribbon rendering/occlusion under orbit, axis/tick legibility, hover→map highlight and clear-on-unhover,
and colour/lighting parity across Plotly / deck.gl / three.js still need a manual pass on
`/3d-feature-scatter-chart`.

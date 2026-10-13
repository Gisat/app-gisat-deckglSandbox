# Plan: 3D Feature-Space Scatter Chart (evaluation spike in Selection Drawing 3D)

## Goal
Add a 3D scatter "feature space" chart to the `selection-drawing-3d` view that plots the currently
selected InSAR points on three attribute axes, with preset/custom axis controls. This repo is a
**test bench**: build a self-contained, portable module so the winning renderer can be lifted into
the user's other repository. Scope explicitly includes a written comparison of three renderers with
their known limitations, ending in a recommendation.

## Context / where this lands
- App is a **Vite + React 18 SPA** (`package.json:7`, `react@^18.3.1`). No SSR — ignore all
  Next.js/`ssr:false` guidance from the source prompt.
- View: `src/maps/SelectionDrawing3D/index.jsx`. Data: `selectedFeatures` (GeoJSON
  `FeatureCollection`), built in `applySelection` (`index.jsx:185-215`). Map hover state is
  `hoveredPointId`; the write path is `onPointHover={setHoveredPointId}` (`index.jsx:343`).
- Map velocity color scale: `chroma.scale([[65,182,196],[254,254,191],[215,25,28]]).domain([-5,5])`
  (`index.jsx:24-26`).
- InSAR attributes (confirmed): `vel_rel`, `coh`, `inc_ang`, `az_ang`, `h`, `h_dtm`, `id_global`,
  `id_orig`, `rel_len`, `vel_last`. `point_id`/`mean_velocity` are derived, not source fields.

## Corrections to the source AI prompt (do NOT copy it verbatim)
1. Not Next.js — no SSR concerns.
2. Integration point is **not** "the main map view"; we mount a standalone module inside
   `SelectionDrawing3D` and leave shared components untouched (keeps it portable).
3. Input is GeoJSON features (props under `feature.properties`), not an `InsarPoint[]` with top-level keys.
4. Plotly is **not installed**; Nivo (`@nivo/scatterplot`, `@nivo/line`) is used but has **no 3D**.
5. **Plotly `scatter3d` cannot size markers per point** (`marker.size` is one number per trace; no
   per-point array/`sizeref`). The requested "size = coh" channel is impossible in Plotly; we must
   fall back to per-trace binning or opacity. This is a headline comparison finding.
6. **deck.gl `OrthographicView` cannot rotate** (2D orthographic only). Use **`OrbitView`** for a
   rotatable 3D scatter. Both are exported from `@deck.gl/core` (verified).
7. Drop the "Radar Acquisition Geometry" preset: `inc_ang`/`az_ang` are constant per stack, so the
   scatter collapses to a line. Meaningful only across multiple stacks.
8. Match the app's **light** HUD theme, not the dark `#334155` scene.

## Locked decisions
- **Renderers to build (all three)**: Plotly, deck.gl (`OrbitView`), three.js/r3f. Shared
  data/axis/preset/hover state; each renderer is a drop-in module behind `renderer="plotly"|"deckgl"|"three"`.
- **Presets**: (A) *Kinematic* — X=`vel_rel`, Y=`vel_last`, Z=`h_struct`, color=`vel_rel`, size=`coh`;
  (B) *Topographic* — X=`h_dtm`, Y=`h_struct`, Z=`vel_rel`, color=`vel_rel`, size=`coh`; plus **Custom**
  free X/Y/Z/color/size pickers. `h_struct` is derived as `(h ?? 0) - (h_dtm ?? 0)`.
- **Color**: when color=`vel_rel`, reuse the map's chroma scale and fixed domain `[-5,5]` so chart
  colors match map markers; other attributes get a fixed/auto domain with a sensible palette.
- **Size**: `coh` mapped to a pixel-radius range over fixed domain `[0,1]` (Plotly honors it only via binned traces/opacity).
- **Presentation**: toggleable docked overlay panel (right side, ~45% width) with header:
  title + point-count badge + collapse + renderer switcher + preset select + collapsible Custom pickers.
- **Map link**: hover-only. Reuse `onPointHover` → `hoveredPointId`; tooltip shows `id_global`,
  `id_orig`, X/Y/Z with units, `coh`. Unhover clears.
- **Large selections**: render **all** points in every renderer (no cap) — the comparison must surface
  each library's scaling pain. Record observed limits.
- **Portability**: module lives under `src/components/FeatureSpaceChart3D/`, imports nothing from
  `src/maps/*`, takes data + attribute config via props, exported through a single `index.js` barrel.

## Module structure (new)
```
src/components/FeatureSpaceChart3D/
  index.js                     # barrel: FeatureSpaceChart + attribute config helper
  FeatureSpaceChart.jsx        # shared state (points, axes, presets, renderer), header/UI, empty state
  transformPoints.js           # GeoJSON features -> normalized points (+ derived h_struct)
  attributes.js                # attribute metadata, units/domains/palettes, preset definitions
  colorScale.js                # chroma-based scale matching the map for vel_rel
  renderers/
    PlotlyRenderer.jsx         # react-plotly.js scatter3d
    DeckGLRenderer.jsx         # deck.gl OrbitView + ScatterplotLayer + LineLayer axes + TextLayer labels
    ThreeRenderer.jsx          # @react-three/fiber Canvas + drei (OrbitControls/Html/Text) + InstancedMesh
  COMPARISON.md                # filled in during testing (deliverable)
```

## Data model
Normalized point (all renderers consume the same array):
```js
{
  id,            // id_global (fallback id_orig)
  idOrig,        // id_orig
  coords,        // [lon, lat]
  vel_rel, vel_last, coh, inc_ang, az_ang, h, h_dtm, rel_len,
  h_struct,      // (h ?? 0) - (h_dtm ?? 0)
}
```
- Skip points whose value for any **active** axis/color/size field is null/undefined (avoid
  misleading zeros) and report the skipped count.

## Dependencies to add
- `react-plotly.js` + `plotly.js-dist-min`
- `three`, `@react-three/fiber@^8`, `@react-three/drei@^9` (React 18 pins — r3f v9/drei v10 need React 19)
- Load the two heavyweight libs via `React.lazy` + `Suspense` so they don't bloat the initial bundle.

## Known limitations to validate (fill COMPARISON.md with observed results)
- **Plotly**: no per-point marker size (encode coh via binned traces or opacity); ~3MB min bundle;
  WebGL scatter3d slows on large selections; axes/ticks/labels free.
- **deck.gl**: no built-in axes/grid/ticks → manual cube + `TextLayer` labels (font atlas); must use
  `OrbitView` (OrthographicView can't rotate); GPU-fast, scales best; per-point radius natively.
- **three.js/r3f**: no built-in labeled axes (`axesHelper` has no labels) → manual + drei `<Text>`;
  custom raycast picking; per-point size + best staging control; moderate bundle.
- **Cross-cutting**: hover→map linkage per renderer; DPR/resize inside the overlay panel; empty
  state; null handling; tooltip DOM in WebGL canvases.

## Comparison methodology
Fixed dataset + fixed selection. Exercise Kinematic, Topographic, Custom. For each renderer record:
per-point size capability, axis-label quality, hover tooltip + map-link behavior, max points before
noticeable lag, bundle-size delta, code footprint, and how closely the styling matches the light HUD.
Record limitations honestly (both strengths and the "fear of too many points").

## Integration into SelectionDrawing3D
- Add a small toggle button near the existing controls; when on, mount `<FeatureSpaceChart>` as a
  docked right panel.
- Pass `selectedFeatures` and `onPointHover={setHoveredPointId}`; pass the InSAR `attributes` config.
- Do **not** modify `SelectionAnalysisPanel`, `SelectionControls`, or the Nivo charts.

## Ordered tasks
1. Add deps to `package.json`; confirm `npm run dev` and `npm run lint` still pass.
2. `transformPoints.js` + `attributes.js` + `colorScale.js` (pure, unit-testable).
3. `FeatureSpaceChart.jsx` shell: state, header, preset/custom UI, empty state, renderer switcher
   with lazy-loaded renderers.
4. `PlotlyRenderer.jsx` (document the size limitation in-code).
5. `DeckGLRenderer.jsx` using `OrbitView`.
6. `ThreeRenderer.jsx` using r3f + drei.
7. Wire toggle + panel into `SelectionDrawing3D/index.jsx` (props only).
8. Run the comparison; write `COMPARISON.md` with recommendation.

## Validation
- `npm run lint` passes (max-warnings 0).
- Manual on `/selection-drawing-3d`: draw a polygon/line/circle selection → chart appears; each
  renderer renders; presets + Custom switch axes; hovering a chart point highlights it on the map
  and clears on unhover; window resize keeps the canvas sized; empty selection shows the empty
  state; Plotly's missing size channel is demonstrated.

## Out of scope
- Click-to-select / fly-to from chart to map.
- Persisting selection or chart config.
- Touching other map views or shared selection components.
- Deciding the final winner now (decided after testing, recorded in `COMPARISON.md`).

## Open questions
- Does the port target use TypeScript? (Plan keeps plain JSX + JSDoc types for lift-and-shift; can
  convert on port.)
- After selection, should the losing renderers be removed from this repo? (Left in place by default
  since this is a sandbox.)

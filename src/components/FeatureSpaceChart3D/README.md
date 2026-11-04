# 3D deck.gl Feature-Space Chart and Map Curtain — Implementation Guide

This document describes how the two related visualisations in this repo are built, in
enough detail to re-implement them in another React + deck.gl application:

1. **3D feature-space chart** — a docked panel that plots selected map features on
   three attribute axes (scatter), or plots an ordered line profile (profile mode).
   Built with `OrbitView`, hand-built axes, and HTML tooltips.
2. **Map curtain** — a vertical wall drawn directly on the (2D/pitched) map from the
   ground to each profile sample's Z value, synchronised with the chart's current
   view. This is the geographic counterpart of the chart's Lon/Lat profile.

The chart module is deliberately portable: it consumes only a GeoJSON
`FeatureCollection`, an app-prepared sample array, and hover/state callbacks. Nothing
in `src/components/FeatureSpaceChart3D/` imports from `src/maps/`.

**Reference implementation**

| Concern | File |
|---|---|
| Chart shell, controls, renderer switch | `src/components/FeatureSpaceChart3D/FeatureSpaceChart.jsx` |
| deck.gl renderer (all layers, axes, labels) | `src/components/FeatureSpaceChart3D/renderers/DeckGLRenderer.jsx` |
| Attribute registry / presets / titles | `src/components/FeatureSpaceChart3D/attributes.js` |
| Feature → normalised point | `src/components/FeatureSpaceChart3D/transformPoints.js` |
| Colour + size encodings | `src/components/FeatureSpaceChart3D/colorScale.js` |
| Profile frame (curves, ribbons, ticks) | `src/components/FeatureSpaceChart3D/profileGeometry.js` |
| Curtain geometry (pure) | `src/components/FeatureSpaceChart3D/curtainGeometry.js` |
| Settlement timeline transform | `src/components/FeatureSpaceChart3D/settlement.js` |
| Map integration, curtain deck.gl layers | `src/maps/FeatureScatterChart3D/index.jsx` |
| Line projection / profile samples | `src/components/2DLineProfile/projectionUtils.js` |

---

## 1. Dependencies and assumptions

```jsonc
{
  "@deck.gl/core": "^9.4",
  "@deck.gl/react": "^9.4",
  "@deck.gl/layers": "^9.4",
  "@deck.gl/mesh-layers": "^9.4",   // only for sphere markers
  "@luma.gl/engine": "^9.4",        // SphereGeometry
  "d3-scale": "^4",                 // nice tick generation
  "chroma-js": "^2",                // colour scales (map + chart share one)
  "react": "^18"
}
```

Assumptions made by this implementation:

- **Z is up.** `OrbitView` is created with `orbitAxis: 'Z'`, and the map curtain uses
  `[lon, lat, zMetres]`.
- Coordinates in the map view are **`[longitude, latitude]` in degrees**. If your app
  uses a projected CRS, replace the line-projection maths in section 5.2; the curtain
  geometry itself is CRS-agnostic.
- The chart's cube half-extent is `1`, so all positions live in `[-1, 1]³`. This is
  independent of the map's real-world Z (metres).
- `OrbitView`, not `OrthographicView`. `OrthographicView` is 2D-only and cannot rotate.
- deck.gl 9.4.x. The curtain uses `SolidPolygonLayer`'s `_full3d` / `_normalize`
  internal props; re-test if you upgrade a major version.

---

## 2. Architecture and data flow

```
GeoJSON FeatureCollection
        │
        ├──► transformPoints(collection, activeFields)
        │       • one point per feature, numeric attributes only
        │       • drops features missing an active axis/color/size field
        │
        ├──► computeAxisDomains(points, axes)  (per-slot min/max, degenerate padded)
        │
        └──► buildProfileSamples(selectedFeatures, drawnLine)
                • project each point onto the drawn line
                • {id, distance, offset, lon, lat, ...numeric props}
                • lon/lat = perpendicular FOOT, not the point's own coords
                        │
                        ▼
        FeatureSpaceChart (shell)
        • preset / custom axes, color scale, size domain
        • scatter mode ──► DeckGLRenderer(points, axes, colorScale, …)
        • profile mode ──► buildProfileFrame(profile) ──► DeckGLRenderer(profile=…)
        • onPointHover(id) ──► map highlights the same feature
        • onStateChange({mode, view, basis, zKey, …}) ──► map builds curtains
                        │
                        ▼
        Map (MapView)
        • points
        • buildCurtainGeometry(samples, zKey, {domain}) ──► walls/edges/nodes
        • one curtain for attributes, one per trend series, one binned aggregate
```

Two independent deck.gl contexts are used: the **chart** (`OrbitView`, cube space) and
the **map** (`MapView`, lon/lat/metres). They share only IDs, colour scales and the
app-level profile sample array.

---

## 3. Two coordinate systems (read this first)

| | Chart | Map curtain |
|---|---|---|
| View | `OrbitView` (`orbitAxis: 'Z'`) | `MapView` |
| Position units | normalised cube `[-1, 1]³` | `[lonDeg, latDeg, metres]` |
| X/Y meaning | attributes (or lon/lat in Plan basis) | geographic position |
| Z meaning | third attribute (or height) | attribute value / height |
| Line width | `widthUnits: 'pixels'` + `billboard: true` | same |
| Vertical geometry | ribbons in cube space | quads rising from `z = 0` |

Because each chart axis is normalised independently, **mixed units are intentionally
distorted** in the chart (a mm axis and a metre axis both fill `[-1, 1]`). Real units
are preserved only in the tooltips and axis labels. The map curtain, by contrast, uses
real metres for height.

---

## 4. Part 1 — the 3D feature-space chart

### 4.1 Attribute registry

Everything (axis pickers, titles, tooltips, uncertainty pairing, curtain height rules)
derives from one registry. Keep this pattern: a single metadata object avoids
per-component string switches.

```js
export const ATTRIBUTES = {
  VEL_REL: { key: 'VEL_REL', label: 'Relative velocity', short: 'VEL_REL',
             unit: 'mm/yr', decimals: 2, stdKey: 'VEL_SD' },
  H:       { key: 'H', label: 'Measured height', short: 'H',
             unit: 'm', decimals: 1, stdKey: 'H_SD' },
  TD_365:  { key: 'TD_365', label: 'Trend displacement (365 d)',
             short: 'TD_365', unit: 'mm', decimals: 2, stdKey: 'STD_365' },
  COH:     { key: 'COH', label: 'Coherence', short: 'COH',
             unit: '', decimals: 2, unitless: true },
  lon:     { key: 'lon', label: 'Longitude', short: 'lon',
             unit: '°', decimals: 5, coordinate: true },
  // …
};

export function axisTitle(key) {
  const a = getAttribute(key);
  return a.unit ? `${a.label} [${a.unit}]` : a.label;
}
```

Flags that matter downstream:

- `stdKey` — the paired uncertainty field, drawn as a `z ± σ` ribbon.
- `coordinate: true` — lon/lat, excluded from scatter axis/colour/size pickers but
  available to the profile Z axis.
- `unit === 'm'` — the curtain uses the literal value as height instead of normalising
  it to a display range (section 5.3).

### 4.2 Normalising features into the cube

```js
// transformPoints.js
export function computeAxisDomains(points, axes) {
  const domains = {};
  for (const slot of ['x', 'y', 'z']) {
    const key = axes[slot];
    let min = Infinity, max = -Infinity;
    for (const p of points) {
      const v = p[key];
      if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    else if (min === max) { const pad = Math.abs(min) || 1; min -= pad / 2; max += pad / 2; }
    domains[slot] = { key, min, max };
  }
  return domains;
}

export function projectToCube(point, axes, domains, scale = 1) {
  return ['x', 'y', 'z'].map((slot) => {
    const { key, min, max } = domains[slot];
    const t = max === min ? 0.5 : ((point[key] ?? min) - min) / (max - min);
    return (Math.max(0, Math.min(1, t)) - 0.5) * 2 * scale;
  });
}
```

Notes:

- Widen a degenerate domain (`min === max`) rather than dividing by zero.
- `transformPoints` drops any feature missing an active field so no marker falls back to
  a misleading `0`.
- Keep numeric property keys **verbatim** (`VEL_REL`, `H`, …) so no ETL is needed.

### 4.3 Chart shell: modes, presets, lazy renderers

`FeatureSpaceChart` owns UI state and builds the renderer props. Key points:

- Renderers are `React.lazy`-loaded so heavy libraries stay out of the initial bundle.
- `mode` is `'scatter'` or `'profile'`; a polygon/circle selection has no line, so
  `profileDisabled` forces scatter.
- In profile mode the app passes an ordered sample array; the chart never re-reads the
  GeoJSON for profile geometry.
- `onStateChange` reports only primitives (`mode`, `view`, `basis`, `zKey`, …). This is
  what the map uses to decide which curtain to build. It fires `null` on unmount so the
  curtain disappears when the panel closes.

```js
useEffect(() => {
  onStateChange?.({
    mode: activeMode,          // 'scatter' | 'profile'
    view: profileView,         // 'attributes' | 'trend' | 'aggregate'
    basis,                     // 'along' | 'plan' (Lon/Lat)
    zKey: activeZKey,
    trendLines,                // 'windows' | 'profiles' | 'points'
    valueKey: aggValueKey,
    step: effectiveAggStep,
    interpolate: aggInterpolate,
  });
}, [/* primitives only */]);

useEffect(() => () => onStateChange?.(null), [onStateChange]);
```

The parent must pass a **stable** `onStateChange` (e.g. `setChartState`) or the effect
will loop.

### 4.4 OrbitView setup

```js
const INITIAL_VIEW_STATE = {
  target: [0, 0, 0],
  rotationX: 30,        // elevation in degrees
  rotationOrbit: 225,   // azimuth in degrees
  zoom: 7.5,
  minZoom: 4,
  maxZoom: 12,
};

const view = useMemo(() => new OrbitView({ orbitAxis: 'Z', fovy: 45 }), []);
```

Important details:

- `OrbitView` places the camera at
  `[-d·cosX·sinOrbit, -d·cosX·cosOrbit, d·sinX]`.
- Use a **controlled** `viewState` (`viewState={...} onViewStateChange={...}`), because
  the axis labels must re-render from the live camera (section 4.7.5).
- Merge partial events through a ref. A pan event can omit rotation; spreading the last
  state prevents the grid from snapping back:

```js
const handleViewStateChange = useCallback(({ viewState: next }) => {
  const prev = viewStateRef.current;
  const merged = {
    ...prev, ...next,
    target: next.target ?? prev.target,
    zoom: next.zoom ?? prev.zoom,
    rotationX: next.rotationX ?? prev.rotationX,
    rotationOrbit: next.rotationOrbit ?? prev.rotationOrbit,
  };
  // skip no-op events, then setViewState(merged)
}, []);
```

### 4.5 Layer stack

Order matters:

```
1. cube wireframe (LineLayer)
2. axis shafts + far-face grid (LineLayer)          ─┐
3. profile ribbons / lines / points  OR  scatter     ├─ depth-tested
4. hover spikes (LineLayer)                         ─┘
5. axis tick labels (TextLayer, depthTest: false)
6. axis titles     (TextLayer, depthTest: false)     ← always last
```

Rules of thumb:

- Labels disable the depth test so they stay readable when a sphere sits in front of
  them. Anything drawn after them paints over the text, so hover spikes go **before**
  labels.
- Axis labels live in their own memo. Only their sizes depend on the camera; orbiting
  should refresh ~20 glyphs, not every point attribute.
- Keep `updateTriggers` on data-dependent accessors (`getFillColor`, `getRadius`, …) —
  deck.gl accessors are memoised per layer, not per render.

### 4.6 Points: billboard circles or shaded spheres

Two marker styles share the same data and encodings:

```js
// Billboard: constant pixel size, always faces the camera.
new ScatterplotLayer({
  id: 'feature-space-points',
  data: scatterData,                       // {position:[x,y,z], fillColor, radius, scale}
  getPosition: (d) => d.position,
  getRadius: (d) => d.radius,
  radiusUnits: 'pixels',
  radiusMinPixels: 1,
  radiusMaxPixels: 40,
  billboard: true,                         // default false draws in the common XY plane
  getFillColor: (d) => d.fillColor,
  pickable: true,
  autoHighlight: true,
  highlightColor: [255, 0, 0, 255],
  updateTriggers: {
    getFillColor: [colorScale, axes.color],
    getRadius: [sizeDomain, sizeRange, axes.size],
  },
})

// Sphere: world-space radius, matte material so colour reads true.
new SimpleMeshLayer({
  id: 'feature-space-points-mesh',
  data: scatterData,
  mesh: sphereGeometry,                    // new SphereGeometry({radius: 1})
  getPosition: (d) => d.position,
  getColor: (d) => d.fillColor,
  getScale: (d) => [d.scale, d.scale, d.scale],
  material: { ambient: 0.35, diffuse: 0.6, shininess: 0, specularColor: [0, 0, 0] },
  pickable: true,
  autoHighlight: true,
  highlightColor: [255, 0, 0, 255],
})
```

Size encoding: map the raw value to a pixel radius, then derive the sphere's world
scale from the same normalised `t` so switching renderers does not change apparent
size:

```js
const radius = sizeForValue(p[axes.size], sizeDomain, sizeRange);
const t = sizeRange[1] === sizeRange[0] ? 0.5 : (radius - sizeRange[0]) / (sizeRange[1] - sizeRange[0]);
const scale = 0.018 + t * 0.055;   // SphereGeometry radius is 1
```

Colour: use **one** chroma scale for chart and map, so the same value is the same
colour everywhere.

```js
export const MAP_VELOCITY_COLORS = [[215, 25, 28], [254, 254, 191], [65, 182, 196]]; // red → yellow → teal
export const MAP_VELOCITY_DOMAIN = [-3, 3];                                          // mm/yr
```

### 4.7 Hand-built axes (deck.gl has none)

This is the largest custom part. Everything is generated in cube space and stays
depth-tested with the data (labels excepted).

#### 4.7.1 Which edges are near/far?

The grid must sit on the faces **opposite** the camera, and flips as the user orbits.
Compute the camera direction from the orbit angles and take the opposite signs:

```js
function farCornerSigns(rotationOrbit = 225, rotationX = 30) {
  const rad = Math.PI / 180;
  const cosX = Math.cos(rotationX * rad);
  const camX = -cosX * Math.sin(rotationOrbit * rad);
  const camY = -cosX * Math.cos(rotationOrbit * rad);
  const camZ = Math.sin(rotationX * rad);
  return [camX >= 0 ? -1 : 1, camY >= 0 ? -1 : 1, camZ >= 0 ? -1 : 1];
}
```

Only the three signs are state, not the whole camera: the axis geometry is rebuilt when
the camera crosses a cube face, not on every frame.

#### 4.7.2 Plotly-style shaft placement

Coloured shafts run on the two near-bottom edges and the left vertical edge; the grid
stays on the far faces:

```js
function axisEdgeSigns([fx, fy, fz]) {
  const nx = -fx, ny = -fy;
  return {
    x: { y: ny, z: fz },
    y: { x: nx, z: fz },
    z: { x: nx, y: fy },
  };
}
```

Shafts (fixed other two coordinates):

```js
{ key: 'x', source: [-c, edges.x.y * c, edges.x.z * c], target: [ c, edges.x.y * c, edges.x.z * c] }
{ key: 'y', source: [edges.y.x * c, -c, edges.y.z * c], target: [edges.y.x * c,  c, edges.y.z * c] }
{ key: 'z', source: [edges.z.x * c, edges.z.y * c, -c], target: [edges.z.x * c, edges.z.y * c,  c] }
```

#### 4.7.3 Cube wireframe without doubled edges

The near edges that a coloured shaft replaces must be omitted, otherwise thin grey
lines z-fight and hide the axis colour:

```js
function cubeSegments(edges, enabled) {
  const c = 1;
  const corners = [
    [-c,-c,-c], [c,-c,-c], [c,c,-c], [-c,c,-c],
    [-c,-c, c], [c,-c, c], [c,c, c], [-c,c, c],
  ];
  const pairs = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

  return pairs
    .map(([a, b]) => ({ source: corners[a], target: corners[b] }))
    .filter(({ source, target }) => {
      const same = (i) => source[i] === target[i];
      if (enabled.x && same(1) && same(2) && source[1] === edges.x.y * c && source[2] === edges.x.z * c) return false;
      if (enabled.y && same(0) && same(2) && source[0] === edges.y.x * c && source[2] === edges.y.z * c) return false;
      if (enabled.z && same(0) && same(1) && source[0] === edges.z.x * c && source[1] === edges.z.y * c) return false;
      return true;
    });
}
```

#### 4.7.4 Ticks and far-face grid

Use `d3-scale` for "nice" ticks, then map each value into cube coordinates:

```js
function makeTicks(domain, format) {
  const [min, max] = domain;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [];
  return scaleLinear()
    .domain([min, max])
    .ticks(5)
    .map((value) => ({
      value,
      t: ((value - min) / (max - min)) * 2 - 1,   // → [-1, 1]
      label: format(value),
    }));
}
```

For each tick, emit:

- a tick label just outside the shaft (`tickOff = c + 0.08`);
- a grid line on each of the two far faces behind the data, e.g. for X:

```js
pushGrid([t, -c, fz * c], [t, c, fz * c]);
pushGrid([t, fy * c, -c], [t, fy * c, c]);
```

Skip a grid line when the tick maps to exactly `±c`, because it would land on a
wireframe edge and z-fight:

```js
const insideCube = (t) => Math.abs(t) < c - 1e-9;
```

Tick formatter: derive decimals from the tick **step**, not from the tooltip precision,
otherwise a narrow domain collapses into identical labels:

```js
const needed = Math.max(0, Math.ceil(-Math.log10(span / 5)));
const decimals = getAttribute(key).coordinate
  ? Math.max(4, Math.min(6, needed))   // lon/lat keep ≥ 4 decimals
  : Math.min(6, needed);
```

For a categorical Y axis (trend timeline), reuse the band labels rather than numeric
ticks.

#### 4.7.5 TextLayer labels — constant on-screen size

`TextLayer` sizes glyphs in **clip space**, so the perspective divide (`1/w`) makes
labels shrink near the camera and grow far away. Mirror the `OrbitView` with an
`OrbitViewport` and compensate each glyph by its own depth:

```js
const labelViewport = useMemo(() => new OrbitViewport({
  width, height,
  zoom: viewState.zoom,
  rotationX: viewState.rotationX,
  rotationOrbit: viewState.rotationOrbit,
  target: viewState.target,
  orbitAxis: 'Z',
  fovy: 45,
}), [width, height, viewState]);

const labelSizeFactor = (position) => {
  const m = labelViewport.viewProjectionMatrix;
  const focal = labelViewport.focalDistance || 1;
  const w = m[3] * position[0] + m[7] * position[1] + m[11] * position[2] + m[15];
  return Number.isFinite(w) && w > 0 ? w / focal : 0;
};
```

Bake `size * factor` into each datum and drop labels whose anchor is at/behind the
camera (`factor <= 0`) — they would draw mirrored or zero-sized text:

```js
const scaleLabels = (labels) => labels.flatMap((d) => {
  const factor = labelSizeFactor(d.position);
  return factor > 0 ? [{ ...d, size: d.size * factor }] : [];
});
```

Shared `TextLayer` props:

```js
{
  getPosition: (d) => d.position,
  getText: (d) => d.text,
  getColor: (d) => d.color,
  getSize: (d) => d.size,
  sizeUnits: 'pixels',
  billboard: true,
  fontFamily: 'system-ui, sans-serif',
  getTextAnchor: 'middle',
  getAlignmentBaseline: 'center',
  parameters: { depthTest: false, depthWrite: false },
  characterSet: 'auto',   // atlas built from actual labels (units, non-ASCII)
}
```

`characterSet: 'auto'` also avoids a CDN font fetch — the SDF atlas is generated in an
offscreen canvas, which matters under COEP `require-corp` headers.

#### 4.7.6 Axis titles that follow their axis

Plotly rotates 3D axis titles along the shaft. Do this in **screen space**: project two
points on the axis and derive the angle. `billboard: true` still draws the text
screen-facing; `getAngle` only spins it within that plane.

```js
function axisTitleAngle(viewport, position, direction) {
  const eps = 0.5;                    // long probe → stable angle
  const a = viewport.project(position.map((v, i) => v - direction[i] * eps));
  const b = viewport.project(position.map((v, i) => v + direction[i] * eps));
  const dx = b[0] - a[0], dy = b[1] - a[1];

  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;  // probe at camera plane
  if (Math.hypot(dx, dy) < 2) return 0;                        // axis points at camera
  if (Math.abs(dx) < 0.01) return dy < 0 ? 90 : -90;           // snap vertical

  // viewport.project is y-down; getAngle turns text counter-clockwise
  let deg = -Math.atan2(dy, dx) * (180 / Math.PI);
  if (deg > 90) deg -= 180;            // fold upright, like Plotly
  if (deg < -90) deg += 180;
  return deg;
}
```

Titles get `getAngle`; tick labels keep the default horizontal angle.

### 4.8 Hover, tooltip and map link

- `onHover` reads `info.object`; if present, store `{x: info.x, y: info.y, object}` and
  render an absolutely-positioned HTML tooltip at `info.x + 14 / info.y + 14`.
- Forward `object.id` to the host via `onPointHover(id | null)` so the map can outline
  the same feature. IDs must match the map's point IDs (`ID`, else `fid`).
- Hover spikes: three axis-parallel lines from the point to the far walls, plus two
  cross-lines on each far wall (`spikesides` behaviour). Nine segments total:

```js
const [x, y, z] = hoveredPosition;
const [fx, fy, fz] = farSigns;
const spikes = [
  { source: [x, y, z], target: [fx, y, z] },
  { source: [x, y, z], target: [x, fy, z] },
  { source: [x, y, z], target: [x, y, fz] },
  { source: [fx, -c, z], target: [fx, c, z] },
  { source: [fx, y, -c], target: [fx, y, c] },
  { source: [-c, fy, z], target: [c, fy, z] },
  { source: [x, fy, -c], target: [x, fy, c] },
  { source: [-c, y, fz], target: [c, y, fz] },
  { source: [x, -c, fz], target: [x, c, fz] },
];
```

### 4.9 Profile mode (optional but shared with the curtain)

`buildProfileFrame(profile, cube)` turns the app's sample array into one or more
curves. A curve sample is:

```js
{
  id,
  position: [xn, yn, zn],          // cube space, used by deck.gl/three
  ribbon: { lo: [...], hi: [...] } | null,
  raw: { x, y, z, lo, hi, std },   // real units, used by tooltips/Plotly
  color: string | null,            // set for settlement-coloured points
  stepKey, stepLabel,
  interpolated: boolean,
  offsetT: number | null,          // |offset| / bufferDistance, for size encoding
  sample,                          // the original app sample
}
```

Views:

| view | X | Y | Z | ribbon |
|---|---|---|---|---|
| `attributes` / `plan` | longitude | latitude (equal ground scale) | `zKey` | `z ± stdKey` if paired |
| `attributes` / `along` | distance along line | `yKey` | `zKey` | `z ± stdKey` if paired |
| `aggregate` | distance | pinned 0 | per-bin median | IQR (25–75 pct) |
| `trend` / `windows` | distance | ordered window band | `TD_*` | paired `STD_*` |
| `trend` / `profiles` | distance | ordered timeline band | `TD_730 − TD_x` | none |
| `trend` / `points` | distance | ordered timeline band | settlement | none, colour by settlement |

deck.gl rendering specifics for profiles:

- **Ribbons**: `SolidPolygonLayer` with `_normalize: false`, `_full3d: true`,
  `filled: true`, `extruded: false`, `parameters: { depthWrite: false }`. A vertical
  quad is degenerate in XY, so without `_full3d` earcut emits no triangles.
  Build each quad as `[loA, loB, hiB, hiA]`.
- **Lines**: one `PathLayer` per colour group, `widthUnits: 'pixels'`,
  `billboard: true`, `jointRounded: true`, `capRounded: true`. Without `billboard`
  the stroke is a world-space ribbon that foreshortens as the camera rotates.
- **Interpolated stretches** (aggregate gaps bridged): a separate thinner,
  translucent `PathLayer` (deck.gl has no native dashes).
- **Settlement-coloured points**: per-segment `LineLayer` (no screen-space extrusion).
- **Markers**: `ScatterplotLayer` (billboard) or `SimpleMeshLayer` (sphere), same as
  scatter. `offsetT` grows the mark inside the compact `OFFSET_MARKER_SIZE`
  ranges (e.g. `2 -> 4.5 px` for profile billboards).

### 4.10 Chart gotchas checklist

- [ ] `OrbitView`, never `OrthographicView`.
- [ ] `orbitAxis: 'Z'`; expect a Z-up cube.
- [ ] Controlled `viewState` + ref merge for partial events.
- [ ] Recompute far-corner signs on camera change; keep them as state.
- [ ] Drop near wireframe edges replaced by coloured shafts.
- [ ] Skip grid lines whose tick is at a cube boundary.
- [ ] Compensate `TextLayer` size by `w / focalDistance`; drop `w <= 0`.
- [ ] Fold title angles into `[-90, 90]` and snap the vertical case.
- [ ] Labels last; hover spikes before labels.
- [ ] `characterSet: 'auto'`; no external font under COEP.
- [ ] Memoise label layers separately from point layers.
- [ ] `updateTriggers` on every data-driven accessor.
- [ ] `billboard: true` on all pixel-width lines and text.

---

## 5. Part 2 — the map curtain

### 5.1 What it is

A curtain is a vertical wall standing on the ground along a line selection. It rises
from `z = 0` at each sample's **perpendicular foot** to that sample's active Z value.
It is drawn on the normal map (`MapView`), so it occludes and is occluded by terrain
correctly.

```
            z = attribute value
                 ●────────●
                /|        |\
   wall quad   / |        | \        ← SolidPolygonLayer (vertical quads)
              /  |        |  \
   ground    ●───●────────●───●      z = 0 (base path)
             nodes (ScatterplotLayer) + top path + base path
```

The curtain is built only when a **line** selection exists. Polygon/circle selections
have no ordered samples.

### 5.2 Building samples: project points onto the line

```js
// projectionUtils.js
export function projectPointToLine(point, line) {
  let best = null;
  let accumulatedLength = 0;

  for (let i = 0; i < line.length - 1; i++) {
    const start = line[i], end = line[i + 1];
    const seg = [end[0] - start[0], end[1] - start[1]];
    const segLen = Math.hypot(...seg);
    if (segLen === 0) continue;

    const vec = [point[0] - start[0], point[1] - start[1]];
    const t = (vec[0] * seg[0] + vec[1] * seg[1]) / (segLen * segLen);
    const clamped = Math.max(0, Math.min(1, t));
    const foot = [start[0] + clamped * seg[0], start[1] + clamped * seg[1]];
    const offset = haversine(point, foot) * 1000;
    const distance = accumulatedLength + haversine(start, foot) * 1000;

    if (!best || offset < best.offset) {
      // `within` uses the UNCLAMPED t → flat-ended corridor
      best = { distance, offset, foot, within: t >= 0 && t <= 1 };
    }
    accumulatedLength += haversine(start, end) * 1000;
  }
  return best ?? { distance: 0, offset: Infinity, foot: point, within: false };
}

export function buildProfileSamples(featureCollection, line) {
  const samples = [];
  for (const feature of featureCollection?.features ?? []) {
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;

    const { distance, offset, foot } = projectPointToLine(coords, line);
    const sample = {
      id: feature.properties?.point_id ?? feature.id ?? null,
      distance,
      offset,
      lon: foot[0],      // ← foot, not the point's own coordinates
      lat: foot[1],
    };
    for (const [key, value] of Object.entries(feature.properties ?? {})) {
      const n = Number(value);
      if (Number.isFinite(n)) sample[key] = n;
    }
    samples.push(sample);
  }
  return samples.sort((a, b) => a.distance - b.distance);
}
```

Why the foot matters: the curtain must hug the drawn line. Using the real point
coordinates would make a ragged wall offset from the line by up to the buffer width.

Selection with the same projection:

```js
const kept = features.filter((f) => {
  const { within, offset } = projectPointToLine(f.geometry.coordinates, line);
  return within && offset <= bufferMetres;   // flat ends: no snapping past endpoints
});
```

> The projection treats lon/lat as a flat Cartesian grid (degrees) for the
> perpendicular foot, while distances/offsets use haversine metres. This is accurate
> for small extents (a dam, a few km). For large extents, project to a metric CRS first.

### 5.3 Geometry: `buildCurtainGeometry`

Pure function, no deck.gl imports. This is the file to copy unchanged.

```js
export const CURTAIN_MAX_HEIGHT = 300;  // metres, for dimensionless attributes

export function curtainZDomain(samples, zKeys) {
  let min = Infinity, max = -Infinity;
  for (const s of samples) {
    if (!Number.isFinite(s?.lon) || !Number.isFinite(s?.lat)) continue;
    for (const k of zKeys) {
      const v = s[k];
      if (Number.isFinite(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
  }
  return Number.isFinite(min) ? [min, max] : null;
}

export function buildCurtainGeometry(samples, zKey, { domain } = {}) {
  if (!zKey || samples.length < 2) return { quads: [], path: [], base: [], nodes: [] };

  const rows = samples
    .filter((s) => s && Number.isFinite(s.lon) && Number.isFinite(s.lat)
      && Number.isFinite(s[zKey]))
    .map((s) => ({ id: s.id, lon: s.lon, lat: s.lat, value: s[zKey] }));
  if (rows.length < 2) return { quads: [], path: [], base: [], nodes: [] };

  const [min, max] = Array.isArray(domain) && domain.length === 2
    ? domain
    : rows.reduce(([lo, hi], r) => [Math.min(lo, r.value), Math.max(hi, r.value)],
        [Infinity, -Infinity]);

  // Height attributes (metres) keep their literal value; every other attribute is
  // normalised onto [0, CURTAIN_MAX_HEIGHT]. A shared `domain` keeps several
  // curtains comparable.
  const literal = ATTRIBUTES[zKey]?.unit === 'm';
  const toZ = literal
    ? (v) => v
    : max === min
      ? () => CURTAIN_MAX_HEIGHT / 2
      : (v) => ((v - min) / (max - min)) * CURTAIN_MAX_HEIGHT;

  const nodes = rows.map((r) => ({
    id: r.id,
    position: [r.lon, r.lat, toZ(r.value)],
    value: r.value,
  }));

  const quads = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    quads.push({
      polygon: [
        [a.lon, a.lat, 0],
        [b.lon, b.lat, 0],
        [b.lon, b.lat, toZ(b.value)],
        [a.lon, a.lat, toZ(a.value)],
      ],
      value: (a.value + b.value) / 2,   // for a value-driven fill colour
    });
  }

  return {
    quads,
    path: nodes.map((n) => n.position),                          // top edge
    base: nodes.map((n) => [n.position[0], n.position[1], 0]),   // ground trace
    nodes,
  };
}
```

Design notes:

- **One quad per consecutive pair**, not one polygon for the whole wall. This keeps
  each quad planar and lets you colour by segment (`value` = midpoint).
- `base` exists so the wall reads as standing on the surface rather than floating.
- Clamp/validate inputs: one `null` Z in the middle would otherwise create a
  vertical spike to zero.
- For a shared scale across multiple curtains (trend windows, settlement steps), pass
  `domain` from `curtainZDomain`.

### 5.4 The deck.gl curtain layer set

Four layers per curtain: walls, top edge, base, nodes.

```js
const curtainPath = (id, path, color) => new PathLayer({
  id,
  data: [path],
  getPath: (d) => d,
  getColor: color,
  widthUnits: 'pixels',
  getWidth: 2,
  billboard: true,        // constant screen width under camera rotation
  jointRounded: true,
  capRounded: true,
  pickable: false,
});

const curtainLayers = (id, geometry, { fillColor, nodeColor, lineColor }) => [
  new SolidPolygonLayer({
    id: `${id}-walls`,
    data: geometry.quads,
    // `_normalize: false` means deck.gl wants flat positions; flatten here.
    getPolygon: (d) => d.polygon.flat(),
    getFillColor: fillColor,
    extruded: false,
    _normalize: false,    // keep walls planar; don't geodesically re-project them
    _full3d: true,        // tessellate in the plane with area (vertical quads!)
    pickable: false,
  }),
  curtainPath(`${id}-edge`, geometry.path, lineColor),
  curtainPath(`${id}-base`, geometry.base, lineColor),
  new ScatterplotLayer({
    id: `${id}-nodes`,
    data: geometry.nodes,
    getPosition: (d) => d.position,
    radiusUnits: 'pixels',
    getRadius: 3,
    radiusMinPixels: 2,
    radiusMaxPixels: 8,
    billboard: true,
    getFillColor: nodeColor,
    // Nodes are coplanar with the top edge and its line. Pull them toward the camera
    // with polygon offset instead of disabling depthTest, so terrain in front still
    // occludes them. The extra margin beats the earlier edge line.
    getPolygonOffset: ({ layerIndex }) => [0, -layerIndex * 100 - 1000],
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: (d) => (isHovered(d.id) ? 2 : 0),
    getLineColor: (d) => (isHovered(d.id) ? [255, 0, 0, 255] : [0, 0, 0, 0]),
    updateTriggers: { getLineWidth: [hoveredId], getLineColor: [hoveredId] },
    pickable: false,
  }),
];
```

Why each unusual prop is required:

| Prop | Why |
|---|---|
| `SolidPolygonLayer._full3d = true` | A vertical quad is degenerate in XY; default earcut emits no triangles, so the wall is invisible. |
| `SolidPolygonLayer._normalize = false` | Prevents deck.gl from normalising the ring onto the earth surface; the supplied `[lon, lat, z]` ring must be used as-is. |
| `PathLayer.billboard = true` | Default world-space ribbon width foreshortens as the camera rotates; screen-space width stays constant. |
| `getPolygonOffset` on nodes | Draws markers above the coplanar line/wall without disabling depth testing (terrain still occludes). |
| `pickable: false` everywhere | The curtain is decoration; picking belongs to the map points. |

Layer order: base map → raster overlay → selection boundary → map points → curtains.
Curtains go last so their nodes win the visual stack.

Colours:

```js
// attribute curtain: value-driven, 150 alpha walls
fillColor: (d) => [...scale(d.value).rgb(), 150],
nodeColor: (d) => [...scale(d.value).rgb(), 255],
lineColor: [110, 110, 110, 220],

// trend curtains: flat series colour, 55 alpha walls
fillColor: hexToRgba(series.color, 55),
nodeColor: hexToRgba(series.color, 255),
lineColor: hexToRgba(series.color, 255),
```

### 5.5 Multiple curtains: attributes, trend and aggregate

The chart reports its state; the map translates it into one or more curtains.

**Attribute curtain** — only in `mode === 'profile' && view === 'attributes' &&
basis === 'plan'`:

```js
const zKey = (state?.mode === 'profile' && state.view === 'attributes'
  && state.basis === 'plan') ? state.zKey : null;

const curtain = lineActive && zKey
  ? buildCurtainGeometry(samples, zKey)
  : null;
```

**Trend curtains** — one per series on a **shared Z domain** so heights are
comparable:

```js
// windows: one wall per raw TREND_WINDOWS entry
const domain = curtainZDomain(samples, TREND_WINDOWS.map((w) => w.key));
TREND_WINDOWS.map((w) => ({
  key: w.key,
  color: w.color,
  geometry: buildCurtainGeometry(samples, w.key, { domain }),
}));

// profiles: one wall per settlement timeline step
const withValues = withSettlement(samples);   // adds SETTLE_730 … SETTLE_0
const domain = curtainZDomain(withValues, SETTLEMENT_KEYS);
SETTLEMENT_KEYS.map((key, i) => ({
  key,
  color: TREND_TIMELINE[i].color,
  geometry: buildCurtainGeometry(withValues, key, { domain }),
}));
```

Trend ▸ `points` has no curtain (curves per point, not per series).

**Aggregate curtain** — reuse the binning used by the chart, then rebuild geometry
from the bin centroids:

```js
const rows = aggregateSamples(samples, valueKey, step, interpolate)
  .filter((e) => Number.isFinite(e.lon) && Number.isFinite(e.lat))
  .map((e) => ({ id: e.id, lon: e.lon, lat: e.lat, [valueKey]: e.value }));

const geometry = rows.length >= 2 ? buildCurtainGeometry(rows, valueKey) : null;
```

`aggregateSamples` must retain each bin's mean `lon`/`lat` (computed from members'
perpendicular feet) — that is what places the binned wall on the map.

### 5.6 Chart → map state contract

The map only needs primitives. Define this shape once and validate it on both sides:

```ts
type ChartState = {
  mode: 'scatter' | 'profile';
  view: 'attributes' | 'trend' | 'aggregate';
  basis: 'along' | 'plan';
  zKey: string;
  trendLines: 'windows' | 'profiles' | 'points';
  valueKey: string;
  step: number;
  interpolate: boolean;
} | null;
```

Gating rules:

```js
lineActive       = drawnLineCoords?.length >= 2
attributeCurtain = mode === 'profile' && view === 'attributes' && basis === 'plan'
aggregateCurtain = mode === 'profile' && view === 'aggregate' && step > 0
trendCurtains    = mode === 'profile' && view === 'trend'
                   && trendLines !== 'points'
```

Also gate on `lineActive`: the Trend view can retain a stale `basis` from a previous
Attribute view, so check `view` before using `basis`.

### 5.7 Hover synchronisation

The chart reports `onPointHover(id)`; the map stores `hoveredPointId` and mirrors it:

- map point: red `getLineColor` / `getLineWidth: 2`;
- curtain node with the same `id`: red outline.

IDs must be identical in both directions. Normalise them to strings on both sides
(`String(id)`) because numeric IDs from GeoJSON and chart IDs can differ in type.

### 5.8 Curtain gotchas checklist

- [ ] Only build when `lineActive` (≥ 2 line vertices).
- [ ] Use the perpendicular **foot** for `lon`/`lat`.
- [ ] Require finite `lon`, `lat`, and the Z value per row; drop bad rows.
- [ ] Require ≥ 2 rows, else return empty geometry.
- [ ] Reserve `_full3d: true` + `_normalize: false` for vertical quads.
- [ ] Flatten polygons for `getPolygon` when `_normalize` is false.
- [ ] Use `billboard: true` on all `PathLayer`s.
- [ ] Use `getPolygonOffset` on nodes, not `depthTest: false`.
- [ ] Share one Z domain for multi-curtain comparisons.
- [ ] Use literal metres for `unit === 'm'`, normalise other attributes to `0–300`.
- [ ] Use wall alpha ≈ 55 for trend curtains, ≈ 150 for value-driven ones.
- [ ] Clear curtains when the chart closes (`onStateChange(null)`).

---

## 6. Porting order (recommended)

1. **Copy the pure modules unchanged** (no React/deck.gl):
   `attributes.js`, `transformPoints.js`, `colorScale.js`, `profileGeometry.js`,
   `curtainGeometry.js`, `settlement.js`.
   Replace the attribute registry with your own fields; keep the `stdKey`,
   `coordinate`, and `unit` semantics.
2. **Build the chart shell**: feature collection → `transformPoints` →
   `computeAxisDomains` → `projectToCube`; render points with `OrbitView`.
3. **Add the static axis overlay**: cube → far signs → shafts/grid → ticks.
4. **Add `TextLayer` labels**: first ticks, then titles. Add perspective compensation
   and title rotation last; both are independent and can be verified visually by
   zooming/orbiting.
5. **Add interaction**: tooltip, hover spikes, `onPointHover`.
6. **Add profile mode** if needed: reuse your existing line samples; render curves and
   ribbons with `PathLayer` + `SolidPolygonLayer`.
7. **Add the curtain**: line projection → `buildCurtainGeometry` → four layers.
8. **Wire state**: chart reports `ChartState`; map gates and rebuilds curtains.
9. **Verify** the checklist in section 8.

You can ship steps 1–5 without any curtain, and step 7 without profile mode by feeding
`buildCurtainGeometry` any ordered `{lon, lat, <zKey>}` array.

---

## 7. Minimal end-to-end skeleton

```jsx
// Chart
<DeckGL
  views={new OrbitView({ orbitAxis: 'Z', fovy: 45 })}
  viewState={viewState}
  controller
  onViewStateChange={handleViewStateChange}
  layers={[
    cubeLayer,                   // wireframe
    axisLineLayer,               // shafts + far-face grid
    markerLayer,                 // ScatterplotLayer (billboard) or SimpleMeshLayer
    hoverSpikeLayer,             // before labels
    tickTextLayer,               // depthTest: false
    titleTextLayer,              // depthTest: false, getAngle
  ].filter(Boolean)}
  onHover={handleHover}
/>

// Map
<DeckGL
  views={new MapView({ repeat: true })}
  initialViewState={mapViewState}
  controller
  layers={[
    baseMapLayer,
    ...(selectionBoundaryLayer ? [selectionBoundaryLayer] : []),
    pointLayer,
    ...curtainLayers,
  ]}
/>
```

---

## 8. Verification

Visual checks that catch most regressions:

1. **Orbit 360°** — grid stays on the far faces; shafts stay on near-bottom/left edges;
   no grey line doubles a coloured shaft.
2. **Zoom min → max** — tick/title text stays the same on-screen size; titles stay
   upright and aligned with their shaft; no mirrored text near the camera.
3. **Rotate until an axis points at the camera** — its title falls back to horizontal
   instead of spinning randomly.
4. **Hover** — spikes reach all three far walls; tooltip follows the cursor; the map
   highlights the same point and vice versa.
5. **Profile mode** — ribbons are visible (not blank vertical quads); lines keep a
   constant screen width while rotating; hovered points raise a red outline.
6. **Curtain** — wall stands on the ground (`base` at `z = 0`), nodes sit above the
   wall edge, terrain in front still occludes them, and the curtain disappears when
   the chart closes.
7. **Multi-curtain** — trend windows/settlement steps share one height scale; switching
   `windows` ↔ `profiles` rebuilds the set; `points` shows none.
8. **Data gaps** — features missing an active field are dropped, not plotted at zero;
   a null Z breaks the curtain into valid runs rather than spiking to the ground.

---

## 9. Constants reference

| Constant | Value | Where |
|---|---|---|
| Cube half-extent | `1` | chart |
| Initial elevation / azimuth | `30°` / `225°` | chart camera |
| Zoom range | `4 – 12`, default `7.5` | chart camera |
| `fovy` | `45` | `OrbitView` / mirrored viewport |
| Axis colours | X `[214,39,40]`, Y `[44,160,44]`, Z `[31,119,180]` | axes |
| Grid colour / width | `[232,232,232,255]` / `0.5 px` | grid |
| Axis shaft width | `1.5 px` | shafts |
| Tick label / title size | `11 px` / `12 px` | labels |
| Ticks per axis | `5` (`d3.scaleLinear().ticks(5)`) | ticks |
| Tick offset / title offset | `c + 0.08` / `c + 0.24` | labels |
| Points size range | `3 – 14 px` (`SIZE_PIXEL_RANGE`) | chart |
| Sphere scale range | `0.018 – 0.073` world units | chart |
| Curtain max height | `300 m` (non-metre attributes) | curtain |
| Curtain wall alpha | `55` (trend), `150` (value-driven) | curtain |
| Curtain line width | `2 px` | curtain |
| Curtain node radius | `3 px` (`2 – 8`) | curtain |
| Velocity colour domain | `[-3, 3]` mm/yr | chart + map |
| Settlement colour domain | `[-8, 8]` mm | trend points |

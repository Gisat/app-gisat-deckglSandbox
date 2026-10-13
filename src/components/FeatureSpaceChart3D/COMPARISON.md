# 3D Feature-Space Chart — Renderer Comparison

Evaluation spike for plotting selected InSAR points on three attribute axes. Three
renderers were built behind one switcher (`renderer="plotly" | "deckgl" | "three"`)
sharing the same data, axis, preset, colour and hover state.

- **Module:** `src/components/FeatureSpaceChart3D/`
- **Mounted in:** `src/maps/FeatureScatterChart3D/index.jsx` (toggle button, docked right panel)
- **Presets:** Kinematic, Topographic, Custom (free X/Y/Z/color/size)
- **Data:** GeoJSON features from `applySelection` (`feature.properties.*`)

> Legend: **[M]** = measured in this repo, **[C]** = verified by code inspection of
> the installed dependency, **[E]** = expected from architecture (no browser
> benchmark was run in this environment — see "What still needs a manual pass").

---

## Capability matrix

| Criterion | Plotly | deck.gl (OrbitView) | three.js / r3f |
|---|---|---|---|
| Per-point **size** (`coh`) | **No** — binned into 5 traces + opacity [C] | Yes — `ScatterplotLayer` radius (circles) or `SimpleMeshLayer` `getScale` (spheres) [C] | Yes — per-point `gl_PointSize` (circles) or instance scale (spheres) [C] |
| Marker primitive | Billboard 2D sprite (circle/square/…) [C] | **Toggle:** billboard disc (`ScatterplotLayer`) **or** shaded sphere (`SimpleMeshLayer`) [C] | **Toggle:** `Points` + shader (circles) **or** sphere `InstancedMesh` [C] |
| Billboard circles (always face camera) | **Yes** — every `scatter3d` marker is a billboard [C] | Yes — `ScatterplotLayer` (or `IconLayer` for textured sprites) [C] | Yes — `THREE.Points` + custom `ShaderMaterial` [C] |
| Shaded 3D spheres | **No** built-in symbol; only via a merged `mesh3d` hack [C] | Yes — `SimpleMeshLayer` + `SphereGeometry` [C] | Yes — per-instance sphere [C] |
| Custom per-point shape (OBJ / glTF) | **No** — `mesh3d` is a *single* mesh, not per-point [C] | **Yes** — `SimpleMeshLayer` + `OBJLoader`, or `ScenegraphLayer` (glTF) [C] | **Yes** — any geometry in an `InstancedMesh` [C] |
| Per-point orientation (e.g. arrows) | No | Yes — `getOrientation` (Euler) [C] | Yes — per-instance quaternion [C] |
| Axis lines / ticks / labels | **Built-in**, labelled [C] | Manual cube + `TextLayer` labels [C] | Manual cube + drei `<Html>` labels [C] |
| Rotation | Built-in orbit [C] | `OrbitView` (must NOT use `OrthographicView`) [C] | `OrbitControls` [C] |
| Hover tooltip | `hovertemplate` [C] | HTML overlay + `onHover` [C] | drei `<Html>` + instanced raycast [C] |
| Map link (hover → `hoveredPointId`) | `onHover`/`onUnhover` [C] | `onHover` [C] | `instanceId` pick [C] |
| Render all points, no cap | WebGL `scatter3d` [E] | Instanced draw, best scaling [E] | One `InstancedMesh` [E] |
| Colour matches map when `vel_rel` | Yes (sampled colorscale) [M] | Yes (same chroma scale) [M] | Yes (same chroma scale) [M] |
| Light-HUD theme match | Good | Good (manual styling) | Good (manual styling) |
| Label font under COEP `require-corp` | n/a (SVG text) | OK — atlas generated in-canvas [C] | `<Html>` OK; drei `<Text>` would fetch a CDN font [C] |
| Code footprint (renderer file) | 144 lines [M] | 228 lines [M] | 340 lines [M] |

---

## Bundle & footprint (measured — `vite build`)

Lazy chunks produced by `React.lazy` (minified / gzip):

| Chunk | Size | Gzip |
|---|---|---|
| `PlotlyRenderer` (plotly.js) | **6,988.84 kB** | 1,645.86 kB |
| `ThreeRenderer` (three + r3f + drei) | **1,081.25 kB** | 250.10 kB |
| `DeckGLRenderer` | **28.68 kB** | 8.53 kB |
| `PointTooltip` | 1.21 kB | 0.57 kB |

Deck.gl's renderer chunk is tiny because `deck.gl` / `@deck.gl/core` / `@deck.gl/layers`
were **already in the main bundle** (`index-GfAAvAjy.js`, 7,693.52 kB) used by the
rest of the sandbox. Plotly and three.js are new, so they appear as their own large
chunks. All three stay out of the initial load thanks to `React.lazy` + `Suspense`.

**Takeaway:** choosing deck.gl adds ~28 kB of app code and ~0 new runtime; choosing
Plotly adds ~7 MB (min) on demand; choosing three.js adds ~1.1 MB (min) on demand.

---

## Plotly

**Strengths**
- Axes, ticks, grid, labels and orbit camera are free and correctly labelled.
- Fastest to implement; the tooltip (`hovertemplate`) needs no DOM overlay.
- Colour mapping via a sampled colorscale reproduces the map's `vel_rel` scale exactly [M].

**Limitations (headline finding)**
- `scatter3d` **cannot size markers per point**. `marker.size` is one number per
  trace (no array, no `sizemode`/`sizeref` as in 2D `scatter`). The `size = coh`
  channel is faked with **5 binned traces + an opacity ramp** — visually coarse and
  the tooltip still reports the true `coh`.
- ~7 MB min bundle; WebGL `scatter3d` is expected to slow noticeably on large
  selections (single canvas, per-frame scene graph) [E].
- Never demonstrated the requested size channel honestly — only approximated.

**Can Plotly draw spheres?** No — `scatter3d` has no sphere marker (its symbols are
flat 2D sprites). The only workaround is to hand-generate a sphere and merge *every*
point's sphere into a single `mesh3d` trace (bake the per-point offset and size into
the vertices, colour via `vertexcolor`). That yields real spheres, but with no
instancing: the merged geometry is rebuilt in JS on every axis/size change, memory
and CPU scale with `points × tessellation`, and picking must map a vertex index back
to a point. Viable as a hack, not as the primary approach.

## deck.gl (OrbitView)

**Strengths**
- Native per-point size: `SimpleMeshLayer` with a luma.gl `SphereGeometry` and
  `getScale` renders real shaded spheres (the same technique the map uses).
  Note `ScatterplotLayer` can only draw flat billboarded discs, not spheres.
- GPU-instanced spheres: scales well for large selections, though a sphere mesh
  per point costs more than the flat discs `ScatterplotLayer` would draw [E].
- `TextLayer` builds its SDF font atlas in an offscreen canvas, so labels work under
  the app's COEP `require-corp` headers without any network fetch [C].
- Smallest delta in this repo (deck.gl already a dependency).

**Limitations**
- No axes, grid or ticks: the cube, axis shafts and 9 labels are hand-built
  (~60 lines of geometry + a `TextLayer`). No automatic tick generation.
- Must use `OrbitView`; `OrthographicView` is 2D-only and cannot rotate [C].
- Tooltip is an HTML overlay that must be positioned from `info.x/info.y`.
- Orbit zoom is in world units (`zoom ≈ 7.5` fits the normalised `[-1,1]³` cube);
  needs a sensible default or the cube is tiny/huge.

## three.js / r3f

**Strengths**
- Best staging control: lighting, materials, per-instance scale and colour, one
  `InstancedMesh` draw call for all points [C].
- Orbits via `OrbitControls`; picking via `event.instanceId`.
- Per-point size works natively (per-instance matrix scale).

**Limitations**
- No axes/labels at all — cube + labels are manual, same as deck.gl.
- **Font caveat:** drei `<Text>` (troika) resolves its default font through the
  unicode-font-resolver CDN, which COEP `require-corp` blocks. This spike therefore
  labels axes with drei `<Html>` (DOM, no font fetch) — a deliberate deviation from
  the plan's `<Text>` suggestion, and a finding to carry forward.
- `<Html>` labels/tooltip always render on top (no depth occlusion).
- Heaviest custom code (222 lines) and a ~1.1 MB min chunk.

---

## Cross-cutting findings

- **Colour parity:** when the colour channel is `vel_rel`, all three reuse
  `chroma.scale([[65,182,196],[254,254,191],[215,25,28]]).domain([-5,5])`; the
  node smoke test confirms `(-5, 0, 5) → [65,182,196] / [254,254,191] / [215,25,28]` [M].
- **Null handling:** points missing a value for any **active** axis/color/size field
  are dropped and counted in the header badge (`N skipped`) — `vel_last` and
  `h_dtm` are the common offenders in the sample data [M].
- **Empty state:** null selection and all-skipped selections both render an
  explanatory panel message.
- **Resize / DPR:** Plotly uses `useResizeHandler`; deck.gl and r3f fill their parent
  and handle DPR (`dpr={[1,2]}`) automatically.
- **`h_struct`** is derived as `(h ?? 0) - (h_dtm ?? 0)`; it stays defined and is not
  used to skip points.

---

## Custom 3D shapes / OBJ arrows — brainstorming (not implemented)

Question: the port target already draws map points as **OBJ arrows** via
`SimpleMeshLayer` + `@loaders.gl/obj`. Could the chart show the same custom
shapes? Findings per renderer:

**deck.gl — yes, essentially for free.**
- `SimpleMeshLayer.mesh` accepts an OBJ URL directly with `loaders: [OBJLoader]`
  (already how `MetroD_arrows_3D`, `D8_iconArrows`, `Misicuni_dam` work). `@loaders.gl/obj`
  is already a repo dependency, so no new package.
- For glTF (with animation/skin) use `ScenegraphLayer`.
- Arrows also need a direction: `getOrientation` returns `[pitch, yaw, roll]` Euler
  angles **per point**. In feature space you would have to *define* what the arrow
  points at (e.g. a 2D velocity vector on the X/Y plane with Z up), because a
  simple shape needs no orientation but an arrow does. Euler yaw is lossy for
  arbitrary 3D direction, so a full 3-axis arrow needs care.
- Cost: a mesh per point is heavier than the flat discs `ScatterplotLayer` draws,
  but deck.gl still instances the shared mesh, so scaling stays good [E].
- This is the strongest reason to favour deck.gl *if* the chart and the map should
  share the exact same mark (spheres today, arrows tomorrow).

**three.js — yes, and the most flexible.**
- Any geometry works inside the existing `InstancedMesh` (custom `BufferGeometry`,
  or an OBJ/GLTF loaded with `useLoader(OBJLoader)` / `useGLTF`).
- Orientation is a full per-instance quaternion via the instance matrix — no Euler
  lossiness — so true 3-axis arrows are straightforward.
- Best choice if custom shapes become a core requirement; costs a ~1.1 MB chunk
  plus the label-font work already noted.

**Plotly — no.**
- `scatter3d` markers are flat sprites; `mesh3d` is a *single* mesh per trace, not a
  per-point instanced custom shape. You cannot give each point its own arrow.
- Would require emitting one trace per point (or per direction) — impractical and
  still without true per-point geometry. Ruled out for custom shapes.

**Net:** deck.gl and three.js can both do OBJ/custom per-point shapes with
orientation; Plotly cannot. If mark parity with the map (arrows) matters, deck.gl is
the cheapest path; if arbitrary/full-3D-oriented marks matter, three.js wins.

---

## Billboard circles vs shaded spheres — implemented toggle

The header has a **`circles` / `spheres`** control (default **spheres**). It drives
the marker primitive for deck.gl and three.js; **Plotly is always `circles`** (it has
no sphere marker), so the control is disabled while Plotly is selected. Plotly's
points are therefore deliberately left unchanged from option A.

- **A — `circles`:** camera-facing flat discs, constant screen size (never edge-on).
  - deck.gl: `ScatterplotLayer`, `radiusUnits: 'pixels'`, native per-point radius.
  - three.js: `THREE.Points` + a small custom `ShaderMaterial` writing `gl_PointSize`
    per point (plain `PointsMaterial.size` is one uniform and cannot vary per point).
- **B — `spheres`:** shaded 3D spheres with the map's look.
  - deck.gl: `SimpleMeshLayer` + `SphereGeometry` (matte material).
  - three.js: sphere `InstancedMesh`, per-instance scale/colour.

Both paths share the same per-point colour and the same `size = coh` mapping. The
trade-off is unchanged: billboards are cheaper and always readable (good for dense
selections), spheres carry depth/shading but cost more per point. `IconLayer`
(deck.gl) is the textured-sprite variant if a glyph is ever wanted.


---

## Recommendation

**Winner: deck.gl (`OrbitView`).**

Rationale, weighted for the porting goal:

1. **Only renderer that satisfies every required channel** — native per-point size,
   the exact map colour scale, and GPU scaling to large selections.
2. **Near-zero cost in the target repo** if deck.gl is already present (it is in this
   sandbox, and the port target is a deck.gl app): the renderer chunk is ~28 kB.
3. The one real gap — axes/ticks — is a fixed, bounded cost of manual geometry that
   is already written here and ports unchanged.
4. If the very largest selections still lag, the header's `circles` toggle swaps the
   shaded spheres for `ScatterplotLayer` discs for a large speed-up, at the cost of
   the depth cue (Plotly cannot make this trade at all).

**Runner-up: three.js/r3f** — pick it if the port values visual polish/staging or
needs richer custom marks, and can absorb a ~1.1 MB chunk plus the label-font work.

**Do not port Plotly** for this feature: the missing per-point size channel is a hard
requirement, and a ~7 MB chunk for an approximation is not justifiable.

### What still needs a manual browser pass

No interactive benchmark was run here (no browser automation). Before finalising,
on `/selection-drawing-3d`: draw a large polygon and record the point count at which
each renderer starts to lag; confirm deck.gl/three label legibility at the panel's
actual size; confirm hover→map highlight and clear-on-unhover for each renderer.

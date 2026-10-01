# Port factory `DynamicArrowLayer` into the sandbox (Tabqa_dam)

## Goal

Replace the sandbox `src/layers/DynamicArrowLayer.ts` with the improved
`app-damStabilityInspector` factory version, including a dedicated
`DynamicArrowLayer.shader.ts`, and wire the sandbox consumers so the Tabqa_dam
map renders correctly under the new geometry semantics.

## Source references

- `/Users/marianakecova/GST_code/app-damStabilityInspector/src/lib/layers/factory/DynamicArrowLayer.ts`
- `/Users/marianakecova/GST_code/app-damStabilityInspector/src/lib/layers/factory/DynamicArrowLayer.shader.ts`

## Decisions (confirmed)

1. **Scope:** layer + shader + wire consumers (factory + Tabqa accessors).
2. **Geometry:** retune Tabqa accessors to the factory's
   fraction-of-half-side proportions (arrows will visibly change; no parity
   translation).
3. **Export:** switch the sandbox layer to a **named export**
   (`export class DynamicArrowLayer`) to match the factory; update the single
   importer.
4. **Selection constant:** the sandbox has no `@lib/symbologies/constants/selection`
   module, so inline `const SELECTED_FEATURE_LINE_WIDTH = 3` at the top of the
   ported shader file (value matches the factory).
5. **Anchor:** `anchorCentered` stays `false` (Tabqa is LOS-style, tail on the
   point).

## Key semantic differences to account for

- Factory shader does **not** halve `getStemLength`; it treats accessors as
  fractions of the point-quad half-side (`p = vLocalPos * 0.5`, so `0.5` = quad
  edge). Old sandbox used `vStemLength * 0.5`.
- Factory adds a separate `getHeadWidth` (full width, shader halves it).
- Factory uses `vLocalPos = unitPosition` (not raw `positions.xy`) and
  `vPixelRatio = project.devicePixelRatio`.
- Factory hardcodes a 3px selected / transparent-black unselected stroke; old
  sandbox hardcoded 6px / 0.5px black.
- `unitPosition` mapping only matches the intended radius when the quad is
  **not** inflated, i.e. `getLineWidth: 0` (old Tabqa passed `24`).

## Tasks (ordered)

### 0. Create the working branch

- From the current `main`, create and check out a feature branch, e.g.
  `feat/dynamic-arrow-layer-factory-port`.
- This is a mutating Git command, so it must be run by an implementation-capable
  agent (this planning agent cannot create branches or edit source).

### 1. Add `src/layers/DynamicArrowLayer.shader.ts`

- Copy `DynamicArrowLayer.shader.ts` from the factory verbatim, with one change:
  replace `import { SELECTED_FEATURE_LINE_WIDTH } from '@lib/symbologies/constants/selection';`
  with a local `const SELECTED_FEATURE_LINE_WIDTH = 3;` plus a short comment
  noting the value mirrors the factory's shared selection constant.
- Keep the exported signature
  `getArrowShaderInjections({ anchorCentered })` and all GLSL, including
  `vAnchorOffset`, `vPixelRatio`, `vLocalPos = unitPosition`.
- Reword docstrings that reference `@lib/...` paths so they describe the
  sandbox-local file.

### 2. Rewrite `src/layers/DynamicArrowLayer.ts`

- Mirror the factory class:
  - `export class DynamicArrowLayer<DataT = unknown, ExtraPropsT extends object = object>`
    (named export, replacing the current default export).
  - Props interface gains `getHeadWidth?: Accessor<DataT, number>` and
    `anchorCentered?: boolean`.
  - Defaults: `getStemLength 0.3`, `getStemThickness 0.05`, `getHeadSize 0.15`,
    `getHeadWidth 0.1`, `anchorCentered false`.
  - `getShaders()` delegates to
    `getArrowShaderInjections({ anchorCentered: Boolean(this.props.anchorCentered) })`,
    importing from `./DynamicArrowLayer.shader`.
  - `initializeState()` registers `instanceHeadWidths` (accessor `getHeadWidth`,
    default `0.1`) in addition to the existing attributes; keep
    `instanceLineWidths`.
- Remove the inline shader strings and the stale comments.
- Do not copy the factory's `@remarks Ported from app-gisat-deckglSandbox...`
  docstring; describe it as the sandbox copy that mirrors the
  damStabilityInspector factory.

### 3. Update `src/layers/factory/buildDeckGLLayerWithSymbology.ts`

- Change import to `import { DynamicArrowLayer } from '../DynamicArrowLayer';`.
- Add `getHeadWidth?: Accessor<DataT, number>` and `anchorCentered?: boolean` to
  `BuildDeckGLLayerWithSymbologyProps`.
- Destructure both, with `anchorCentered = false`.
- Change the `getLineWidth` default from `2` to `0` (no quad inflation); update
  the doc comment/param default accordingly.
- Retune default accessors to factory-like fractions so the default path cannot
  clip the quad:
  - `getStemLength`: `normalize(|vel_rel|, 0, 10, 0.05, 0.25)`
  - `getStemThickness`: `normalize(rel_len, 0.4, 1, 0.0125, 0.0625)`
  - `getHeadSize`: `normalize(coh, 0.4, 1, 0.08, 0.16)`
  - `getHeadWidth`: `normalize(coh, 0.4, 1, 0.064, 0.128)` (≈ `0.8 * headSize`)
- Pass `getHeadWidth` and `anchorCentered` into the `new DynamicArrowLayer({...})`
  call.

### 4. Retune `src/maps/Tabqa_dam/index.jsx`

- `getArrowStemLength`: `normalize(rel, 0, 1, 0.05, 0.25)`.
- `getArrowHeadSize`: `normalize(coh, 0.4, 1, 0.08, 0.16)`.
- Add `getArrowHeadWidth`: `() => getArrowHeadSize(f) * 0.8`.
- `getArrowStemThickness`: `normalize(relLen, 0.4, 1, 0.0125, 0.0625)` clamped
  to `Math.min(thickness, getArrowHeadWidth(f))`.
- Keep `getArrowFillColor`, `getArrowAngle`, `getArrowRadius` unchanged.
- Pass `getHeadWidth: getArrowHeadWidth` to `buildDeckGLLayerWithSymbology`.
- Set `getLineWidth: 0` (remove the `24` inflation and its comments).
- Keep the `getLineColor` selection toggle (`[0,255,255,255]` selected vs
  `[0,255,255,0]` unselected); it still drives `isSelected` via `vArrowLine.a`.
- No `updateTriggers` change required.

## Risks / watch items

- **`project.devicePixelRatio`**: the factory runs deck.gl 9.3.7; the sandbox
  runs `^9.3.2`. Confirm the `project` uniform block exposes `devicePixelRatio`.
  If the shader fails to compile, fall back to the sandbox's existing
  `dFdx`-only `pixelSize` (drop the `vPixelRatio` multiply) and note the change.
- **`unitPosition`**: requires `getLineWidth: 0` on every call site, otherwise
  arrows scale with the inflated quad. Verify no other caller passes a non-zero
  width.
- **No typecheck script / `tsconfig.json`** in the sandbox and `eslint` only
  scans `js,jsx`; `.ts` correctness is only exercised by the Vite build.
- Selection stroke visibly changes from 6px to 3px; unselected edge goes from a
  50%-opacity black line to a transparent-black soft fade.

## Validation

1. `npm run build` (Vite must compile the new `.ts` + `.shader.ts`).
2. `npm run lint` (js/jsx only — sanity, not TS coverage).
3. `npm run dev` and open the Tabqa_dam map:
   - arrows render inside their point radius at zoom 13 and at zoom ≥ 16 (both
     `radiusUnits` branches);
   - arrow tip does not clip at the quad edge;
   - clicking a feature shows a cyan ~3px stroke matching the selection;
   - unselected arrows show a soft transparent edge, no dark gray ring.

## Out of scope

- No shared `SELECTED_FEATURE_LINE_WIDTH` constants module (optional follow-up if
  other shader layers are ported later).
- No change to `getArrowRadius` sizing or to the glaze/basemap layers.

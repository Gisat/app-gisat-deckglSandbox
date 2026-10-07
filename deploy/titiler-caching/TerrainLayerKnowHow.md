# TerrainLayer Know-How 2 — summary + production comparison

Condensed from `TerrainLayerKnownHow.md`, extended with the three live demos
in `app-gisat-deckglSandbox` and a production comparison table.

## The core problem (deck.gl issue #10400)

The browser treats elevation tiles as *pictures* and "corrects" their colors —
corrupting elevation data.

- deck.gl's `TerrainLayer` decodes elevation PNGs through loaders.gl's default
  web-worker path: `createImageBitmap` + canvas `drawImage`/`getImageData`.
  That pipeline is **not byte-exact** — on color-managed / wide-gamut displays
  it shifts R/G/B values by ±1.
- Terrarium packs height as `(R × 256) + G + (B / 256) − 32768`. The Red
  scaler is **256 m per unit**, so a ±1 R shift = ±256 m spikes — the
  "needles" scattered across the mesh.
- **No TerrainLayer prop avoids this.** `loadOptions: {image:{type:'data'}}`
  is a no-op: `@loaders.gl/terrain` already forces it internally, but the
  browser path still routes through `createImageBitmap`.

## The fix: custom loader via the `loaders` prop

Replace the default `TerrainWorkerLoader` with a pure-JS loader:

```js
new TerrainLayer({
    elevationData: tileUrl,
    elevationDecoder: ELEVATION_DECODER,
    loaders: [TerrariumLoader],   // ← replaces the default TerrainWorkerLoader
})
```

- `worker: false` → main thread, no `createImageBitmap`, no canvas round-trip.
- `parse()` decodes raw PNG bytes with UPNG (pure JS, zero color management,
  byte-exact) and builds the martini mesh, returning the exact
  `@loaders.gl/terrain` output shape (`header`, `indices`, `attributes`,
  `mode: 4`) — TerrainLayer renders it unaware anything changed.
- The Terrarium decode itself still comes from `elevationDecoder`; the loader
  only guarantees unmodified bytes reach it.
- Trade-off: mesh tessellation runs on the main thread (fine for a demo).

**Fundamental rule:** any elevation-as-image format needs a bypass of the
browser image pipeline to be byte-exact. The custom loader (or raw
binary / quantized-mesh tiles) is the fix — changing the encoder format is not.

## Production directions (order of preference)

1. **Skip image formats entirely** — quantized-mesh (server pre-tessellated)
   or raw binary data tiles. Anything the browser never treats as a "picture"
   is immune to #10400.
2. **Keep Terrarium, move the custom loader into a worker** — the bug comes
   from `createImageBitmap`/canvas, not workers. A bundled loaders.gl worker
   (own `workerUrl`, self-hosted — not the loaders.gl CDN default) doing
   UPNG + martini off-thread keeps byte-exact decode *and* frame rate.
   Swap UPNG for `fast-png`/WASM if profiling demands.
3. **Hygiene regardless of path:** pin the CLAMP/ENCODER_CLAMP contract
   (shared config or `/healthz` assertion); watch #10400 upstream; cache at
   nginx with `Content-Encoding` and immutable headers.

### Quantized-mesh (Cesium format) status in deck.gl

- Supported **via loaders.gl** (`QuantizedMeshLoader`, `@loaders.gl/terrain`
  ≥ 2.2), passed through the same `loaders` prop — **not** a first-class
  TerrainLayer mode (PR deck.gl#5061 stayed WIP, never merged).
- Working production-ish recipe in discussion visgl/deck.gl#7494; gotchas:
  `getModelMatrix` from `tile.index`; skirt height from
  `quantizedMesh.skirtHeight`; TMS sources need
  `quantizedMesh.bounds: [0, 1, 1, 0]`; tiles are geometry-only, so texturing
  needs a separate raster source.
- Server side: generate `.terrain` tiles with tin-terrain, ctod, or Cesium
  terrain builder from the COG.

## The three live demos (app-gisat-deckglSandbox)

| | `/titiler-demo-misicuni-terrain` | `/titiler-demo-terrarium-terrain` | `/titiler-demo-float32-terrain` |
| --- | --- | --- | --- |
| Tile producer | TiTiler PNG render | `terrarium-encoder` (sibling, direct rasterio COG reads) | `float32-encoder` (sibling, direct rasterio COG reads) |
| Wire format | grayscale PNG (R=G=B) | Terrarium RGB PNG | headerless little-endian float32 (`'<f4'`, 262,144 B/tile) |
| Loader | default TerrainWorkerLoader | custom `TerrariumLoader` (UPNG, `worker:false`) | custom `Float32Loader` (`new Float32Array(buffer)`) |
| Precision | ~8-bit (≈256 levels, coarse steps) | 24-bit, sub-metre | full float32 (source precision) |
| Needles (#10400) | hidden (±1 shift ≈ ±2 m, below visibility) | fixed by pure-JS decode | immune by construction |
| Client decode cost | none (browser pipeline) | UPNG inflate + pack decode | none (typed-array view) |
| Server↔client coupling | rescale params in URL | CLAMP must match on both sides | none |
| Tessellation | loaders.gl worker | main thread | main thread |

## Production solutions vs the demos

| Solution | Format | Precision | Needle-safe | Client CPU | Server work | Integration effort | Interop | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Grayscale via TiTiler (as misicuni demo) | 8-bit PNG | ~256 levels — terraced | effectively (±1 ≈ ±2 m) | low | none (stock TiTiler) | none | any raster-dem client | only when coarse precision is acceptable |
| Terrarium + default loader | RGB PNG | 24-bit | ❌ needles | low | encoder service | low | Mapzen/MapLibre ecosystem | broken on color-managed displays — avoid |
| Terrarium + pure-JS loader (as terrarium demo) | RGB PNG | 24-bit | ✅ | high (main-thread decode + tessellation) | encoder service | done | Mapzen/MapLibre ecosystem | demo-grade; janks at high tile counts |
| Terrarium + pure-JS loader **in a worker** | RGB PNG | 24-bit | ✅ | medium (off-thread) | encoder service | worker bundling + self-hosted workerUrl | Mapzen/MapLibre ecosystem | pragmatic middle ground if Terrarium interop matters |
| Raw float32 tiles (as float32 demo) | raw binary + gzip | full float32 | ✅ by construction | medium (main-thread tessellation; trivial decode) | encoder service (simpler: no packing, no CLAMP) | done | deck.gl-only | best simple option; production = move tessellation to a worker |
| Raw float32 + worker tessellation | raw binary + gzip | full float32 | ✅ | low–medium | same encoder | worker bundling | deck.gl-only | **recommended production path short of quantized-mesh** |
| Quantized-mesh (Cesium `.terrain`) | pre-tessellated mesh | full | ✅ (no image, no client tessellation) | lowest | tile generation pipeline (tin-terrain / ctod / Cesium builder) | highest (#7494 recipe, geometry-only texturing) | Cesium ecosystem | **the ceiling — best for real product scale** |

**Bottom line:** the float32 demo is already the right production architecture
minus worker-hosted tessellation; add that and it is the recommended path.
Quantized-mesh remains the ceiling when tile counts / client CPU budgets
demand server-side tessellation. Terrarium earns its keep only when other
Terrarium consumers (MapLibre raster-dem, Tangram) must share the tiles.

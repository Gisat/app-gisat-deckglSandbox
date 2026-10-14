# Tileserver-RS RGBA COG rendering — implementation plan (TilerserverRGBA-IP)

**Date:** 2026-10-14
**Status:** patch applied locally on `tileserver-rs` branch `feat/identity-raster-cache` (this sandbox cannot compile Rust — the gate runs on the Docker host)
**Scope:** make tileserver-rs render the 4-band RGBA Manila COG exactly like the TiTiler demo, and make the demo verifiable end-to-end.

## 1. Problem

`/tileserver-manila-rgb` renders an empty map: every tile the app requests
decodes to a **fully transparent PNG**, while the TiTiler demo of the SAME COG
(`/titiler-demo-manila`) works.

Measured (pure-python PNG decode of served tiles):

| tile | tileserver-rs (`:8080`) | TiTiler (`:8001`) |
|---|---|---|
| 9/428/234 (in footprint) | nonblack 41.97 %, **opaque 0.00 %** | nonblack 41.97 %, opaque 41.98 % |
| 14/13700/7492 (base level, in footprint) | nonblack 100 %, **opaque 0 %** | — |
| 8/214/118 (outside footprint) | 1909 B all-zero RGBA | — |

The COG (`Manila_S2_Composite_2020022_Mercator_RGB_COG_DEFLATE.tif`, 499 MB):
4 × uint8, `colorinterp = [red, green, blue, alpha]`, `nodata_type = Alpha`,
whole-raster valid fraction **4.71 %** — the S2 scene footprint covers only a
small part of the rectangular grid (that is why the alpha band exists).

## 2. Root cause (code level)

`crates/tileserver-rs/src/sources/cog.rs::render_tile_from_dataset`:

1. It creates the MEM destination with `band_count.min(4)` **f64** bands and
   **no color interpretation**.
2. `gdal::raster::reproject` → C `GDALReprojectImage`, which maps only
   `min(src_bands, dst_bands)` bands 1:1 **after excluding detected alpha
   bands** (gdalwarper.cpp, v3.10.0):

   ```cpp
   int nSrcBands = GDALGetRasterCount(hSrcDS);
   { if (last src band == GCI_AlphaBand) { nSrcAlphaBand = n; nSrcBands--; } }
   int nDstBands = GDALGetRasterCount(hDstDS);
   { if (last dst band == GCI_AlphaBand) { nDstAlphaBand = n; nDstBands--; } }
   GDALWarpInitDefaultBandMapping(psWOptions, std::min(nSrcBands, nDstBands));
   ```

   Manila: src band 4 **is** `AlphaBand` → excluded; dst band 4 is **not
   marked** → kept in the count. Mapping = min(3, 4) = **3 bands (RGB→RGB)** —
   destination band 4 is never written and stays at the MEM init value **0**.
   The PNG then carries alpha = 0 everywhere → invisible tiles.
3. Even marking the destination alpha would not be enough on an f64 band: the
   warp kernel writes destination alpha as **density (0..1)** for non-Byte
   bands; the subsequent `read_as::<u8>` collapses 1.0 → 1.

## 3. Why a blanket "force alpha = 255" is wrong

95.3 % of the Manila COG lies outside the scene footprint. Forcing alpha 255
on every pixel paints out-of-footprint areas as **opaque black squares** over
the basemap at low zoom — the same "black tiles" failure that retired the STAC
demo. TiTiler (rio-tiler) keeps those pixels transparent via the alpha band /
mask. The fix must derive alpha from **source validity**, not blanket opacity.

## 4. Fix design — `gdalwarp -dstalpha` semantics on the MEM destination

| source bands | MEM destination | alpha |
|---|---|---|
| 1 + colormap | 1 × f64 (unchanged) | colormap LUT (unchanged) |
| 1, no colormap | 1 × u8 | forced 255 (unchanged) |
| 2 | 2 × u8 | forced 255 (legacy layout, documented) |
| **≥ 3** | **4 × u8, band 4 marked `GCI_AlphaBand` before the warp** | **maintained by the warp kernel**: 255 where the source contributed valid pixels, 0 outside the footprint, blended at edges |

Mechanics:

- Marking the destination's last band `GCI_AlphaBand` makes
  `GDALReprojectImage` exclude it from the 1:1 mapping and hand it to the warp
  kernel, which writes it from per-pixel density — exactly what
  `gdalwarp -dstalpha` does.
- A source alpha band (Manila band 4) is consumed as source density; sources
  without alpha get density 1.0 for every read pixel; nodata-masked source
  pixels are skipped, leaving destination alpha 0.
- The non-colormap MEM destination switches **f64 → u8** so the kernel writes
  byte-range alpha (0–255); RGB band writes become type-native. For
  int16/float32 multi-band sources the effective behavior is unchanged (GDAL
  saturating cast, same as the previous f64→u8 read).
- Behavior change (improvement): 3-band RGB sources previously got blanket
  alpha 255; they now get warper-maintained alpha (255 where valid,
  transparent over nodata) — rio-tiler/TiTiler parity.

No `config.toml` change: tileserver-rs has **no config knob** for band/alpha
handling (`SourceConfig` exposes no `bidx`/`nodata`/alpha fields) — the
`manila-rgb` block stays exactly as committed.

## 5. Code changes — `crates/tileserver-rs/src/sources/cog.rs`

(branch `feat/identity-raster-cache`, on top of the identity-cache commit `407fe8c`)

1. Import `ColorInterpretation`.
2. Layout branch: `rgb_with_alpha = !use_colormap && band_count >= 3` → 4-band
   destination; 1/2-band keep legacy layouts; MEM type u8 for all non-colormap
   paths.
3. Before `reproject`: mark destination band 4 `AlphaBand` (with a full
   explanatory comment, so the GDAL band-mapping subtlety is not "fixed" away
   later).
4. Read-side match: `1 =>` gray+opaque (unchanged), `2 =>` opaque (new),
   `4 =>` no forcing (alpha is real); the old `3 =>` blanket-opaque arm is
   superseded.
5. Doc comment on `render_tile_from_dataset` describing the band-layout
   contract.
6. Three unit tests (below).

## 6. Unit tests (added in `mod tests`)

| test | asserts |
|---|---|
| `render_rgba_cog_tile_keeps_source_alpha` | 4-band GTiff, alpha 0 left half / 255 right half → left pixel `(0,0,0,0)`, right `(10,20,30,255)` |
| `render_rgb_cog_tile_is_opaque` | 3-band GTiff → `(10,20,30,255)` (warper-maintained alpha, no src alpha band) |
| `render_out_of_footprint_tile_is_transparent` | non-overlapping bbox → whole tile `(0,0,0,0)` — NOT opaque black |

Gate (Docker host / any cargo host):

```sh
cargo test -p tileserver-rs --lib --features raster
```

## 7. Host CLI sequence

```sh
# 1. patch (committed locally on feat/identity-raster-cache)
cd <DynamicServerSideTiles>/tileserver-rs
git switch feat/identity-raster-cache
git log --oneline -2          # alpha fix on top of 407fe8c

# 2. THE GATE — unit tests incl. the 3 new alpha tests
cargo test -p tileserver-rs --lib --features raster

# 3. rebuild the demo image (code changed → rebuild, not just restart)
cd ../app-gisat-deckglSandbox
docker compose -f deploy/tileserver/docker-compose.yml up -d --build

# 4. cold-cache verification — restart clears the RAM-only moka cache
docker compose -f deploy/tileserver/docker-compose.yml restart
./deploy/tileserver/verify.sh
```

## 8. verify.sh adjustments (same commit as this plan)

- **Cache-timing check:** timing tile is now a z14 in-footprint tile the
  default app view never loads (`14/13700/7493`); verdict
  `T1 > 0.02 && T2 < T1*0.5 && T2 < 0.1`. Decisive **only right after
  `docker compose restart`** — the observed FAIL (`req1=0.0009 s`) was a warm
  moka entry (the tile had been fetched by the app/probe before), not a
  missing cache patch. The header documents the cold protocol.
- **Out-of-bounds check:** COG sources return **200 + an all-transparent
  PNG** outside the footprint (the warp writes nothing); 404 was
  STAC/registry-specific behavior. The check now asserts `200 image/png` and
  warns otherwise.

## 9. Acceptance criteria (after rebuild)

| check | expectation |
|---|---|
| `9/428/234` | opaque ≈ 42 % (TiTiler: 41.98 %; bilinear edge blending ±few %), nonblack ≈ 42 % |
| `14/13700/7492` | opaque 100 %, nonblack 100 % |
| `8/214/118` (outside footprint) | still fully transparent |
| `6/53/29` (app probe, overview path) | PNG with partial imagery — also validates that GTiff overview bands carry `AlphaBand` colorinterp |
| app `/tileserver-manila-rgb` | visible Luzon imagery, comparable to `/titiler-demo-manila` at the same view |

## 10. Risks / open questions

- **Overview colorinterp:** if internal overviews did not carry `AlphaBand`,
  low-zoom tiles would render opaque-black outside the footprint (src alpha
  undetected → density 1 wherever RGB is read). GTiff overviews normally
  inherit band colorinterp, and the `6/53/29` acceptance tile covers this
  empirically. Fallback if it fails: inspect overview band colorinterp on the
  host (`gdalinfo`), then decide (e.g. treat src band 4 as alpha whenever
  `band_count == 4`, regardless of colorinterp).
- **2-band sources** remain best-effort (legacy R,G layout, forced opaque).
- The warp resampling is hardcoded `GRA_Bilinear` inside the gdal crate's
  `reproject` (the config `resampling` only affects the 1:1 read, which is a
  no-op) — pre-existing, out of scope here.

## 11. Rollback

```sh
cd <DynamicServerSideTiles>/tileserver-rs
git revert <alpha-fix-commit>
cd ../app-gisat-deckglSandbox
docker compose -f deploy/tileserver/docker-compose.yml up -d --build
```
